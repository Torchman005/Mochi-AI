package chat

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/google/uuid"
	"github.com/yuyu-mind/backend/internal/agent"
	"github.com/yuyu-mind/backend/internal/config"
	"github.com/yuyu-mind/backend/internal/db"
	"github.com/yuyu-mind/backend/internal/memory"
	"github.com/yuyu-mind/backend/internal/usage"
	pkgTypes "github.com/yuyu-mind/backend/pkg/types"

	aiProvider "github.com/yuyu-mind/backend/internal/ai/provider"
)

type Emitter interface {
	Emit(event ChatEvent)
}

// TaskSubmitter 提交异步任务。由宿主实现（通常是 agent.Service 的适配器）。
type TaskSubmitter interface {
	SubmitTask(ctx context.Context, spec agent.TaskSpec) (*db.AgentTask, error)
}

type Service struct {
	cfg         *config.Config
	db          *db.DB
	providerReg *aiProvider.Registry
	toolReg     interface{ GetAll() []tool.BaseTool }
	shortMemory memory.Store
	longMemory  *memory.ServiceMemory
	runtimes    *RuntimeManager
	taskSubmit  TaskSubmitter
}

// SetTaskSubmitter 注入异步任务提交器（可选；未注入时 "task" 动作不可用）。
func (s *Service) SetTaskSubmitter(submitter TaskSubmitter) {
	s.taskSubmit = submitter
}

func NewService(
	cfg *config.Config,
	database *db.DB,
	providerReg *aiProvider.Registry,
	toolReg interface{ GetAll() []tool.BaseTool },
	memStore memory.Store,
	longMemory *memory.ServiceMemory,
) *Service {
	return &Service{
		cfg:         cfg,
		db:          database,
		providerReg: providerReg,
		toolReg:     toolReg,
		shortMemory: memStore,
		longMemory:  longMemory,
		runtimes:    NewRuntimeManager(memStore),
	}
}

