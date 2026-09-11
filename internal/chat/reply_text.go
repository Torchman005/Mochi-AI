package chat

import (
	"regexp"
	"strings"
)

// 本文件集中放置「回复文本后处理」的纯函数：清洗模型输出、按句切分、长度截断。
// 它们同时被流式回复路径（stream_reply.go）与测试使用，因此独立于任何 Service 类型。
//
// 历史上这些函数与 SendService.SendGuidedReply 放在一起；该同步发送路径已被
// streamReply（边生成边 emit + 持久化）取代并不再被调用，故一并移除，
// 仅保留这些仍被复用的纯函数。

var stageLinePattern = regexp.MustCompile(`(?m)^\s*[\(（\[\[【][^\n]{0,80}[\)）\]\]】]\s*$`)
var leadingStagePattern = regexp.MustCompile(`^\s*[\(（\[\[【][^\n]{0,40}[\)）\]\]】]\s*`)
// inlineStagePattern 去掉行内动作/心理描写，如「主人（笑）我在这」→「主人我在这」。
var inlineStagePattern = regexp.MustCompile(`[\(（\[\[【][^\)）\]】]{1,20}[\)）\]】]`)

// postprocessReply 清洗模型输出：去掉行内/整行/行首的舞台指示（动作、心理、神态描写），
// 规整换行与空白。这是「只输出说出来的话」这一约束的最后一道保障。
func postprocessReply(raw string) string {
	text := strings.TrimSpace(raw)
	text = inlineStagePattern.ReplaceAllString(text, "")
	text = stageLinePattern.ReplaceAllString(text, "")
	text = leadingStagePattern.ReplaceAllString(text, "")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.FieldsFunc(text, func(r rune) bool {
		return r == '\n' || r == '\r'
	})
	for i, line := range lines {
		lines[i] = strings.TrimSpace(line)
	}
	text = strings.Join(nonEmpty(lines), "\n")
	return strings.TrimSpace(text)
}

// splitReply 按句子边界把长回复切成多条短消息；无标点时按 maxRunes 强制切分。
func splitReply(text string, maxRunes int) []string {
	if maxRunes <= 0 || len([]rune(text)) <= maxRunes {
		return []string{text}
	}

	var parts []string
	var current strings.Builder
	currentRunes := 0
	for _, r := range text {
		current.WriteRune(r)
		currentRunes++
		if isSentenceBoundary(r) || currentRunes >= maxRunes {
			part := trimSentencePart(current.String())
			if part != "" {
				parts = append(parts, part)
			}
			current.Reset()
			currentRunes = 0
		}
	}
	if rest := trimSentencePart(current.String()); rest != "" {
		parts = append(parts, rest)
	}
	return parts
}

func isSentenceBoundary(r rune) bool {
	switch r {
	case '。', '！', '？', '.', '!', '?', '\n':
		return true
	default:
		return false
	}
}

// trimSentencePart 去掉片段末尾的逗号类字符，避免 GPT-SoVITS 对「带尾随逗号的短片段」过度切分而哼声
// （如「这一声主人，」会被哼成轻哼；去掉尾随逗号成「这一声主人」则能正常读出）。
func trimSentencePart(part string) string {
	return strings.TrimRight(strings.TrimSpace(part), "，、；,;")
}

// nonEmpty 去掉空白项并 trim 每项。
func nonEmpty(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, strings.TrimSpace(value))
		}
	}
	return result
}
