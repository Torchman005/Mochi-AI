# 拟人化差距分析（Realism Gap Analysis）

> 目的：解释「Yuyu 为什么不像真人」，并用可核查的实现事实定位根因；同时研究业界标杆（Neuro-sama、MaiMBot）的拟人化手段，产出可执行清单。
>
> 方法论：**区分「有据可查的事实」与「推断」**。带 `[事实]` 前缀的结论均可在本仓库源码中核对（附文件:行号）；带 `[推断]` 的为分析判断。外部资料附来源链接，属未受信内容，仅作参考。

---

## 一、结论速览（TL;DR）

Yuyu 的"不像真人"**主要不是模型能力问题，而是工程约束问题**。当前实现把角色锁死在三个反拟人的系统约束里：

| # | 根因 | 后果 | 证据 |
|---|---|---|---|
| 1 | **必回机制**：每条用户消息基础分 0.60 > 阈值 0.45，恒定越过门控 | 永不"忙自己的事"、永不忽略、永不分心 → 秒回客服感 | `internal/chat/turn_gate.go:45,75` |
| 2 | **零时间节奏**：无打字延迟、无思考停顿、`MinReplyIntervalSeconds=0` | 真人说话有 0.5–3s 自然停顿，此处 0 延迟 → 机器应答 | `internal/config/config.go:161`；`grep AllowTypoSimulation` 无消费点 |
| 3 | **无情绪状态机**：情绪每轮由 Planner 现算，不跨轮记忆、无衰减/惯性 | 上一秒 "sad" 下一秒 "cheer"，情绪不连贯 → 表演感、假 | `internal/chat/emotion.go`（仅白名单+钳制，无状态）；`frontend/src/components/emotionEngine.ts` 无平滑/衰减 |
| 4 | **主动发言是硬编码模板**：`buildProactiveLine` 返回固定句式，不经 LLM | 每次搭话都是"我还记着你刚才说的「…」" → 复读机感 | `internal/app/companion.go:584-599` |
| 5 | **长期记忆只读不写**：`query_memory` 可召回，但对话过程无自动抽取写入 | 用户新说的事实记不住 → 失忆、关系不积累 | `internal/chat/agents.go:304-321`（读）vs `grep AddMemoryCandidate` 仅 Wails 导出（写） |
| 6 | **表达被过度约束**：prompt 硬性 1–2 行；清洗正则删除所有括号内容 | 无冗余、无语气词、无停顿 → 书面化、信息密度过高的"AI 腔" | `internal/chat/agents.go:277`；`internal/chat/send_service.go:79-82` |
| 7 | **快速通道绕过情绪推理**：≤40 字闲聊跳过 Planner | 高频短消息的情绪退化为关键词匹配 → 情绪误判 | `internal/chat/fast_path.go:36`；`internal/chat/emotion.go:135`（关键词兜底） |

**一句话**：Yuyu 现在是「**一个有问必答、情绪现算、话少、不失忆也不记事、从不打字的助手**」，而真人是「**会分心、会沉默、情绪有惯性、说话有冗余和停顿、记得住细节**」。

---

## 二、本项目事实基线（逐项核查）

### 2.1 对话架构：Planner → Replyer 两段式

`[事实]` `internal/chat/agents.go:90-177` 定义 Planner：输出**严格 JSON**，含 `action`（reply/wait/query_memory/tool/task）与情绪字段；`agents.go:259-302` 定义 Replyer：输出 `{"dialog":[{speech,emotion,mood,...}]}`，每行自带表情。

- `[事实]` Planner 的 system prompt 是**英文工程指令**（"Decide behavior only. Do not write visible user-facing reply text."），人格仅作为 `persona:` 一行注入（`agents.go:135-137`）。
- `[事实]` Replyer 被明确要求：`Split into 1-2 short, concise spoken lines; keep the reply brief (say little, don't ramble or pad)`（`agents.go:277`）。
- `[推断]` 「1–2 行 + 不要 ramble」把回复压成高信息密度短句，这与真人闲聊的**低密度、带冗余**特征相反；真人恰恰大量使用语气词、重复、半截话。

### 2.2 必回机制（TurnGate）

`[事实]` `turn_gate.go:37-46`：

```go
if target.Mentioned { score += 0.75 }   // 被点名
score += 0.60                            // private_session：一对一私有桌宠
```

而 `ReplyThreshold` 默认 `0.45`（`config.go:158`）→ **所有直接消息必然 ≥0.60 > 0.45，恒定回复**。
`looksLikeWeakBackchannel` 最多 −0.30（`turn_gate.go:52-56`），无法把 0.60 压到阈值下。

- `[事实]` `MinReplyIntervalSeconds` 默认 `0`（`config.go:161`），冷却逻辑（`turn_gate.go:65-70`）因此**不生效**。
- `[事实]` `AverageMessageIntervalSeconds=8` 仅用于给"空闲间隔"加 0.12 分（`turn_gate.go:61-64`），不产生任何延迟。
- `[推断]` 真人对话中"不回复/晚回复"是强拟人信号（在忙、没听见、不想理）。当前设计把这条信号彻底移除了。

### 2.3 情绪系统：无状态的单轮演出

`[事实]` `emotion.go` 只做**白名单校验 + 数值钳制**（`NormalizeEmotion/Mood/Gesture/Hand`、`ClampEnergy/Valence/Dominance`），**没有任何情绪状态存储、衰减、惯性或跨轮延续**。