func (s *Service) StreamChat(ctx context.Context, req ChatRequest, emitter Emitter) error {
	startedAt := time.Now()

	msg, err := s.normalizeRequest(req)
	if err != nil {
		emitError(emitter, err)
		return err
	}

	rt := s.runtimes.Get(msg.SessionID)
	snapshot, accepted, err := rt.Ingest(ctx, msg)
	if err != nil {
		emitError(emitter, fmt.Errorf("ingest message: %w", err))
		return fmt.Errorf("ingest message: %w", err)
	}
	if !accepted {
		emitDone(emitter)
		return nil
	}

	if err := s.persistInboundMessage(ctx, msg); err != nil {
		emitError(emitter, err)
		return err
	}

	gate := NewTurnGate(s.cfg.Chat).Evaluate(snapshot)
	if !gate.ShouldPlan {
		rt.CompleteNoReply()
		slog.Debug("turn gate kept message pending",
			"conversation_id", msg.ConversationID,
			"score", gate.Score,
			"threshold", gate.Threshold,
			"reasons", strings.Join(gate.Reasons, ","),
		)
		emitDone(emitter)
		return nil
	}

	collector := usage.NewCollector()
	trackedModel, providerID, modelName, err := s.createTrackedModel(ctx, collector)
	if err != nil {
		emitError(emitter, err)
		s.persistTokenUsage(ctx, msg.ConversationID, providerID, modelName, "orchestrated", collector, time.Since(startedAt), "failed", err)
		return err
	}

	rt.MarkRunning()

	// 简单闲聊走「快速通道」：跳过 Planner 这一整轮 LLM 决策，直接流式回复，
	// 把「首字延迟」从 Planner(全文 JSON) + Replyer(首字) 压缩到只剩 Replyer(首字)。
	// 复杂意图（记忆/工具/任务/追问）仍走 Planner 完整决策。
	var decision PlannerDecision
	if shouldSkipPlanner(snapshot.Target.Content) {
		decision = PlannerDecision{
			Action:  "reply",
			Emotion: InferEmotionFromText(snapshot.Target.Content),
			Mood:    MoodCalm,
		}
		s.persistTokenUsage(ctx, msg.ConversationID, providerID, modelName, "planner_skipped", collector, time.Since(startedAt), "success", nil)
	} else {
		planner := NewPlannerAgent(trackedModel, s.cfg.Chat)
		var err error
		decision, err = planner.Plan(ctx, snapshot, gate, s.toolReg.GetAll())
		if err != nil {
			rt.CompleteNoReply()
			emitError(emitter, err)
			s.persistTokenUsage(ctx, msg.ConversationID, providerID, modelName, "planner", collector, time.Since(startedAt), "failed", err)
			return err
		}
		// 便于在「桌宠日志」页排查：模型看到了哪些工具、它最终怎么决策。
		slog.Debug("planner decision",
			slog.Any("action", decision.Action),
			slog.Any("reason", decision.Reason),
			slog.Any("tool_calls", decision.ToolCalls),
			slog.Any("available_tools", toolNames(s.toolReg.GetAll())),
		)
	}

	// 情绪在流式文本之前发出，前端据此在「逐句朗读」开始前就驱动表情。
	if emitter != nil {
		emitter.Emit(ChatEvent{
			Type:      EventTypeEmotion,
			Emotion:   decision.Emotion,
			Mood:      decision.Mood,
			Energy:    decision.Energy,
			Valence:   decision.Valence,
			Dominance: decision.Dominance,
			Gesture:   decision.Gesture,
			Hand:      decision.Hand,
		})
	}

	memories, toolResults, err := s.preparePlannerContext(ctx, snapshot, decision, emitter)
	if err != nil {
		rt.CompleteNoReply()
		emitError(emitter, err)
		s.persistTokenUsage(ctx, msg.ConversationID, providerID, modelName, "planner", collector, time.Since(startedAt), "failed", err)
		return err
	}

	switch decision.Action {
	case "wait":
		rt.CompleteNoReply()
		s.persistTokenUsage(ctx, msg.ConversationID, providerID, modelName, "planner_wait", collector, time.Since(startedAt), "success", nil)
		emitDone(emitter)
		return nil
	case "reply", "query_memory", "tool", "task":
		// query_memory and tool are planning steps; the visible answer still
		// comes exclusively from the Replyer.
	default:
		err := fmt.Errorf("planner returned unsupported action %q", decision.Action)
		rt.CompleteNoReply()
		emitError(emitter, err)
		s.persistTokenUsage(ctx, msg.ConversationID, providerID, modelName, "planner", collector, time.Since(startedAt), "failed", err)
		return err
	}

	// "task"：提交后台异步任务，并让 Replyer 生成确认语。
	if decision.Action == "task" {
		if decision.Task == nil {
			err := fmt.Errorf("planner returned task action without task payload")
			rt.CompleteNoReply()
			emitError(emitter, err)
			return err
		}
		if s.taskSubmit == nil {
			err := fmt.Errorf("task submitter is not configured")
			rt.CompleteNoReply()
			emitError(emitter, err)
			return err
		}
		submitted, err := s.taskSubmit.SubmitTask(ctx, decision.Task.ToTaskSpec(msg.ConversationID))
		if err != nil {
			rt.CompleteNoReply()
			emitError(emitter, err)
			s.persistTokenUsage(ctx, msg.ConversationID, providerID, modelName, "submit_task", collector, time.Since(startedAt), "failed", err)
			return err
		}
		decision.ReplyInstructions = fmt.Sprintf("告知用户已收到任务「%s」并在后台开始执行，稍后会汇报结果。", submitted.Title)
	}

	replyer := NewReplyerAgent(trackedModel, s.cfg.Chat)
	// 流式回复：边生成边按完整句子 emit（EventTypeToken）+ 持久化，
	// 使前端能「逐句」驱动 TTS 并行播放，而非等全文生成完毕（对齐 Shinsekai 的低延迟体验）。
	if _, err := s.streamReply(ctx, replyer, snapshot, decision, memories, toolResults, emitter, rt); err != nil {
		rt.CompleteNoReply()
		emitError(emitter, err)
		s.persistTokenUsage(ctx, msg.ConversationID, providerID, modelName, "replyer", collector, time.Since(startedAt), "failed", err)
		return err
	}

	s.persistTokenUsage(ctx, msg.ConversationID, providerID, modelName, "orchestrated", collector, time.Since(startedAt), "success", nil)
	emitDone(emitter)
	return nil
}

func (s *Service) normalizeRequest(req ChatRequest) (NormalizedMessage, error) {
	content := strings.TrimSpace(req.Content)
	if content == "" {
		return NormalizedMessage{}, fmt.Errorf("message content is empty")
	}
	conversationID := strings.TrimSpace(req.ConversationID)
	if conversationID == "" {
		return NormalizedMessage{}, fmt.Errorf("conversation_id is required")
	}
	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" {
		sessionID = conversationID
	}
	messageID := strings.TrimSpace(req.MessageID)
	if messageID == "" {
		messageID = uuid.New().String()
	}
	senderID := strings.TrimSpace(req.SenderID)
	if senderID == "" {
		senderID = "user"
	}
	sourceKind := strings.TrimSpace(req.SourceKind)
	if sourceKind == "" {
		sourceKind = "inbound_user"
	}
	mentioned := req.Mentioned
	if botName := strings.TrimSpace(s.cfg.Chat.BotName); botName != "" {
		mentioned = mentioned || strings.Contains(strings.ToLower(content), strings.ToLower(botName))
	}

	return NormalizedMessage{
		ID:             messageID,
		SessionID:      sessionID,
		ConversationID: conversationID,
		SenderID:       senderID,
		SenderName:     req.SenderName,
		Content:        content,
		Mentioned:      mentioned,
		SourceKind:     sourceKind,
		CreatedAt:      time.Now(),
	}, nil
}

func (s *Service) persistInboundMessage(ctx context.Context, msg NormalizedMessage) error {
	if err := s.db.Messages.Create(ctx, &db.Message{
		ID:             msg.ID,
		ConversationID: msg.ConversationID,
		Role:           "user",
		Content:        msg.Content,
		SourceKind:     msg.SourceKind,
		CreatedAt:      msg.CreatedAt,
	}); err != nil {
		return fmt.Errorf("persist inbound message: %w", err)
	}
	return nil
}

