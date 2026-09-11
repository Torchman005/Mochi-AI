package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// TestApplyFromCoversAllFields 用反射保证 ApplyFrom 覆盖了 Config 的**全部
// 带 json 标签的业务字段**（mu / filePath 除外）。
//
// 为什么需要：ApplyJSON 不能整体复制 Config（含 sync.RWMutex，go vet copylocks），
// 只能逐字段装配；一旦将来新增字段却忘记补进 ApplyFrom，该字段就会被**静默丢弃**
// （表现为"配置改了不生效"），这类 bug 不会报错、极难排查。
func TestApplyFromCoversAllFields(t *testing.T) {
	src := DefaultConfig()

	// 从零值开始逐字段拷贝，再与 src 全字段比对：漏拷的字段会是零值 → 被检出。
	// 注意用 &Config{} 而非结构体赋值，避免 copylocks（Config 含 sync.RWMutex）。
	dst := &Config{}
	dst.ApplyFrom(src)

	rt := reflect.TypeOf(Config{})
	sv := reflect.ValueOf(src).Elem()
	dv := reflect.ValueOf(dst).Elem()

	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i)
		if field.Name == "mu" || field.Name == "filePath" {
			continue // 非业务字段，不应被拷贝
		}
		if !reflect.DeepEqual(sv.Field(i).Interface(), dv.Field(i).Interface()) {
			t.Fatalf("ApplyFrom 漏拷字段 %s：src=%+v dst=%+v（该字段会被静默丢弃）",
				field.Name, sv.Field(i).Interface(), dv.Field(i).Interface())
		}
	}
}

// TestApplyJSONPreservesFileFieldsAndParses 验证 ApplyJSON 正确应用 JSON 且保留 filePath。
func TestApplyJSONPreservesFileFieldsAndParses(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("YUYU_CONFIG_DIR", dir)

	cfg := DefaultConfig()
	path := filepath.Join(dir, "config.json")
	cfg.SetFilePath(path)

	if err := cfg.ApplyJSON([]byte(`{"chat":{"persona":"新的设定"}}`)); err != nil {
		t.Fatalf("ApplyJSON: %v", err)
	}
	if cfg.Chat.Persona != "新的设定" {
		t.Fatalf("persona 未被应用: %q", cfg.Chat.Persona)
	}
	// 未在 JSON 中出现的字段必须保留（JSON 覆盖是"部分覆盖"语义）。
	if cfg.Chat.SplitMaxChars != DefaultConfig().Chat.SplitMaxChars {
		t.Fatalf("未覆盖字段被清零: split_max_chars=%d", cfg.Chat.SplitMaxChars)
	}
	if cfg.LogLevel == "" {
		t.Fatalf("未覆盖字段 LogLevel 被清零")
	}
	// filePath 必须保留，否则后续保存会写到错误位置。
	if cfg.filePath != path {
		t.Fatalf("filePath 未保留: got %q want %q", cfg.filePath, path)
	}
	// 落盘应包含新设定（证明 ApplyJSON 的 saveLocked 走到了正确路径）。
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read saved config: %v", err)
	}
	if !strings.Contains(string(saved), "新的设定") {
		t.Fatalf("落盘内容缺少新设定: %s", string(saved))
	}
}

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.ActiveProvider.ProviderID != "deepseek" {
		t.Fatalf("default active provider = %q", cfg.ActiveProvider.ProviderID)
	}
	if cfg.Providers["deepseek"].BaseURL == "" || cfg.Providers["deepseek"].Model == "" {
		t.Fatalf("deepseek provider incomplete: %+v", cfg.Providers["deepseek"])
	}
	if _, ok := cfg.Providers["bailian"]; !ok {
		t.Fatalf("bailian provider missing")
	}
	if cfg.Chat.MaxReplyChars <= 0 || cfg.Chat.SplitMaxChars <= 0 {
		t.Fatalf("chat split config invalid")
	}
	// 反应停顿默认应为开启且区间合法（min<=max）。
	if cfg.Chat.ThinkingPauseMinMs <= 0 || cfg.Chat.ThinkingPauseMaxMs < cfg.Chat.ThinkingPauseMinMs {
		t.Fatalf("thinking pause default invalid: min=%d max=%d",
			cfg.Chat.ThinkingPauseMinMs, cfg.Chat.ThinkingPauseMaxMs)
	}
}

func TestSetAndGetActiveProvider(t *testing.T) {
	cfg := DefaultConfig()
	if err := cfg.SetActiveProvider("deepseek", "deepseek-chat"); err != nil {
		t.Fatalf("SetActiveProvider: %v", err)
	}
	p, err := cfg.GetActiveProviderConfig()
	if err != nil {
		t.Fatalf("GetActiveProviderConfig: %v", err)
	}
	if p.Model != "deepseek-chat" || p.BaseURL == "" {
		t.Fatalf("active provider = %+v", p)
	}

	if err := cfg.SetActiveProvider("ghost", "m"); err == nil {
		t.Fatalf("expected error for unknown provider")
	}
}

func TestUpdateProvider(t *testing.T) {
	cfg := DefaultConfig()
	if err := cfg.UpdateProvider("openai", Provider{Name: "自定义", BaseURL: "http://x/v1", APIKey: "k", Model: "m"}); err != nil {
		t.Fatalf("UpdateProvider: %v", err)
	}
	if cfg.Providers["openai"].Name != "自定义" || cfg.Providers["openai"].APIKey != "k" {
		t.Fatalf("update provider failed: %+v", cfg.Providers["openai"])
	}
}

func TestLoadSaveRoundTrip(t *testing.T) {
	t.Setenv("YUYU_CONFIG_DIR", t.TempDir())

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ActiveProvider.ProviderID != "deepseek" {
		t.Fatalf("default active provider = %q", cfg.ActiveProvider.ProviderID)
	}

	if err := cfg.SetActiveProvider("bailian", "qwen-plus"); err != nil {
		t.Fatalf("SetActiveProvider: %v", err)
	}
	if err := cfg.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	cfg2, err := Load()
	if err != nil {
		t.Fatalf("Load again: %v", err)
	}
	if cfg2.ActiveProvider.ProviderID != "bailian" || cfg2.ActiveProvider.Model != "qwen-plus" {
		t.Fatalf("round-trip failed: %+v", cfg2.ActiveProvider)
	}
}
