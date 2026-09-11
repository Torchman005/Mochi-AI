# Yuyu Mind

Yuyu Mind 是一个基于 Wails + Go + Eino 的 AI 桌面应用后端原型。当前重点是搭建可扩展的 Agent 架构：顶层 Agent 负责用户交互、长期记忆和任务编排，底层 Worker Agent 负责异步执行具体任务。

## 技术栈

- 后端：Go
- AI 编排：CloudWeGo Eino
- 桌面应用：Wails
- 存储：SQLite

## 核心架构

### 顶层 Agent / Worker Agent

系统采用分层 Agent 架构：

- 顶层 Agent 是唯一直接接触用户的层。
- 顶层 Agent 负责理解用户意图、读取和更新用户记忆、处理用户偏好、拆解任务、生成任务包。
- 底层 Worker Agent 不直接访问用户长期记忆，也不直接询问用户。
- Worker 只执行顶层下发的结构化任务包。
- Worker 遇到缺信息、错误或需要审批时，通过事件和控制消息回到顶层 Agent。

任务包示例：

```json
{
  "goal": "给当前目录添加一个新文件",
  "instructions": "创建 notes.md，内容使用中文说明项目架构。",
  "workspace": "C:\\Users\\jingyu\\Desktop\\Yuyu-Mind-dev",
  "constraints": ["不要修改无关文件", "代码注释使用中文"],
  "context": {
    "preferences": {
      "code.comment_language": "zh-CN"
    }
  },
  "allowed_actions": ["read_file", "write_file", "run_tests"]
}
```

### 异步任务系统

异步任务系统位于 `internal/agent`，持久化结构位于 `internal/db`。

当前设计：

- SQLite 保存任务事实、事件、控制消息和操作日志。
- Go `context.Context` 负责运行中任务取消和超时传播。
- goroutine 负责异步执行。
- wakeup channel 负责提交任务、补充输入、任务完成后的即时调度。
- worker slot 控制并发数量。
- running map 保存 `taskID -> cancelFunc`，支持快速取消运行中任务。

任务状态：

```text
queued
running
waiting_for_input
waiting_for_approval
completed
failed
cancelled
```

关键行为：

- `SubmitTask` 写入 queued 任务并唤醒调度器。
- 调度器使用 `ClaimNextQueued` 从数据库原子认领任务，避免重复执行。
- Worker 需要用户补充信息时，写入 question event，将任务状态设为 `waiting_for_input`，然后退出释放 worker slot。
- 顶层 Agent 或用户通过 `AnswerTaskQuestion` 写入 input control，任务重新进入 queued。
- `CancelTask` 对运行中任务调用 cancel；对 queued/waiting 任务直接落库为 cancelled。

相关文件：

- `internal/agent/service.go`
- `internal/agent/runtime.go`
- `internal/agent/executor.go`
- `internal/agent/types.go`
- `internal/db/agent_task_repo.go`
- `internal/db/agent_event_repo.go`
- `internal/db/migrations/005_create_agent_tasks.sql`

### Memory Gateway

长期记忆架构位于 `internal/memory/long_term.go`，数据库仓储位于 `internal/db/memory_repo.go`。

原则：

- 只有顶层 Agent 读写长期记忆。
- Worker 不直接访问用户记忆。
- 顶层 Agent 通过 Memory Gateway 把相关记忆投影成任务上下文。
- 每次任务上下文投影都会保存快照，便于审计 Worker 当时知道了什么。

记忆类型：

```text
preference  用户偏好
fact        用户事实
project     项目约定
instruction 长期指令
episode     历史事件摘要
```

数据表：

- `user_memories`：长期记忆
- `memory_events`：记忆审计事件
- `memory_candidates`：候选记忆
- `conversation_summaries`：会话摘要
- `task_context_snapshots`：任务上下文快照

关键接口：

- `UpsertMemory`
- `SearchMemories`
- `ArchiveMemory`
- `AddMemoryCandidate`
- `PromoteMemoryCandidate`
- `RejectMemoryCandidate`
- `UpsertConversationSummary`
- `BuildTaskContext`

`BuildTaskContext` 的投影策略：

- 稳定偏好、项目约定、长期指令默认进入任务上下文。
- 用户事实和历史事件按任务 query 做相关检索。
- 当前明确指令优先级高于长期偏好。

### Token 用量追踪

Token 用量追踪用于记录每次模型请求的消耗，方便用户查询成本和使用情况。

当前实现：

- 从 Eino `ResponseMeta.Usage` 提取 token usage。
- 记录 prompt tokens、completion tokens、total tokens、模型调用次数、耗时和状态。
- 支持按会话、全局、provider/model 维度查询。

相关文件：

- `internal/usage/collector.go`
- `internal/usage/tracked_model.go`
- `internal/db/token_usage_repo.go`
- `internal/db/migrations/004_create_token_usage.sql`

## 主要模块