func (s *Service) createTrackedModel(ctx context.Context, collector *usage.Collector) (*usage.TrackedChatModel, string, string, error) {
	providerCfg, err := s.cfg.GetActiveProviderConfig()
	if err != nil {
		return nil, "", "", fmt.Errorf("get provider config: %w", err)
	}
	providerID := s.cfg.ActiveProvider.ProviderID
	modelName := providerCfg.Model
	chatModel, err := s.providerReg.Create(ctx, pkgTypes.ProviderConfig{
		ID:      providerID,
		Name:    providerCfg.Name,
		BaseURL: providerCfg.BaseURL,
		APIKey:  providerCfg.APIKey,
		Model:   modelName,
	})
	if err != nil {
		return nil, providerID, modelName, fmt.Errorf("create model: %w", err)
	}
	return usage.NewTrackedChatModel(chatModel, collector), providerID, modelName, nil
}

func (s *Service) preparePlannerContext(
	ctx context.Context,
	snapshot TurnSnapshot,
	decision PlannerDecision,
	emitter Emitter,
) ([]string, []ToolResult, error) {
	var memories []string
	var err error
	if decision.NeedMemory || decision.Action == "query_memory" {
		memories, err = QueryPlannerMemory(ctx, s.longMemory, snapshot, decision)
		if err != nil {
			return nil, nil, err
		}
	}

	toolResults, err := ExecutePlannerTools(ctx, s.toolReg.GetAll(), decision.ToolCalls)
	if err != nil {
		return nil, nil, err
	}
	for _, result := range toolResults {
		if emitter != nil {
			emitter.Emit(ChatEvent{Type: EventTypeToolResult, ToolName: result.Name, Content: result.Result})
		}
	}
	return memories, toolResults, nil
}

func emitError(emitter Emitter, err error) {
	if emitter != nil && err != nil {
		emitter.Emit(ChatEvent{Type: EventTypeError, Content: err.Error()})
	}
}

func emitDone(emitter Emitter) {
	if emitter != nil {
		emitter.Emit(ChatEvent{Type: EventTypeDone})
	}
}

func (s *Service) CreateConversation(ctx context.Context, title string) (*db.Conversation, error) {
	providerCfg, _ := s.cfg.GetActiveProviderConfig()
	conv := &db.Conversation{
		ID:        uuid.New().String(),
		Title:     title,
		Provider:  s.cfg.ActiveProvider.ProviderID,
		Model:     providerCfg.Model,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	if err := s.db.Conversations.Create(ctx, conv); err != nil {
		return nil, fmt.Errorf("create conversation: %w", err)
	}
	return conv, nil
}

func (s *Service) ListConversations(ctx context.Context) ([]*db.Conversation, error) {
	return s.db.Conversations.List(ctx)
}

func (s *Service) DeleteConversation(ctx context.Context, id string) error {
	return s.db.Conversations.Delete(ctx, id)
}

func (s *Service) GetMessages(ctx context.Context, convID string) ([]*db.Message, error) {
	return s.db.Messages.ListByConversation(ctx, convID)
}

func (s *Service) ListTokenUsageByConversation(ctx context.Context, convID string) ([]*db.TokenUsageRecord, error) {
	return s.db.TokenUsage.ListByConversation(ctx, convID)
}

func (s *Service) GetTokenUsageSummary(ctx context.Context) (*db.TokenUsageSummary, error) {
	return s.db.TokenUsage.Summary(ctx)
}

func (s *Service) GetTokenUsageSummaryByConversation(ctx context.Context, convID string) (*db.TokenUsageSummary, error) {
	return s.db.TokenUsage.SummaryByConversation(ctx, convID)
}

func (s *Service) GetTokenUsageByProviderModel(ctx context.Context) ([]*db.TokenUsageSummary, error) {
	return s.db.TokenUsage.SummaryByProviderModel(ctx)
}

func (s *Service) persistTokenUsage(
	ctx context.Context,
	conversationID string,
	providerID string,
	modelName string,
	mode string,
	collector *usage.Collector,
	duration time.Duration,
	status string,
	requestErr error,
) {
	if providerID == "" || modelName == "" {
		return
	}
	snapshot := collector.Snapshot()
	record := &db.TokenUsageRecord{
		ID:               uuid.New().String(),
		ConversationID:   conversationID,
		Provider:         providerID,
		Model:            modelName,
		Mode:             mode,
		PromptTokens:     snapshot.PromptTokens,
		CompletionTokens: snapshot.CompletionTokens,
		TotalTokens:      snapshot.TotalTokens,
		ModelCalls:       snapshot.ModelCalls,
		DurationMS:       duration.Milliseconds(),
		Status:           status,
		CreatedAt:        time.Now(),
	}
	if requestErr != nil {
		record.Error = requestErr.Error()
	}
	if err := s.db.TokenUsage.Create(ctx, record); err != nil {
		slog.Warn("failed to persist token usage", "error", err)
	}
}
