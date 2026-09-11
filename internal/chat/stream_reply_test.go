package chat

import (
	"bytes"
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"testing"
	"time"
)

func collectSentences(chunks []string, maxRunes int) []string {
	s := newStreamingSentencer(maxRunes)
	var parts []string
	for _, chunk := range chunks {
		parts = append(parts, s.feed(chunk)...)
	}
	parts = append(parts, s.flush()...)
	return parts
}

func TestStreamingSentencer(t *testing.T) {
	// 逐句按标点切分，跨 chunk 也能正确合并。
	got := collectSentences([]string{"你好", "。今天天气怎么", "样？还不错！"}, 90)
	want := []string{"你好。", "今天天气怎么样？", "还不错！"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sentence split mismatch:\n got=%v\nwant=%v", got, want)
	}

	// 无标点超长句强制按 maxRunes 切分。
	got = collectSentences([]string{"这是一句没有标点而且非常长的句子需要被强制切分"}, 8)
	if len(got) == 0 {
		t.Fatalf("expected forced split parts, got empty")
	}
	for _, part := range got {
		if len([]rune(part)) > 8 {
			t.Fatalf("part exceeds maxRunes: %q (%d runes)", part, len([]rune(part)))
		}
	}
	joined := ""
	for _, part := range got {
		joined += part
	}
	if joined != "这是一句没有标点而且非常长的句子需要被强制切分" {
		t.Fatalf("forced split lost content: %q", joined)
	}

	// 空输入 flush 不产出空串。
	if got := collectSentences([]string{""}, 90); len(got) != 0 {
		t.Fatalf("expected no parts for empty input, got %v", got)
	}

	// 仅强句界（。！？.!?\n）切分：整句作为一个 chunk 交给 GPT-SoVITS（配合 text_split_method=cut1 朗读更稳），
	// 避免应用侧把「主人」「那里」等过短片段单独下发而被打成哼声。
	got = collectSentences([]string{"主人就是您呀~要不，我为您泡杯温热的花茶？"}, 90)
	want = []string{"主人就是您呀~要不，我为您泡杯温热的花茶？"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("full-sentence split mismatch:\n got=%v\nwant=%v", got, want)
	}

	// 含逗号的整句作为一个 chunk（不按逗号切分），交由 GPT-SoVITS 朗读。
	got = collectSentences([]string{"这一声主人，早就在心里念过千遍了。"}, 90)
	want = []string{"这一声主人，早就在心里念过千遍了。"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("comma-in-sentence split mismatch:\n got=%v\nwant=%v", got, want)
	}
}

func TestRefineSentenceEmotion(t *testing.T) {	cases := []struct {
		part         string
		last         string
		want         string
	}{
		{"太好了，谢谢！", "neutral", EmotionHappy},   // 明显正面 → 下发
		{"普通的一句话", "happy", ""},               // 中性且与 last 无关 → 不下发（保持）
		{"有点难过呢", "neutral", EmotionSad},      // 明显负面 → 下发
		{"开心", "happy", ""},                    // 与 last 相同 → 不下发（避免重复）
		{"惊讶", "neutral", EmotionSurprised},    // 惊讶 → 下发
	}
	for _, c := range cases {
		if got := refineSentenceEmotion(c.part, c.last); got != c.want {
			t.Fatalf("refineSentenceEmotion(%q, %q) = %q, want %q", c.part, c.last, got, c.want)
		}
	}
}