```text
main.go                         Wails 应用入口
app.go                          Wails 绑定包装
internal/app/                   Wails 生命周期与前端可调用方法
internal/agent/                 异步任务调度、Worker Runtime、Executor 接口
internal/ai/                    Eino Provider、Tools、Callback
internal/chat/                  聊天服务编排
internal/config/                本地配置管理
internal/db/                    SQLite 仓储和迁移
internal/memory/                会话短期记忆与长期 Memory Gateway
internal/usage/                 Token 用量追踪
pkg/types/                      公共类型
configs/                        配置示例
frontend/                       Wails 前端占位
```

## 当前进度

已完成：

- 基础项目结构
- 配置加载、保存、Provider 切换
- SQLite 会话、消息、设置仓储
- OpenAI 兼容 Provider、Ollama Provider
- Chat Service（Planner/Replyer 两段式 + TurnGate）
- Wails 后端绑定
- Token 用量追踪
- 异步任务系统（Submit/Claim/Run/Cancel/审批/补答）
- Memory Gateway 与任务上下文投影快照
- 情绪管线（LLM 结构化情绪 → Live2D 表演参数 → 持久化）
- 插件系统（进程内接口 + 生命周期 + 权限 + 动作 + 配置持久化 + 前端面板 + system/workspace 内置插件 + 子进程 sidecar + 目录即插即用，示例插件：hello / code-assistant(Codex 写代码实时评审) / netease-music(搜歌点歌出声)）
- Web Search 真实实现（DuckDuckGo，免 Key）
- 电脑工具（工作区隔离 + 文件读写/列目录 + 命令执行 + 键鼠输入 + 屏幕截图 + Worker 审批流）
- Worker 真实执行器（LLM 工具循环）
- 任务闭环（Planner 识别任务 → 提交 → 执行 → 事件回传前端任务面板）
- 情绪系统 v2（连续 VAD + FACS/AU 表情合成 + Live2D 参数注册表）
- 语音识别（浏览器 Web Speech ASR 默认可用 + 模型 Whisper 兼容 ASR：`asr.model` 配置后经 `/audio/transcriptions` 转录）
- 单元测试覆盖 agent/ai-asr/ai-tools/chat/config/db/memory/plugin/usage/vision（12 包全绿）

仍需处理：

- `frontend/dist` 需本地 `npm run build` 生成（见下方「快速开始」）。
- 多模态视觉（让 LLM 描述截图）：需接入支持图片的模型与适配器。
- JS 脚本插件（可选，阶段 3）。

## 快速开始（本地构建与运行）

> 桌宠前端依赖 Wails 的 `window.go` 运行时，**必须通过 `wails dev` 或打包后的 exe 运行**，单独 `npm run dev` 会因缺少运行时白屏。

前置：Go 1.23+（**必须 64 位**，即 `go env GOARCH` 输出 `amd64`）、Node.js 18+、Wails v2 CLI。

**一键启动（推荐，双击即可）**：

```
start-all.bat            # 自动判断并启动 GPT-SoVITS/SenseVoice + 构建前端 + wails dev
stop-all.bat             # 一键停止
```

> `start-all.bat` 内部调用 `start-all.ps1`（可用 `start-all.bat -SkipBuild` 跳过前端构建）。二者读取 `configs/config.json` 判断要启动哪些服务，路径等见 `services` 段。

手动方式：

```powershell
# 0) 确认 Go 是 64 位（sonic 等依赖不支持 32 位，会报 overflows int）
go env GOARCH    # 必须是 amd64

# 1) 构建前端（生成 frontend/dist，供 Go 嵌入）
cd frontend
npm install
npm run build
cd ..

# 2) 启动开发模式（自动注入 window.go）
wails dev
```

常见问题：

- 若 `go build` 报 `sonic ... overflows int`：构建目标是 32 位，`go env GOARCH` 应为 `amd64`，别用 `-platform windows/386`。
- 若报 `pattern all:frontend/dist: no matching files`：先执行第 1 步的 `npm run build`。
- 配置与数据库默认在 `%APPDATA%\Yuyu-Mind\`；可用环境变量 `YUYU_CONFIG_DIR` 覆盖配置目录。
- **语音识别（ASR）**：默认用浏览器 Web Speech 识别（开箱即用）。若要改用模型识别，在 `config.json` 设置 `"asr": {"model": "whisper-1"}`（用当前激活 Provider 的 BaseURL/APIKey 调 `/audio/transcriptions`），并把前端构建环境变量 `VITE_ASR_PROVIDER` 设为 `model`（默认 `browser`）。

## 开发命令

```bash
go mod tidy
go test ./...
make dev
make build
```

测试（全绿）：

```bash
go test ./internal/...
```

## 架构约束

- 顶层 Agent 负责用户交互和长期记忆。
- Worker 只能消费任务包，不直接读取用户长期记忆。
- Worker 需要信息时提交事件，由顶层 Agent 决定是否询问用户。
- 所有任务状态、控制消息、事件和操作日志都要持久化。
- `context.Context` 只负责运行中取消和超时传播，不作为长期任务状态存储。
- 任务上下文必须可审计，派发给 Worker 的记忆投影需要保存快照。