- `[事实]` 情绪由 Planner 每轮重新产出（`agents.go:119-127` 要求 "always include these fields"），前端每轮消费一次。
- `[事实]` `frontend/src/components/emotionEngine.ts` 中检索 `decay|smooth|lerp|history|inertia|衰减` **无匹配** → AU 权重是当前输入的纯函数。
- `[事实]` Live2D 层只有模型参数的 `weight` 插值（`Live2DStage.tsx:952-957` 仅在 emotion 变化时 `applyPixiEmotion`），属"帧级平滑"，非"情绪状态延续"。
- `[推断]` 真人情绪是**慢变量**：被冒犯后几分钟都低落、听到好消息后持续雀跃。当前实现让情绪成为"每轮的即时标签"，观众会感到"情绪是演出来的"。

### 2.4 节奏：完全没有"打字/思考"时间

`[事实]` `config.go:164` `AllowTypoSimulation: false`，且**全仓库仅此定义处出现，无任何消费点** —— 这是一个"声明了但从未实现"的配置。

- `[事实]` 检索 `AverageMessageIntervalSeconds|ReplyFrequency|MinReplyIntervalSeconds` 的消费点只有 `turn_gate.go`（打分用），**没有任何地方 sleep/延迟/分条发送**。
- `[事实]` 回复清洗 `postprocessReply`（`send_service.go:84-98`）用 `inlineStagePattern` 删除所有 `（…）` 括注，`stageLinePattern` 删除整行动作描写。
- `[推断]` 结果是回复**过于干净**：没有"呃…""那个""我看看"这类真人填充词，也没有被误删风险的口语插入语。配合零延迟，产生强烈的"终端回显"感。

### 2.5 主动发言：模板而非生成

`[事实]` `internal/app/companion.go:584-599`：

```go
func buildProactiveLine(trigger string, messages []CompanionMessage) string {
    ...
    if last != "" {
        return fmt.Sprintf("我还记着你刚才说的「%s」，要不要继续从这里往下处理？", truncateRunes(last, 28))
    }
    return "我在这边，随时可以继续。"
}
```

- `[事实]` 该函数**不调用任何 LLM**，纯字符串拼接；`embedding`/情绪/时间/桌面活动均未参与。
- `[事实]` 前端有概率与冷却控制（`PROACTIVE_CHANCE_PERCENT`、`App.tsx:399`；`GenerateProactiveMessage` `App.tsx:411`），但**内容侧毫无变化**。
- `[推断]` 于是"主动搭话"变成高概率重复同一句式，比不说话更伤拟人感。

### 2.6 记忆：读得到、写不进

`[事实]` 读路径：`agents.go:304-321` `QueryPlannerMemory` → `SearchMemories(ctx,"","",query,8)`，仅在 `decision.NeedMemory || Action=="query_memory"` 时触发（`service.go:309-310`）。查询串默认取当前用户消息（`agents.go:308-311`）。

- `[事实]` 写路径：`UpsertMemory` / `AddMemoryCandidate` 仅在 `internal/app/app.go:275,290` 作为 **Wails 导出方法**存在，供前端显式调用；**对话主流程内没有任何自动抽取/写入**。
- `[事实]` `memory/window.go` 提供短期滑动窗口；`MemoryConfig.MaxTurns=20`（`config.go:167`）。
- `[推断]` 即"用户说过就会记住"不成立——除非前端另有触发。这解释了跨会话后角色像第一次认识你。

### 2.7 快速通道：情绪退化为关键词

`[事实]` `fast_path.go:36`：非信号词且 ≤40 字 → 跳过 Planner。此时无结构化情绪产出，前端回退 `InferEmotionFromText`（`emotion.go:135-152`，关键词匹配 happy/sad/surprised/thinking）。

- `[推断]` 日常大多数短消息走这条路，情绪判断质量因此由关键词表决定，而非语义。

---

## 三、外部标杆研究

> 来源均为公开资料（未受信内容，仅作设计参考）。分「有据可查的事实」与「推断」。

### 3.1 Neuro-sama 复刻实现：人格特质数值化 + 情感状态 + 认知帧

