# 代码助手插件（code-assistant）

通过 **Codex CLI** 在项目里写代码。默认 `live` 评审模式会把改动实时保留为 VS Code 源代码管理中的未暂存变更，你可以按文件、按块甚至按选中行接受或拒绝；桌宠后台任务在代码生成结束时即为完成，评审是完成后的后处理动作。目录即插件，丢进 `plugins/` 点「重新加载」即可。

## 目录结构（模块化）

```
plugins/code-assistant/
├── plugin.json     # 元数据：entry=src/index.js，声明 actions/tools
├── config.json     # 运行配置
├── package.json    # 模块信息（main=src/index.js）
├── README.md
└── src/
    ├── index.js    # 入口：JSON-RPC 分发（invoke_action / invoke_tool）
    ├── codex.js    # 运行 Codex，流式输出 + 发射进度事件
    └── git.js      # git 评审：live 工作区、diff、整轮接受/拒绝
```

> 复杂插件就这样拆分：入口只做分发，逻辑放到 `src/` 下的多个模块，通过 Node `require` 相互引用，不必全写进一个 `main` 文件。

## 能力

| 能力 | 类型 | 说明 |
|---|---|---|
| `run_agent` | 工具（LLM 触发） | 运行 codex 写代码，默认实时写入当前工作区并返回 diff + 进度步骤 |
| `show_diff` | 动作 | 查看待评审的 diff |
| `list_changes` | 动作 | 返回待评审文件列表（新增/修改/删除/重命名） |
| `open_changes` | 动作 | 打开 VS Code 当前评审工作区与变更文件 |
| `accept_changes` | 动作 | 接受新代码（live 模式保留未提交改动；branch 模式合并分支） |
| `reject_changes` | 动作 | 拒绝新代码（回滚到本轮开始前的基线） |
| `open_workspace` | 动作 | 在 IDE 打开当前评审工作区 |

## 评审式改动工作流

1. 聊天里让 Yuyu「帮我改代码」→ Planner 发起后台任务 → Worker 调用 `run_agent`。
2. 插件把项目初始化成 git 仓库（如还不是），记录本轮开始时的 `HEAD` 作为基线。
3. 默认 `live` 模式会先打开 VS Code 工作区，然后让 codex 直接在当前分支写文件；VS Code Source Control 会随着文件落盘实时刷新。
4. 你在**桌宠日志/任务页**看进度（插件会中途发射 `agent_progress` 事件，宿主写入日志并发 `plugin:progress` Wails 事件）。
5. 在 VS Code 源代码管理里点开文件，使用 VS Code 原生的“保留/还原所选范围”完成块级评审；或点任务页里的 `list_changes` / `show_diff` 看清单与 diff。
6. 任务会在 Codex 生成结束时完成；之后可点 `accept_changes` 标记整轮接受，或点 `reject_changes` 回滚到本轮开始前。需要旧版 feature 分支合并流程时，把 `review_mode` 设为 `branch`。

## 配置项（`config.json`）

| 键 | 默认 | 含义 |
|---|---|---|
| `agent_command` | `codex` | Codex 可执行名 |
| `model` | `""` | `--model`；留空用 codex 默认（**ChatGPT 账号请留空或选受支持模型**） |
| `full_auto` | `true` | `--approve-for-me` 自动批准（隐含 workspace-write 沙箱） |
| `sandbox` | `workspace-write` | 仅 `full_auto=false` 且 `dangerous=false` 时生效 |
| `dangerous` | `false` | `--dangerously-bypass-approvals-and-sandbox`（极危险） |
| `timeout_ms` | `600000` | 单次运行超时（毫秒） |
| `cwd` | `""` | 运行目录（= `-C` 工作区根与沙箱作用域）。留空=桌宠工作区；建议设为项目目录 |
| `ide_command` | `code` | IDE 命令 |
| `review_mode` | `live` | `live`=当前分支未暂存实时评审；`branch`=旧版 feature 分支整轮评审 |
| `auto_open_vscode` | `true` | `live` 模式开始运行时自动打开 VS Code 工作区 |
| `allow_dirty_review` | `false` | 是否允许目标项目带已有未提交改动时运行。默认禁止，避免混入你的手动改动 |
| `review_poll_ms` | `2000` | 运行中检查 git 变更并向桌宠日志/任务进度上报的间隔 |
| `incremental_review` | `true` | 给 Codex 注入小步落盘要求，让 VS Code 尽量逐块看到未暂存变更 |
| `codex_json` | `true` | 使用 `codex exec --json` 解析补丁/工具事件，捕捉 apply/write 时机并刷新变更状态 |
| `extra_args` | `[]` | 追加到 `codex exec` 的参数 |

