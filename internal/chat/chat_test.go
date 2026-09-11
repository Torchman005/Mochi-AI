package chat

import (
	"strings"
	"testing"
	"time"

	"github.com/yuyu-mind/backend/internal/config"
)

func TestExtractJSONObject(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"plain", `{"action":"reply"}`, `{"action":"reply"}`},
		{"markdown-fence", "```json\n{\"action\":\"reply\"}\n```", `{"action":"reply"}`},
		{"surrounding-text", "text before {\"action\":\"task\",\"task\":{}} text after", `{"action":"task","task":{}}`},
	}
	for _, c := range cases {
		if got := extractJSONObject(c.in); got != c.want {
			t.Fatalf("%s: extractJSONObject(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}

func TestPostprocessReply(t *testing.T) {	in := "（思考中）\n你好，世界。\n(这是舞台指示)\n"
	got := postprocessReply(in)
	if strings.Contains(got, "舞台指示") || strings.Contains(got, "思考中") {
		t.Fatalf("stage directions not removed: %q", got)
	}
	if !strings.Contains(got, "你好，世界。") {
		t.Fatalf("content lost: %q", got)
	}
}

func TestSplitReply(t *testing.T) {
	parts := splitReply("你好。世界。", 3)
	if len(parts) != 2 {
		t.Fatalf("expected 2 parts, got %d: %v", len(parts), parts)
	}
	if joined := strings.Join(parts, ""); joined != "你好。世界。" {
		t.Fatalf("split+join = %q", joined)
	}
}

func TestLooksLikeQuestionOrRequest(t *testing.T) {
	if !looksLikeQuestionOrRequest("你能帮我吗？") {
		t.Fatalf("expected question marker")
	}
	if !looksLikeQuestionOrRequest("怎么配置模型") {
		t.Fatalf("expected request marker")
	}
	if looksLikeQuestionOrRequest("好的") {
		t.Fatalf("expected not a question")
	}
}

func TestEmotionNormalization(t *testing.T) {
	if NormalizeEmotion("happy") != "happy" {
		t.Fatalf("valid emotion changed")
	}
	if NormalizeEmotion("bogus") != EmotionNeutral {
		t.Fatalf("invalid emotion should fall back to neutral")
	}
	if NormalizeMood("cheer") != "cheer" {
		t.Fatalf("valid mood changed")
	}
	if NormalizeMood("") != MoodCalm {
		t.Fatalf("empty mood should fall back to calm")
	}
	if ClampEnergy(1.5) != 1 || ClampEnergy(-0.5) != 0 || ClampEnergy(0.4) != 0.4 {
		t.Fatalf("energy clamping incorrect")
	}
	if ClampValence(1.5) != 1 || ClampValence(-1.5) != -1 || ClampValence(0.4) != 0.4 {
		t.Fatalf("valence clamping incorrect")
	}
	if ClampDominance(2) != 1 || ClampDominance(-2) != -1 || ClampDominance(-0.3) != -0.3 {
		t.Fatalf("dominance clamping incorrect")
	}
}

func TestPlannerDecisionEmotionInfo(t *testing.T) {
	d := PlannerDecision{Emotion: "happy", Mood: "cheer", Energy: 0.8, Valence: 0.6, Dominance: 0.2, Gesture: "bounce", Hand: "left"}
	info := d.EmotionInfo()
	if info.Emotion != "happy" || info.Mood != "cheer" || info.Energy != 0.8 || info.Valence != 0.6 || info.Dominance != 0.2 || info.Gesture != "bounce" || info.Hand != "left" {
		t.Fatalf("EmotionInfo mismatch: %+v", info)
	}
}

func TestParsePlannerDecision(t *testing.T) {
	d, err := parsePlannerDecision(`{"action":"reply","emotion":"happy","mood":"cheer","energy":0.9,"valence":0.8,"dominance":0.3}`)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if d.Action != "reply" || d.Emotion != "happy" || d.Mood != "cheer" || d.Energy != 0.9 || d.Valence != 0.8 || d.Dominance != 0.3 {
		t.Fatalf("unexpected decision: %+v", d)
	}

	// 围栏包裹 + 非法情绪归一化。
	d, err = parsePlannerDecision("```json\n{\"action\":\"task\",\"emotion\":\"bogus\",\"energy\":2,\"valence\":3,\"dominance\":-2}\n```")
	if err != nil {
		t.Fatalf("parse fenced: %v", err)
	}
	if d.Emotion != EmotionNeutral || d.Energy != 1 || d.Valence != 1 || d.Dominance != -1 {
		t.Fatalf("normalization failed: %+v", d)
	}

	// 空 action 不应报错（由 Plan 兜底为 reply）。
	d, err = parsePlannerDecision(`{"reason":"no action"}`)
	if err != nil {
		t.Fatalf("parse empty action: %v", err)
	}
	if d.Action != "" {
		t.Fatalf("expected empty action, got %q", d.Action)
	}

	// 非法 JSON 报错。
	if _, err := parsePlannerDecision("not json"); err == nil {
		t.Fatalf("expected error for invalid JSON")
	}
}

func TestTurnGateEvaluate(t *testing.T) {
	gate := NewTurnGate(config.ChatConfig{ReplyThreshold: 0.45, ReplyFrequency: 1})
	now := time.Now()
	snapshot := TurnSnapshot{
		Target: NormalizedMessage{ID: "m1", Content: "你能帮我写个文件吗？", CreatedAt: now},
		Now:    now,
	}
	decision := gate.Evaluate(snapshot)
	if !decision.ShouldPlan {
		t.Fatalf("expected ShouldPlan for question, got score=%f threshold=%f", decision.Score, decision.Threshold)
	}

	weak := gate.Evaluate(TurnSnapshot{
		Target:    NormalizedMessage{ID: "m2", Content: "好的", CreatedAt: now},
		LastBotAt: now,
		BotStreak: 2,
		Now:       now,
	})
	if weak.ShouldPlan {
		t.Fatalf("expected weak backchannel to be gated, got score=%f", weak.Score)
	}

	// 普通陈述句（非弱回撤）即使紧接着上一条 bot 回复、且已有连续回复 streak，也应得到回复。
	statement := gate.Evaluate(TurnSnapshot{
		Target:    NormalizedMessage{ID: "m3", Content: "今天好累啊", CreatedAt: now},
		LastBotAt: now,
		BotStreak: 3,
		Now:       now,
	})
	if !statement.ShouldPlan {
		t.Fatalf("expected statement to get reply, got score=%f", statement.Score)
	}
}

func TestParsePlannerDecisionWindowsPath(t *testing.T) {
	// 模型常把 Windows 路径原样写进 JSON（含 \i \A 等非法转义），应被修正后仍能解析。
	raw := `{"action":"task","task":{"goal":"init react","workspace":"D:\itJinYu_toolkit\AI-pet"}}`
	decision, err := parsePlannerDecision(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if decision.Action != "task" || decision.Task == nil || decision.Task.Goal != "init react" {
		t.Fatalf("unexpected decision: %+v", decision)
	}
	if decision.Task.Workspace != "D:\\itJinYu_toolkit\\AI-pet" {
		t.Fatalf("workspace not fixed: %q", decision.Task.Workspace)
	}
}

// TestFormatEmotionDirective 覆盖「把 Planner 情绪传给 Replyer」这一纯函数的边界。
// 该指令是台词与表情对齐的唯一通道，若在重构中静默失效，回复会重新变得"情绪与内容无关"。
func TestFormatEmotionDirective(t *testing.T) {
	// 无情绪 → 不注入（避免 prompt 里出现空的 performance_directive 行）。
	if got := formatEmotionDirective(PlannerDecision{}); got != "" {
		t.Fatalf("空情绪不应注入指令，得到 %q", got)
	}

	// 仅情绪 + 基调。
	got := formatEmotionDirective(PlannerDecision{Emotion: EmotionHappy, Mood: MoodCheer})
	if !strings.Contains(got, `"happy"`) || !strings.Contains(got, `"cheer"`) {
		t.Fatalf("指令应包含情绪与基调：%q", got)
	}
	if !strings.HasPrefix(got, "\n") {
		t.Fatalf("指令应以换行开头以便拼接：%q", got)
	}
	if !strings.Contains(got, "用词与语气要与该情绪一致") {
		t.Fatalf("指令应要求台词与情绪一致：%q", got)
	}

	// 连续维度 → 自然语言提示（积极 + 激动 + 自信）。
	got = formatEmotionDirective(PlannerDecision{
		Emotion: EmotionHappy, Valence: 0.8, Energy: 0.9, Dominance: 0.7,
	})
	for _, want := range []string{"偏积极", "情绪激动", "自信主导"} {
		if !strings.Contains(got, want) {
			t.Fatalf("高唤醒正向情绪缺少提示 %q：%q", want, got)
		}
	}

	// 消极 + 平静 + 顺从。
	got = formatEmotionDirective(PlannerDecision{
		Emotion: EmotionSad, Valence: -0.9, Energy: 0.1, Dominance: -0.8,
	})
	for _, want := range []string{"偏消极", "语气平静", "顺从害羞"} {
		if !strings.Contains(got, want) {
			t.Fatalf("低唤醒负向情绪缺少提示 %q：%q", want, got)
		}
	}

	// 中性区间不应误加提示（|valence|<0.35 且 energy 在 (0.3,0.7) 之间）。
	got = formatEmotionDirective(PlannerDecision{
		Emotion: EmotionNeutral, Valence: 0.1, Energy: 0.5, Dominance: 0.1,
	})
	for _, unwanted := range []string{"偏积极", "偏消极", "情绪激动", "语气平静", "自信主导", "顺从害羞"} {
		if strings.Contains(got, unwanted) {
			t.Fatalf("中性情绪不应出现提示 %q：%q", unwanted, got)
		}
	}

	// 情绪字符串两侧空白应被忽略，且不再产生空指令。
	if got := formatEmotionDirective(PlannerDecision{Emotion: "  "}); got != "" {
		t.Fatalf("仅空白情绪不应注入指令，得到 %q", got)
	}
}