`[外部事实]` 参考实现 [o9nn/neuro-sama 的 IMPLEMENTATION.md](https://raw.githubusercontent.com/o9nn/neuro-sama/main/Neuro/IMPLEMENTATION.md)（一个把 Neuro 人格实现为 WebSocket 服务的复刻项目，非官方）。其核心是一个 **`cognitive-engine.ts`**，把"性格"变成可计算的数值：

| 机制 | 具体做法 | 对本项目的启发 |
|---|---|---|
| **人格特质向量** | `Playfulness 0.8 / Intelligence 0.9 / Chaotic 0.7 / Empathy 0.6 / Sarcasm 0.75` | 性格不是一句 prompt，而是**参与决策打分的权值** |
| **情感状态机** | 6 态：Neutral / Happy-Excited / Annoyed / Thoughtful / Confused；由 `processGameState()` 依上下文迁移 | 情绪是**被事件更新并保留的状态**，不是每轮现算的标签 |
| **认知帧** | Play / Strategy / Chaos / Social / Learning / Threat；同一情境不同帧→不同反应 | 同一句话可以因"当前心境"得到不同回应，制造一致性幻觉 |
| **决策打分** | 每个候选动作按"人格权值 × 当前帧"打分，而非纯 LLM 采样 | 行为可预测又有偏好，像"有脾气的人" |
| **探索率** | 70% 选最高分动作 / **30% 随机**（由 Chaotic 0.7 驱动） | **刻意保留 21% 不可预测性**，避免"每次都得体"的机器感 |
| **情绪化评论** | `getPersonalityCommentary()` 按情绪/帧产出不同口吻（得意、吐槽、自嘲，甚至 meta 吐槽开发者 "Thanks Vedal…"） | 口吻随状态变化，且有"内部梗/关系梗" |

`[外部事实]` 该文档在 "Future Enhancements" 中明确列出**尚未实现**：LLM 集成、记忆系统（episodic memory）、学习、Theory of Mind、多模态。也就是说：**这个被认为"有人味"的复刻，其人格表现完全来自"特质向量 + 情感状态 + 认知帧 + 探索率"这套轻量机制，而不是更强的模型。**

`[推断]` 这直接指向本项目的差距性质：**Yuyu 有远比它强的 LLM，却缺少这层"人格状态机"**——把性格写进 prompt 是"描述"，把它变成参与打分的状态才是"表演"。

### 3.2 MaiMBot（麦麦）：慢动力学 + 稀疏模糊 + 决策/表达分层

> ⚠️ **来源更正（重要）**：社区流传的《MaiMBot 情绪系统在群聊场景中的交互机制分析》一文是 **AI 生成的分析稿，不是官方文档**。经逐条比对源码：它描述的"二维情感空间"方向正确，但**"应答意愿 = f(唤醒度)×g(愉悦度)"、动态衰减、多层级内容过滤、分层重构等，在源码中并不存在——它们是该文的"优化建议"**。下面只采用源码级事实。

`[外部事实]` **MaiMBot-Classical 的真实情绪实现**（`src/plugins/moods/moods.py`）：

- **数据结构三层**：① 连续二维数值 `valence ∈ [-1,1]`、`arousal ∈ [0,1]`，初始 `(0.0, 0.5)`；② 7 类离散情绪 → **增量（delta）向量表** `happy:(0.8,0.6)`、`angry:(-0.7,0.7)`、`sad:(-0.6,0.3)`、`disgusted:(-0.8,0.5)`；③ 12 项 `{(v,a): "中文心情词"}` 表，用**欧氏距离最近邻**把连续值反查成词（供人读/调试）。
- **自动更新只有一条路：时间衰减**。单例 daemon 线程每 1 秒 tick，**指数回归且基线不对称**：
  `valence → 0 + (valence-0)*exp(-k·dt)`；`arousal → 0.5 + (arousal-0.5)*exp(-k·dt)`。
  用 `dt`（连续时间）而非逐 tick 乘系数，线程卡顿不影响曲线。
- **情绪判定是独立 LLM 调用**（专用模型任务 `llm_emotion_judge`，默认 Qwen2.5-14B）：输出"立场-情绪"如 `supportive-happy`，并做白名单校验。
- **不持久化**：情绪只在进程内存，重启回到 `(0.0, 0.5, "平静")`。
- `[外部事实]` **该实现存在一个真实 bug**：调用处传 `emotion[0]`（取字符串首字符，`"happy"[0] == "h"`），而 `update_mood_from_emotion` 对未知 key **静默 `return`** → **情绪其实从未被对话更新过，整个模块只在空转衰减**。这解释了为什么该文只能把问题写成"设计缺陷"而非"现象"。

`[外部事实]` **MoFox_Bot（进阶分支）改用自然语言情绪 + 概率门控**，机制更精巧：

- 情绪是**一句话**（如 `"感觉很平静"`），由 LLM 生成（prompt 注入 `personality_core`，故情绪表达带人格）。
- **更新是稀疏的**：`update_probability = 0.05 × min(1, time_multiplier) × interest_multiplier`，其中**兴趣度为 0 则完全不更新**、距上次越久越可能更新（饱和 4×）。→ 情绪不是每条消息都变。
- **180 秒无互动触发"冷静"回归**（LLM prompt："你冷静了下来，请输出一句话描述你现在的情绪状态"），最多 3 次。
- 支持 `lock_mood` 锁定；**默认关闭**（`enable_mood = False`）。

`[外部事实]` **情绪注入的是 Planner，不是 Replyer**。`mood_block = "你现在的心情是：{mood_state}"` 位于 planner prompt **顶部**，同时也进入 proactive planner。即：**情绪只影响"说不说、回谁、配不配表情"的决策层，不直接指令表达层**——这是清晰的分层实践。

`[外部事实]` **情绪只改 prompt，不改采样参数**：源码中没有任何路径按情绪调整 `temperature`/`max_tokens`；情绪被转成**刻意模糊**的修饰语（`"你现在心情很好，情绪比较激动。"`），给模型留表演空间。

`[外部事实]` **错别字模拟器**（`typo_generator.py`）是它最实惠的拟人手段：jieba 分词 + pypinyin 声调 + 字频，参数很小（`error_rate≈0.006`、声调错误 `0.2`、整词替换 `0.006`），且**替换概率偏向高频同音字**（打错也打成常见字）；50% 概率附带"自我纠正"，可生成一条引用原错字的更正消息。

`[外部事实]` **关系值的数学模型**（`relationship_manager.py`，注释写明三条设计目标：逼近边界时增益递减 / 关系越差改善越难、越好恶化越容易 / 高关系用户越多增长越慢）：
- 情绪标签带权（负面普遍重于正面，`disgusted: -4.5` 最重），叠加立场做门控；
- 正向逼近用 `value * cos(π·old/2000)`，负向放大用 `value * exp(old/1000)`；
- 精力上限：增益 `*= 3/(high_value_count+3)`；
- 关系值 -1000~1000 映射 6 档态度词，**每 5 分钟持久化**（关系持久化、情绪不持久化）。

`[外部事实]` **现代主仓已移除独立情绪模块**（main 分支无 mood/emotion，只剩 `heart_flow/`、`typo_generator.py`）。`[推断]` 情绪从"显式可观测状态机"被合并进 prompt 与 utils 任务——这条演进本身就说明：**为一个"看起来重要"的模块保留半死实现，不如合并掉**。

`[外部事实]` 其自我定位（[项目页](https://link.gitcode.com/i/29269c091659c4d387af77af816995e9)）值得逐字读：

> "She does not pursue perfection, nor does she seek efficiency; instead, she values warmth, authenticity, and genuine connection."
> （**她不追求完美，也不追求效率；她重视的是温度、真实与真诚的连接**）

### 3.3 横向对比（本项目 vs 两个标杆）

| 维度 | Yuyu-Mind2（当前事实） | Neuro-sama 复刻 | MaiMBot（源码级） |
|---|---|---|---|
| 性格表达 | 一句中文 persona 注入 prompt | 5 维特质向量参与打分 | 人格 prompt + 关系值/印象 |
| 情绪表示 | 离散 emotion/mood + 连续 VAD（**每轮现算**） | 6 态**状态机**（跨轮保留） | 二维 valence/arousal（**指数衰减**；MoFox 为 LLM 自然语言情绪） |
| 情绪更新频率 | 每轮必算 | 事件驱动 | **稀疏**：MoFox 基础概率仅 5%、且只对"感兴趣"的消息更新 |
| 情绪注入位置 | Planner 产出 → 前端消费 | 影响动作打分 | **注入 Planner（决策层），不进 Replyer**（MoFox） |
| 情绪惯性/衰减 | ❌ 无 | ✅ 状态迁移 | ✅ 指数回归（valence→0 / arousal→0.5），180s 无互动触发"冷静" |
| 情绪是否改采样参数 | 否 | 否 | **否**——只转成模糊修饰语进 prompt |
| 错别字/口语冗余 | ❌ `AllowTypoSimulation` 是**死配置** | 未强调 | ✅ 错别字模拟器（频率偏高频字）+ 50% 自我纠正 |
| 不可预测性 | 低（prompt 约束"话少而精"） | ✅ 30% 探索率 | 风格随机池 / 人格概率采样 |
| 主动发言 | ❌ 硬编码模板、不经 LLM | ✅ 事件驱动的评论 | ✅ **选话题→判时机→才生成** 三段式 |
| 记忆 | 读：按需召回；写：**仅手动** | 规划中（未实现） | 有分级印象（长度随熟悉度）+ 向量记忆 |
| 关系状态 | ❌ 无 | 设计稿有（未实现） | ✅ 关系值数学模型（**每 5 分钟持久化**） |
| 允许沉默 | ❌ 必回（+0.60 恒超阈值） | ✅（wait 帧） | ✅ 意愿累积/退避/概率门控 |
| 自我定位 | "话很少，说得少而精" | "有个性的游戏搭子" | **"不追求完美与效率，追求温度与连接"** |

`[推断]` 对比结论：**Yuyu 在"模型能力"上不弱，弱在各层机制都缺少"状态"与"克制"**。Neuro 用轻量状态机演出了人格；MaiMBot 明确把"不完美、不效率"作为第一性目标；而 Yuyu 目前是一个**"有问必答、情绪现算、话少、不失忆也不记事、从不打字"**的助手——这三者的设计哲学恰好相反。

### 3.4 学术侧：观众为何对 AI VTuber 产生真实连接

`[外部事实]` 学术研究 *My Favorite Streamer is an LLM: Discovering, Bonding, and Co-Creating in AI VTuber Fandom*（[ar5iv 全文](https://ar5iv.labs.arxiv.org/html/2509.10427)）研究观众与 AI VTuber 的情感连接与共创行为。要点：

- **"一致性即真实"**：粉丝优先看重**人格一致性**，而非"类人性"；她的"真实"来自系统稳定性而非扮演者。
- **"透明寄生社会关系"**：观众在**完全知道她是 AI** 的前提下形成情感纽带。
- **不可预测才是吸引力**：90% 的观众被"不可预测、令人惊讶的氛围"吸引；超过一半在**技术故障时会感到难过**——把 bug 当作有意义的事件。
- 论文对开发者的直接建议："**balance persona consistency with strategic unpredictability**"。

`[推断]` 连接的关键不在"回答是否正确"，而在**可预期的性格 + 意外性 + 可被影响的成长**。三点分别对应：人格锚点（稳定）、探索率（意外）、关系/记忆状态（成长）——恰是本项目当前最薄的三处。

### 3.5 Neuro-sama 的"反助手化"工程细节（一手代码级）

`[外部事实]` 以下来自社区复刻项目的一手源码（Neuro 本体闭源，复刻 ≠ 官方，但工程手段可复核）：

| 手段 | 具体做法 | 为什么有效 |
|---|---|---|
| **打断记忆一致性** | 被打断时把 assistant 最后一条消息改写为**实际已播放文本 + "..."**，并插入 `[Interrupted by user]`，且该信号写入 system prompt | 让 AI **只记住自己真正说出口的话**；避免"坚称自己说完了"的穿帮。多数复刻项目漏做 |
| **轮次责任建模** | prompt 明确 "**Favor questions over statements**"、"**No consecutive statements without engagement**" | 真人说话是为了把球打回去，助手是为了交付答案 |
| **长度物理封死** | 停用序列含换行（首行即截断）+ "1–2 sentences" | 从机制上无法长篇大论，比"请不要像助手"有效 |
| **沉默后主动开口** | 轮询仲裁：人说话/AI 说话/思考中一律不触发；**冷场 60s** 无条件开口 | 把"应答机"变成"在场的存在"；主播感的本质是永不冷场 |
| **注意力稀缺** | 并发输入只留最近 10 条，并指令"**挑一条最有意思的回应**" | 逐条回应是机器特征；真人不回每条弹幕 |
| **优先级注入总线** | 各信息源自报 priority，组装时升序拼接、**取完即清**；实测 system=10 < memory=60 < history=100 < **实时输入=150** | 越靠后越有影响力 → 对应"眼下发生的事比上周的事更占据心智" |
| **探索率旋钮** | 70% 选最优 / **30% 随机**（由 chaotic 0.7 驱动） | 可预期中的不可预期；对冲 LLM 的过度正确 |
| **few-shot 台词种子** | prompt 末尾放 3–5 行该角色风格示例对话 | 比任何形容词都更能锚定语气 |
| **可说话化文本** | 数字/日期/货币正规化成可朗读形式后再送 TTS | TTS 念符号是机器感的即时暴露点 |
| **情绪标签显式通道** | 情绪词表运行时注入 prompt，模型在输出内嵌 `[joy]`/`[anger]`，流式抽取后**从 TTS 文本剥离**，再映射到表情槽 | 不让 TTS 从语义"猜"语气；Neuro 本体专门强化过这条链路 |

`[外部事实]` 关于"人格"的一个反直觉事实：**Neuro 本体没有预设人设**——无背景故事，人格由**长期记忆 + 社区共识涌现**而成；人工锚点极少且是**行为触发器**（"喜欢曲奇"用于让她配合）。复刻项目才走"persona prompt + few-shot"路线。

`[外部事实]` 另一条关键取舍：Neuro 的"人味"相当部分来自**刻意不修的缺陷**——幻觉被接纳并**升级为官方设定/社区梗**、分钟级情绪跳变、**故意装笨**以获取幽默反应、以及"她知道自己可能被过滤"这类**关于自身机制的元知识**（甚至会假装被过滤）。Vedal 的取舍是：**能力提升不能以人格连续性为代价**。

---

## 四、可执行改进清单（按性价比排序）

> 编号说明：本节改进项编号（**1–25**）与 §一 的根因编号（1–7）是**两套独立编号**，勿混。P0 = 改配置/常量即可；P1 = 引入状态；P2 = 架构级。
>
> 原则：先做"零成本高收益"（配置/prompt 层），再做"小改动"（加状态），最后才是"架构级"（记忆闭环、多模态）。每一项都注明改动面与验收方式。

### P0 — 立即可做，改配置/常量即可（预期收益最大）

| # | 改动 | 为什么有效 | 触碰文件 | 验收 |
|---|---|---|---|---|
| 1 | **打破必回**：`private_session` 基础分降到阈值以下（如 0.30），让 `looksLikeWeakBackchannel` 与冷却能真正起作用；新增"忙/分心"状态（如任务运行中 −0.2） | 允许"不回复"是真人感第一来源（对标 MaiMBot 应答意愿、Neuro 的 wait 帧） | `turn_gate.go:45`、`config.go` | 单测：弱回撤不再必回；任务中被打断时先完成任务 |
| 2 | **加打字/思考延迟**：回复前按内容长度注入 0.4–2.5s 随机延迟（语音场景=停顿，文本场景=typing 指示） | 消除"零延迟回显" | `send_service.go` / 前端流式起点 | 手动：感知出现自然停顿 |
| 3 | **放松表达约束**：prompt 由"1–2 行、不要 ramble"改为"1–3 句、允许语气词/口头禅/半截话/偶尔自我打断" | 直接提升"像人在说话" | `agents.go:277`、`config.go:153-157` | 抽样 20 条回复，人评"是否像真人" |
| 4 | **实现 `AllowTypoSimulation`**：偶发同音错字/漏字/"手滑"再纠正（聊天场景），语音场景改为"口误+自我修正" | 完美文本是机器特征 | 新增消费点：`send_service.go` | 单测：开启后有概率注入且不破坏语义 |
| 5 | **主动发言改为 LLM 生成**：`buildProactiveLine` 换成走 Replyer 的短 prompt（注入时间、最近话题、情绪状态、桌面活动） | 消除复读机感（对标 MaiMBot 主动话题发起） | `companion.go:584` | 连续 5 次主动发言不重样 |
| 6 | **引入 5–20% 的"不可预测性"**：按 Neuro 的探索率思路，在口吻/表情/回复长度上保留随机偏移，避免每次都"得体" | 抵消 LLM 的过度正确；论文亦指出不可预测性是最强吸引力 | prompt + 采样参数 | 主观：是否还有"标准答案感" |
| 7 | **打断记忆一致性**：被打断时把最后一条 assistant 消息改写为**实际已播出的文本 + `...`**，并追加 `[Interrupted by user]` 信号（同步写入 system prompt） | 让角色**只记住自己真正说出口的话**，消除"坚称说完了"的穿帮；零成本高收益 | `internal/chat/service.go` 打断路径 + `agents.go` prompt | 单测：打断后下一轮不引用未播出内容 |
| 8 | **轮次责任 prompt**：加入 "多用问句而非陈述"、"不要连续陈述而不把话头交回" | 真人对话是"把球打回去"，不是交付答案 | `agents.go:277` | 抽样：问句比例上升 |
| 9 | **优先级注入总线**：各信息源（记忆/环境/历史/实时）实现统一的 `get_prompt_injection() → {text, priority}`，按优先级升序拼接且取完即清 | 让"新增信息源"不再改主 prompt；保证实时输入影响力最强 | 新增 `internal/chat/injection.go` | 单测：优先级顺序稳定；新增源无需改主逻辑 |
| 10 | **并发输入只挑一条**：多来源输入进环形缓冲，prompt 指示"挑最有意思的一条回应" | 逐条回应是机器特征 | 输入汇聚层 | 抽样：不再机械逐条回 |

### P1 — 小改动，引入"状态"（拟人化质变）

| # | 改动 | 为什么有效 | 触碰文件 | 验收 |
|---|---|---|---|---|
| 11 | **情绪改为"模糊修饰语"注入 Planner（不改采样参数、不写精确指令）**：把当前情绪转成"你现在心情很好，情绪比较激动。"这类**不精确**描述放进 Planner 上下文；**不要**写"请输出 20 字以内"、也**不要**按情绪调 temperature | MaiMBot 源码证实：情绪只改 prompt 且措辞刻意模糊（给模型表演空间）；一旦写成精确指令，回复立刻露机器感 | `agents.go`（Planner system prompt 末尾）+ 情绪状态来源 | 抽样：回复长短/语气随情绪自然浮动而非硬约束 |
| 12 | **情绪状态机**：持久化 `{valence,arousal,...}`，**指数回归且基线不对称**（valence→0、arousal→0.5）：`v = 0 + (v-0)*exp(-k·dt)`；每轮**先衰减再让 LLM 增量微调**；转换需过"阈值+最短保持时长" | 情绪成为慢变量 → 连贯可信。用 `dt` 而非逐 tick，长时间离开会自动"冷静" | 新增 `internal/chat/emotion_state.go`；`agents.go` 注入 | 单测：连续对话不跳变；长时间静默后回归中性 |
| 13 | **情绪更新稀疏化/概率门控**：不要每轮都让 LLM 重算情绪；用 `p = 0.05 × 时间增益 × 兴趣度` 门控（兴趣为 0 则完全不更新），并设"无互动 N 秒 → LLM 生成一句冷静后的心情"（限次数） | 每轮重算会导致情绪抖动 + 成本高 + "每句话都在重新评估你"的假 | 情绪状态机 | 统计：情绪变更频率显著低于轮次频率 |
| 14 | **情绪最低保持时长**：同一情绪至少保持 N 轮/秒，避免单轮抖动 | 防止"变脸" | 前端 `emotionEngine.ts` 或后端状态机 | 手动：观察切换是否稳定 |
| 15 | **口语冗余 / 口误自纠正**：语音场景下偶发"嗯…""那个"、重复词、中途自我修正（"我是说…"）；聊天场景可移植 MaiMBot 的错别字思路（频率偏高频同音字、50% 附自我纠正） | 完美文本是机器特征；这是被源码证实、能靠"不完美"提升真实感的手段 | 新增输出后处理 + prompt 授权 | 抽样：口语特征自然、不过量 |
| 16 | **清洗放宽**：`postprocessReply` 只删除"整行纯动作描写"，不再删除行内括号；避免误删口语插入语 | 保留自然语气 | `send_service.go:79-82` | 单测：口语括注保留、纯舞台描写仍删除 |
| 17 | **回复长度随机化**：按场景在 1–4 句内随机（短问短答、闲聊可长），而非恒定 1–2 行 | 真人长度分布不均 | `agents.go:277` + 采样参数 | 统计长度分布 |
| 18 | **口语特征库**：人设补充口癖/填充词，并让 prompt 从中采样（避免每次都"主人～"） | 提高角色辨识度；口癖被"接管"后成为关系锚点 | `config.go` persona/style_notes | 抽样：口癖频率自然 |

### P2 — 架构级（记忆闭环与关系）

| # | 改动 | 为什么有效 | 触碰文件 | 验收 |
|---|---|---|---|---|
| 19 | **对话后自动抽取记忆**：每 N 轮或会话结束时，用 LLM 抽取 `{事实/偏好/承诺}` 写入 `memory_candidates`，按置信度自动 promote；记忆条目分 `long-term`（人工写、可读 id）与 `short-term`（自动、UUID）两级 | 让"记得住"成立；两级记忆是**低成本人格编辑**的唯一实用手段（可手工改人格而不改代码） | `internal/memory/long_term.go` + `service.go` 收尾钩子 | 跨会话：提及上次内容能被召回 |
| 20 | **关系/印象：单标量 + 印象长度分级**（**不要**照搬 -1000~1000 六档） | 单用户场景下多档位是过度设计；但"**态度越极端→印象越详细**"（`multiplier = abs(100-a)/100 + 1`）与"熟悉度越高→记得越细"（按互动次数分级字数）极优雅 | 新增 `internal/memory/relationship.go` | 手动：相处越久称呼/语气变化 |
| 21 | **记忆主动回灌 + 注入话术拟人化**：每轮无条件注入最近 N 条相关记忆（不依赖 Planner 判断）；话术用"看到这些聊天，你想起来：…"而非"检索结果如下" | 降低召回门槛；**注入话术决定"像人"还是"像检索系统"** | `agents.go:291` | 抽样：无提示也能自然引用旧事 |
| 22 | **主动搭话三段式**：① 从"有厚度的记忆节点"随机取 5 个话题让 LLM 选 1；② 用一个**只输出 yes/no 的廉价调用**判"现在说合适吗"；③ 才生成内容（要求口语化、别太有条理） | 单用户下主动开口是核心价值，但最怕尬聊；用便宜二元 gate 挡在生成前，成本远低于让主模型自己判断 | `companion.go` + 记忆模块 | 连续主动发言不重样、且不尴尬 |
| 23 | **环境感知进 prompt**：时间/是否深夜/前台应用/是否在写代码，影响语气与主动性（可用时段规则，如凌晨更安静） | 真人反应依赖情境 | `companion.go` + 前端上报 | 手动：深夜语气更安静 |
| 24 | **prompt 文件化 + 命名注册表**：把人格/情绪/关系/记忆的 prompt 片段拆成独立文件与命名 key，代码只做参数注入 | **人格调优是这类项目最高频的改动**；硬编码 f-string 会让每次调优都变成改代码+回归测试 | `internal/chat/prompts/` + 加载器 | 改人设无需改 Go 逻辑 |
| 25 | **Live2D 情绪→参数映射表**：`(valence, arousal) → 参数组`（valence→嘴角/眉形；arousal→动作幅度/眨眼频率/呼吸） | 把数值情绪**变现为形象**的关键转译层（本项目已有 `emotionEngine.ts`，可扩展为连续驱动） | `frontend/src/components/emotionEngine.ts` | 手动：情绪变化时形象连续变化而非跳变 |

### 明确"不要做"（单用户桌宠场景）

`[外部事实]` MaiMBot 最重的部分（willing 回复意愿系统、Focus 专注模式、发言频率时段规则、`no_action` 退避、`planner_interrupt`）**都是"几百人群聊里何时插话"的解药**。`[推断]` 桌宠是 1 对 1、常驻、语音场景，**引入这些会造成"该回话时不理你"的挫败感**——比"太热情"更伤体验。不要照搬。

### 反面教训（来自标杆项目的真实缺陷，务必避开）

`[外部事实]` 标杆项目自身踩过的坑，对本项目同样致命：

1. **不要留静默失效的模块**——Classical 的情绪更新因 `emotion[0]`（取字符串首字符）与"未知 key 静默 return"而**整条链路空转、且无任何报错**。→ 本项目 `AllowTypoSimulation` 已是同类死配置；**写入型函数遇到未知输入必须打日志/抛错**，并补端到端断言测试（如"注入 happy → 断言 valence 上升"）。
2. **不要在配置不完整时静默回退默认值**。
3. **不要往 prompt 塞空结果**（如"未检索到记忆"这类零信息段落）。
4. **不要把"是否响应"和"如何响应"混在一起**——严守决策层/表达层边界（本项目的 Planner/Replyer 分离是正面样板）。
5. **人格 prompt 写 1–2 句即可**，官方明确"太长反而稀释效果"。

### P3 — 可选实验

- **双通道情绪**：快速通道也用轻量分类器/小模型判情绪，避免关键词误判（对应 §2.7）。
- **性格漂移**：随相处时间微调 persona（更熟→更放松/更毒舌），模拟关系演进。
- **失败与不确定性表达**："让我想想…""我不太确定" 而非永远确定。
- **内部独白**：偶发输出非对用户说的自言自语（Neuro-sama 式），制造"有内心活动"的错觉。
- **注意力漂移 / 情绪特质档位**：把"稳定度/漂移程度"做成可调旋钮（仅调参，不改架构）。

### 建议的最小起步组合

若只做三件事：**① 打破必回 + ② 加思考延迟 + ③ 放松表达约束**——全部是低难度纯逻辑改动，却覆盖了"应答机 vs 在场者"的主要差距。
再做三件：**④ 打断记忆一致性 + ⑤ 情绪模糊修饰语注入 Planner + ⑥ 情绪数值动力学（含衰减）**。
记忆闭环（19–21）放最后：**没有前六项，加了记忆也只是让应答机记得更多**。

---

## 五、来源索引

**外部资料**（未受信内容，仅作设计参考）：

- Neuro-sama 复刻实现的机制文档：[IMPLEMENTATION.md](https://raw.githubusercontent.com/o9nn/neuro-sama/main/Neuro/IMPLEMENTATION.md)（**社区复刻，非官方**）
- Neuro-sama 复刻项目（7 天复刻，含完整源码）：[kimjammer/Neuro](https://github.com/kimjammer/Neuro)（[SYSTEM_PROMPT](https://raw.githubusercontent.com/kimjammer/Neuro/master/constants.py)、[prompter.py](https://raw.githubusercontent.com/kimjammer/Neuro/master/prompter.py)、[记忆模块](https://raw.githubusercontent.com/kimjammer/Neuro/master/modules/memory.py)）· [Naomarius/AI-Vtube-Chat-Bot](https://github.com/Naomarius/AI-Vtube-Chat-Bot)
- Open-LLM-VTuber（情绪标签→Live2D 的可运行参考）：[仓库](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)（[concise_style_prompt](https://raw.githubusercontent.com/Open-LLM-VTuber/Open-LLM-VTuber/main/prompts/utils/concise_style_prompt.txt) · [live2d_expression_prompt](https://raw.githubusercontent.com/Open-LLM-VTuber/Open-LLM-VTuber/main/prompts/utils/live2d_expression_prompt.txt) · [打断记忆一致性](https://raw.githubusercontent.com/Open-LLM-VTuber/Open-LLM-VTuber/main/src/open_llm_vtuber/agent/agents/basic_memory_agent.py)）
- 官方游戏 SDK（人格/延迟约束的一手说明）：[VedalAI/neuro-sdk](https://github.com/VedalAI/neuro-sdk)
- AI VTuber 粉丝研究论文：[My Favorite Streamer is an LLM (arXiv:2509.10427)](https://arxiv.org/abs/2509.10427)（镜像：[alphaXiv](https://www.alphaxiv.org/abs/2509.10427)）
- 记忆反思机制的理论来源：[Generative Agents (arXiv:2304.03442)](https://arxiv.org/abs/2304.03442)
- **MaiMBot-Classical（情绪/关系/意愿的一手源码）**：[moods.py](https://raw.githubusercontent.com/SengokuCola/MaiMBot-Classical/main/src/plugins/moods/moods.py) · [prompt_builder.py](https://raw.githubusercontent.com/SengokuCola/MaiMBot-Classical/main/src/plugins/chat/prompt_builder.py) · [relationship_manager.py](https://raw.githubusercontent.com/SengokuCola/MaiMBot-Classical/main/src/plugins/chat/relationship_manager.py) · [typo_generator.py](https://raw.githubusercontent.com/SengokuCola/MaiMBot-Classical/main/src/plugins/utils/typo_generator.py) · [willing/mode_classical.py](https://raw.githubusercontent.com/SengokuCola/MaiMBot-Classical/main/src/plugins/willing/mode_classical.py) · [CLAUDE.md](https://raw.githubusercontent.com/SengokuCola/MaiMBot-Classical/main/CLAUDE.md)
- **MoFox_Bot（概率门控情绪 + 自然语言情绪，更先进）**：[mood_manager.py](https://raw.githubusercontent.com/MoFox-Studio/MoFox_Bot/master/src/mood/mood_manager.py) · [planner_prompts.py](https://raw.githubusercontent.com/MoFox-Studio/MoFox_Bot/master/src/plugins/built_in/affinity_flow_chatter/planner/planner_prompts.py)
- MaiMBot 官方文档：[Bot 配置](https://docs.mai-mai.org/manual/configuration/bot-config) · [模型配置（Planner/Replyer 分层）](https://docs.mai-mai.org/manual/configuration/model-config) · [A_Memorix 记忆系统](https://docs.mai-mai.org/manual/configuration/amemorix-config)

> ⚠️ **来源可靠性更正**：社区流传的《MaiMBot 情绪系统在群聊场景中的交互机制分析与优化建议》等几篇 GitCode 博客是 **AI 生成的分析稿，不是官方文档**。经逐条比对源码，其"二维情感空间"方向正确，但**"应答意愿 = f(唤醒度)×g(愉悦度)"、动态衰减、多层级过滤、分层重构等均属该文的建议，源码中并不存在**。本报告已剔除这些内容，只采用源码级事实。同理，Neuro 本体的技术细节（TTS 来源、歌回性质等）多为社区百科记载，且**本体闭源**，任何"官方架构"说法都应打折。

**本项目源码**（第一手，可逐行核对）：见 §七 索引表。


---

## 六、验收建议（如何判断真的变像人了）

不要只看单条回复，建议用三个可复核的指标：

1. **盲测**：把 Yuyu 与真人/标杆的 20 条回复混排，让人判断"哪条是 AI"（目标：错误率显著上升）。
2. **连续性**：同一话题聊 10 轮，检查情绪/称呼/记忆是否连贯（而非每轮重置）。
3. **沉默合理性**：统计"未回复"的比例与场景是否合理（目标：不再 100% 必回）。

---

## 七、附：本次核查的关键文件索引

| 主题 | 文件 |
|---|---|
| Planner/Replyer 提示词与情绪 schema | `internal/chat/agents.go` |
| 情绪白名单与钳制、关键词兜底 | `internal/chat/emotion.go` |
| 门控（必回机制） | `internal/chat/turn_gate.go` |
| 快速通道（跳过 Planner） | `internal/chat/fast_path.go` |
| 回复清洗与分条 | `internal/chat/send_service.go` |
| 默认人设与配置 | `internal/config/config.go:151-165` |
| 主动发言模板 | `internal/app/companion.go:584-599` |
| 长期记忆 | `internal/memory/long_term.go`、`internal/db/memory_repo.go` |
| 前端情绪合成 | `frontend/src/components/emotionEngine.ts` |
| Live2D 表演 | `frontend/src/components/Live2DStage.tsx` |
