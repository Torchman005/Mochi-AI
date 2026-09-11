package chat

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/yuyu-mind/backend/internal/db"
)

// streamingSentencer 增量地把流式文本切分成完整句子。
// 每遇到句末标点（。！？.!?\n）即产出一个完整句；若单句过长（超过 maxRunes）则强制切分，
// 使 TTS 能「逐句」并行启动，而不是等全文生成完毕。
type streamingSentencer struct {
	buf      strings.Builder
	maxRunes int
}

func newStreamingSentencer(maxRunes int) *streamingSentencer {
	if maxRunes <= 0 {
		maxRunes = 90
	}
	return &streamingSentencer{maxRunes: maxRunes}
}

func (s *streamingSentencer) feed(chunk string) []string {
	s.buf.WriteString(chunk)
	return s.drain(false)
}

func (s *streamingSentencer) flush() []string {
	return s.drain(true)
}

func (s *streamingSentencer) drain(force bool) []string {
	text := s.buf.String()
	parts := make([]string, 0, 2)

	for {
		runes := []rune(text)
		// 跳过前导空白。
		start := 0
		for start < len(runes) && (runes[start] == ' ' || runes[start] == '\t' || runes[start] == '\r' || runes[start] == '\n') {
			start++
		}
		if start >= len(runes) {
			text = ""
			break
		}
		runes = runes[start:]
		text = string(runes)

		cut := -1
		for i, r := range runes {
			if isSentenceBoundary(r) {
				cut = i + 1
				break
			}
		}
		if cut < 0 && len(runes) > s.maxRunes {
			cut = s.maxRunes
		}
		if cut < 0 {
			break
		}
		parts = append(parts, trimSentencePart(string(runes[:cut])))
		text = string(runes[cut:])
	}

	if force && strings.TrimSpace(text) != "" {
		parts = append(parts, trimSentencePart(text))
		text = ""
	}

	s.buf.Reset()
	s.buf.WriteString(text)
	return parts
}

// trimSentencePart 与 isSentenceBoundary / splitReply 等同属回复文本纯函数，见 reply_text.go。

// refineSentenceEmotion 返回某句应下发的离散情绪：内容带明显情绪、与上次不同且非中性时才返回，
// 否则返回空串（表示维持现状）。用于「表情随台词走」的逐句微调，避免频繁闪烁。
func refineSentenceEmotion(part, lastEmotion string) string {
	inferred := InferEmotionFromText(part)
	if inferred == "" || inferred == lastEmotion || inferred == EmotionNeutral {
		return ""
	}
	return inferred
}

// ThinkingPause 计算「首句之前的反应停顿」时长（毫秒）。
//
// 设计意图：真人听到问题后存在自然的思考间隙（约 0.3–1.2s），而零延迟会造成
// "终端回显"式的机器感。将停顿限制在**首句之前**，后续句子保持流式节奏，
// 从而既有人味又不牺牲"边说边生成"的流水线收益。
//
// 语义：
//   - minMs/maxMs 均 ≤ 0 → 返回 0（不启用，行为与旧版一致）
//   - maxMs < minMs → 归一化为与 minMs 相等（避免非法区间产生随机负值）
//   - r 传入 [0,1) 的随机数；越界会被夹到 [0,1)
func ThinkingPause(minMs, maxMs int, r float64) time.Duration {
	if minMs <= 0 && maxMs <= 0 {
		return 0
	}
	if minMs < 0 {
		minMs = 0
	}
	if maxMs < minMs {
		maxMs = minMs
	}
	if r < 0 {
		r = 0
	}
	if r >= 1 {
		// 把越界随机数折回 [0,1)，保持行为可预期。
		r = r - float64(int(r))
	}
	span := maxMs - minMs
	ms := minMs
	if span > 0 {
		ms += int(float64(span) * r)
	}
	return time.Duration(ms) * time.Millisecond
}