> Windows 上 codex 是 npm 的 `.cmd` shim，插件会自动定位 `node .../codex.js` 直接用 node 跑（绕开 shell 引号问题）。

## 在 VS Code 中查看改动

codex 的改动默认会保留为「相对基线的未暂存改动」，所以只要把项目打开在 **VS Code** 里就能直接看到增删：

1. `run_agent` 开始后会自动执行 `code --reuse-window <cwd>` 打开当前评审目录。
2. 在 VS Code 打开 **源代码管理**（`Ctrl+Shift+G`），文件会在 codex 写入磁盘时持续出现。
3. 点某个文件进入 diff 视图，`+`/`-` 就是本轮 agent 的改动。
4. 对单个块或选中行，使用 VS Code diff 工具栏/右键菜单里的保留、暂存或还原所选范围。保留就是接受该块，还原就是拒绝该块。
5. 桌宠任务页的 **在 VS Code 查看** 会重新聚焦工作区并打开前几个变更文件；它不再用临时 `code --diff` 伪造对比页，因为那种页面不能可靠执行 hunk 级接受/拒绝。
6. 最后：任务状态不等待评审；在桌宠里点 **接受新代码** 只是结束本轮评审并保留当前未提交改动；点 **保留旧代码** 会整轮回滚到开始前。也可以完全在 VS Code 里暂存、提交或放弃更改。

实时显示的边界：VS Code 只能显示已经写入磁盘的文件变更，不能显示模型还在推理但尚未 apply/write 的代码。插件默认会启用 `codex exec --json` 并要求 Codex 小步落盘；如果 Codex CLI 仍选择最后一次性应用大补丁，VS Code 也只能在那次补丁落盘后显示。

如果 VS Code 打开了但没有变更，先看桌宠日志里的 `VS Code 实时评审：N 个文件有未暂存改动` 和 `Codex 文件变更`：

- `cwd` 必须等于 VS Code 打开的项目根。
- `N=0` 说明 Codex 还没把文件写到磁盘，或实际任务没有产生文件改动。
- `N>0` 但 VS Code 没显示，通常是 VS Code 打开的不是日志里的 `cwd`，或源代码管理视图当前选中了另一个仓库。

进度解析读取 `item.type=file_change` 与 `item.changes`，同一文件的后续补丁也会通知。轮询会比较文件大小和修改时间，检查全部变更文件（事件展示最多 20 项）。总结取 `agent_message` 的正文，不再把 `item.completed` 等协议名称当成总结。

看到 `Codex 连接或执行异常` 时，应先检查 Codex 连接；反复 502、连接拒绝或重连通常发生在写盘之前。插件继承本机 Codex 的 provider 配置，包括自定义本地转发地址；插件 `model` 留空不代表自动使用官方连接。超时结果会附带最近一次连接错误。全局连接配置不会被插件自动切换。

> 目录不是 git 仓库时会在 `run_agent` 时自动 `git init` 并创建一个空基线提交。为保护手动改动，默认要求目标项目在运行前没有未提交变更。

实现要点：不依赖 VS Code 私有扩展 API，而是复用标准 git 工作区状态。`list_changes` 读取 `git diff --name-status -M -z HEAD`；`show_diff` 读取 `git diff HEAD`；`open_changes` 聚焦真实工作区，让 VS Code SCM 自己提供文件级、块级和选区级操作。目录型变更不会再伪装成文件 diff，避免 VS Code 打开后空白。

## 手动测试

事件解析回归测试（不调用模型）：`node --test plugins/code-assistant/src/codex.test.js`。

```bash
node plugins/code-assistant/src/index.js
# 输入：{"id":1,"method":"invoke_tool","params":{"tool":"run_agent","arguments":"{\"task\":\"列出一个文件\"}"}}
```