// TestThinkingPause 覆盖「反应停顿」的边界语义：关闭、区间、非法区间归一化、随机数越界。
// 这是防止该特性静默失效（配了但不生效）的关键回归。
func TestThinkingPause(t *testing.T) {
	cases := []struct {
		name       string
		minMs      int
		maxMs      int
		r          float64
		wantMillis int
	}{
		{"both disabled", 0, 0, 0.5, 0},
		{"negative disabled", -10, -5, 0.5, 0},
		{"fixed value at r=0", 300, 300, 0, 300},
		{"lower bound of range", 250, 900, 0, 250},
		{"upper bound接近", 250, 900, 0.999, 899},
		{"midpoint", 200, 400, 0.5, 300},
		{"invalid range normalised", 400, 100, 0.5, 400},
		{"r out of range clamped", 300, 300, 5.7, 300},
		{"negative r clamped", 300, 300, -1, 300},
		{"only max set", 0, 500, 0.5, 250},
	}
	for _, c := range cases {
		got := ThinkingPause(c.minMs, c.maxMs, c.r)
		if int(got/time.Millisecond) != c.wantMillis {
			t.Fatalf("%s: ThinkingPause(%d,%d,%.3f) = %dms, want %dms",
				c.name, c.minMs, c.maxMs, c.r, got/time.Millisecond, c.wantMillis)
		}
	}

	// 区间内的取值必须落在 [min, max) 且随 r 单调不减。
	for _, r := range []float64{0, 0.25, 0.5, 0.75, 0.99} {
		got := ThinkingPause(250, 900, r)
		if got < 250*time.Millisecond || got >= 900*time.Millisecond {
			t.Fatalf("r=%.2f produced %v outside [250ms,900ms)", r, got)
		}
	}
}

// TestWaitThinkingPauseCancelled 验证打断（ctx 取消）时停顿立即返回，不会阻塞。
func TestWaitThinkingPauseCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	start := time.Now()
	waitThinkingPause(ctx, 5*time.Second)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("cancelled ctx should return immediately, took %v", elapsed)
	}

	// 零停顿不产生等待。
	zeroStart := time.Now()
	waitThinkingPause(context.Background(), 0)
	if elapsed := time.Since(zeroStart); elapsed > 50*time.Millisecond {
		t.Fatalf("zero pause should not wait, took %v", elapsed)
	}
}

// TestStreamReplyAppliesThinkingPause 用 AST 校验 streamReply 的**两条产出路径**
// （结构化 dialog 与 flat-text 回退）都接入了 applyThinkingPause。
//
// 为什么需要这个测试：本项目已出现过「配置项存在但全仓库无消费点」的静默失效
// （AllowTypoSimulation），而停顿逻辑若在后续重构中从某条路径被移除，单测不会报错、
// 线上也只会表现为"有时候没停顿"，极难发现。这里用 AST 而非字符串匹配，
// 以免被注释/重命名干扰。
func TestStreamReplyAppliesThinkingPause(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "stream_reply.go", nil, 0)
	if err != nil {
		t.Fatalf("parse stream_reply.go: %v", err)
	}

	// 收集 streamReply 内所有被调用的标识符名，以及各闭包体内的调用；
	// 我们关心的是 flushPart / flushDialogItem 这两个下发片段的闭包里是否调用了 applyThinkingPause。
	wantCallers := map[string]bool{"flushPart": false, "flushDialogItem": false}
	var currentFunc string

	ast.Inspect(file, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.AssignStmt:
			// pause := ... / applyThinkingPause := func() {...}
			if len(node.Lhs) == 1 && len(node.Rhs) == 1 {
				if ident, ok := node.Lhs[0].(*ast.Ident); ok {
					if _, isFunc := node.Rhs[0].(*ast.FuncLit); isFunc {
						currentFunc = ident.Name
					}
				}
			}
		case *ast.CallExpr:
			if ident, ok := node.Fun.(*ast.Ident); ok && ident.Name == "applyThinkingPause" {
				if _, tracked := wantCallers[currentFunc]; tracked {
					wantCallers[currentFunc] = true
				}
			}
		}
		return true
	})

	for name, found := range wantCallers {
		if !found {
			t.Fatalf("%s 未调用 applyThinkingPause：反应停顿在该路径上会静默失效", name)
		}
	}

	// 同时确认停顿时长确实来自配置（而非硬编码），保证用户可通过 config.json 调整。
	src, readErr := os.ReadFile("stream_reply.go")
	if readErr != nil {
		t.Fatalf("read stream_reply.go: %v", readErr)
	}
	for _, field := range []string{"ThinkingPauseMinMs", "ThinkingPauseMaxMs"} {
		if !bytes.Contains(src, []byte(field)) {
			t.Fatalf("stream_reply.go 未引用配置字段 %s：停顿无法通过配置调整", field)
		}
	}
}