// waitThinkingPause 在首句之前等待一段思考停顿；ctx 取消（用户打断）时立即返回，
// 避免打断后仍被延迟阻塞。
func waitThinkingPause(ctx context.Context, pause time.Duration) {
	if pause <= 0 {
		return
	}
	timer := time.NewTimer(pause)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

// streamReply 流式生成回复：边生成边按完整句子 emit + 持久化，降低「首句」延迟。
func (s *Service) streamReply(
	ctx context.Context,
	replyer *ReplyerAgent,
	snapshot TurnSnapshot,
	decision PlannerDecision,
	memories []string,
	toolResults []ToolResult,
	emitter Emitter,
	rt *ConversationRuntime,
) ([]string, error) {
	reader, err := replyer.Stream(ctx, snapshot, decision, memories, toolResults)
	if err != nil {
		return nil, fmt.Errorf("replyer stream: %w", err)
	}
	defer reader.Close()

	sentencer := newStreamingSentencer(replyer.cfg.SplitMaxChars)
	now := time.Now()
	parts := make([]string, 0, 8)
	totalRunes := 0
	lastEmotion := decision.Emotion

	// 反应停顿：只在首个片段下发之前等待一次（结构化 dialog 与 flat-text 回退共用）。
	// 使用 Once 保证无论哪条路径先产出内容，停顿都只发生一次。
	var pauseOnce sync.Once
	applyThinkingPause := func() {
		pauseOnce.Do(func() {
			pause := ThinkingPause(
				replyer.cfg.ThinkingPauseMinMs,
				replyer.cfg.ThinkingPauseMaxMs,
				rand.Float64(),
			)
			if pause > 0 {
				slog.Info("[tts] thinking pause", "pause_ms", pause.Milliseconds())
			}
			waitThinkingPause(ctx, pause)
		})
	}

	flushPart := func(part string) error {
		applyThinkingPause()
		if replyer.cfg.MaxReplyChars > 0 && totalRunes+len([]rune(part)) > replyer.cfg.MaxReplyChars {
			// 超过回复长度上限：优雅截断（不抛错、不中断整轮），保留已产出的句子。
			return errReplyTooLong
		}
		totalRunes += len([]rune(part))
		parts = append(parts, part)
		slog.Info("[tts] stream token", "part", part, "runes", len([]rune(part)), "total_runes", totalRunes)
		if emitter != nil {
			// 逐句情绪微调（flat-text 回退路径）：某句内容带明显情绪时，在下发该句前更新离散表情。
			if refined := refineSentenceEmotion(part, lastEmotion); refined != "" {
				lastEmotion = refined
				emitter.Emit(ChatEvent{
					Type:      EventTypeEmotion,
					Emotion:   refined,
					Mood:      decision.Mood,
					Energy:    decision.Energy,
					Valence:   decision.Valence,
					Dominance: decision.Dominance,
					Gesture:   decision.Gesture,
					Hand:      decision.Hand,
				})
			}
			emitter.Emit(ChatEvent{Type: EventTypeToken, Content: part})
		}
		return s.db.Messages.Create(ctx, &db.Message{
			ID:             uuid.New().String(),
			ConversationID: snapshot.Target.ConversationID,
			Role:           "assistant",
			Content:        part,
			SourceKind:     "guided_reply",
			Emotion:        decision.Emotion,
			Mood:           decision.Mood,
			Energy:         decision.Energy,
			Valence:        decision.Valence,
			Dominance:      decision.Dominance,
			Gesture:        decision.Gesture,
			Hand:           decision.Hand,
			CreatedAt:      now,
		})
	}

	emitSentences := func(sentences []string) error {
		for _, sentence := range sentences {
			part := postprocessReply(sentence)
			if part == "" {
				continue
			}
			if err := flushPart(part); err != nil {
				return err
			}
		}
		return nil
	}

	// flushDialogItem 处理结构化回复中模型给出的「一句台词 + 该句情绪/动作」。
	// 每句前下发其自带情绪，使 Live2D 表情随台词走（对齐 Shinsekai）。
	// 台词经 postprocessReply 去掉可能残留的动作/心理描写（如「（笑）」「心想…」）。
	flushDialogItem := func(item DialogItem) error {
		speech := postprocessReply(item.Speech)
		if speech == "" {
			return nil
		}
		applyThinkingPause()
		if replyer.cfg.MaxReplyChars > 0 && totalRunes+len([]rune(speech)) > replyer.cfg.MaxReplyChars {
			return errReplyTooLong
		}
		totalRunes += len([]rune(speech))
		parts = append(parts, speech)
		slog.Info("[tts] stream dialog", "speech", speech, "emotion", item.Emotion, "runes", len([]rune(speech)))
		if emitter != nil {
			emitter.Emit(ChatEvent{
				Type:      EventTypeEmotion,
				Emotion:   item.Emotion,
				Mood:      item.Mood,
				Energy:    item.Energy,
				Valence:   item.Valence,
				Dominance: item.Dominance,
				Gesture:   item.Gesture,
				Hand:      item.Hand,
			})
			emitter.Emit(ChatEvent{Type: EventTypeToken, Content: speech})
		}
		return s.db.Messages.Create(ctx, &db.Message{
			ID:             uuid.New().String(),
			ConversationID: snapshot.Target.ConversationID,
			Role:           "assistant",
			Content:        speech,
			SourceKind:     "guided_reply",
			Emotion:        item.Emotion,
			Mood:           item.Mood,
			Energy:         item.Energy,
			Valence:        item.Valence,
			Dominance:      item.Dominance,
			Gesture:        item.Gesture,
			Hand:           item.Hand,
			CreatedAt:      now,
		})
	}

	parser := newDialogStreamParser()
	stopped := false
	for {
		chunk, recvErr := reader.Recv()
		if recvErr != nil && recvErr != io.EOF {
			return nil, fmt.Errorf("replyer stream recv: %w", recvErr)
		}
		if recvErr == io.EOF {
			break
		}
		if chunk == nil {
			continue
		}
		for _, item := range parser.feed(chunk.Content) {
			if err := flushDialogItem(item); err != nil {
				if errors.Is(err, errReplyTooLong) {
					stopped = true
					break
				}
				return nil, err
			}
		}
		if stopped {
			break
		}
	}

	// 结构化输出未解析出任何台词（模型直接给了 flat text，或 JSON 不规范）→ 回退到按句切分。
	if !stopped && parser.yieldedItems == 0 {
		raw := strings.TrimSpace(parser.accumulated)
		if raw != "" {
			if err := emitSentences(sentencer.feed(raw)); err != nil && !errors.Is(err, errReplyTooLong) {
				return nil, err
			}
			if err := emitSentences(sentencer.flush()); err != nil && !errors.Is(err, errReplyTooLong) {
				return nil, err
			}
		}
	}

	if len(parts) == 0 {
		return nil, fmt.Errorf("replyer produced empty reply")
	}
	rt.CompleteReply(parts, now)
	return parts, nil
}

// errReplyTooLong 表示回复达到长度上限需优雅截断（非致命错误）。
var errReplyTooLong = errors.New("reply length limit reached")
