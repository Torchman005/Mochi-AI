# NetEase Music 插件

让 Yuyu Mind 桌宠通过本机 [NeteaseCloudMusicApi](https://gitlab.com/Binaryify/neteasecloudmusicapi)（api-enhanced 服务）搜歌、点歌、播放网易云音乐。插件本身是 Node sidecar，宿主首次调用时自动拉起，stdio JSON-RPC 通信；**实际出声由桌宠前端播放插件返回的音频直链**。

```
plugins/netease-music/
├── plugin.json      # manifest（1 个 action「control」+ 1 个工具「control_netease_music」）
├── config.json      # 运行配置（apiBaseUrl 等）
├── main.js          # sidecar 入口（纯 Node，无第三方依赖）
├── main.test.js     # 回归测试：node --test plugins/netease-music/main.test.js
└── README.md
```

## 前置：启动本机网易云 API 服务

插件不直连网易云，而是调用本机 NeteaseCloudMusicApi。安装并启动（默认端口 3000）：

```bash
# 任选其一：npm 包（推荐）
npm install -g NeteaseCloudMusicApi
NeteaseCloudMusicApi --port 3000

# 或 git 仓库
git clone --depth 1 https://gitlab.com/Binaryify/neteasecloudmusicapi.git
cd neteasecloudmusicapi && npm install && node app.js --port 3000
```

> Windows 可直接下载 Windows 版 exe（Releases），双击即起。

启动后浏览器打开 `http://127.0.0.1:3000/` 能看到接口文档即可。之后在桌宠「插件 → NetEase Music → 编辑配置」确认：

```jsonc
{
  "apiBaseUrl": "http://127.0.0.1:3000", // 服务地址（自动去掉结尾 /）
  "timeoutSeconds": 12,                  // 请求超时
  "cookie": "",                          // 可选：MUSIC_U=...（VIP/试听受限曲目用）
  "defaultLimit": 5,                     // 搜索默认条数
  "defaultQuality": "exhigh",            // standard / higher / exhigh / lossless
  "openPlaybackUrl": true,               // 返回播放直链给前端出声（保持 true）
  "autoNext": true,                      // 自动连播：播完一首自动接下一首
  "queueSize": 20                        // 播放队列 / 相似歌曲补歌上限（1-100）
}
```

配置保存后需点一次「重新加载/编辑配置→保存」让 sidecar 下次拉起生效。

## 使用

- **插件页（手动）**：打开 NetEase Music 详情，在「音乐播放」框里输入自然语言，回车或点「点歌」：
  - `播放 晴天` / `放一首 七里香` / `播放 1`（播最近搜索结果第 1 首）
  - `搜索 周杰伦` / `搜一下 陈奕迅 十年`
  - `下一首` / `切歌` / `上一首`
  - `暂停` / `继续` / `停止` / `歌词` / `状态`
- **房间音乐岛**：右侧音乐浮岛支持同样的自然语言点歌，并提供「⏸ 暂停 / ⏭ 下一首 / ⏹ 停止」按钮与搜索结果列表；「正在播放」会显示队列位置（如 `2/5`）。
- **对话里让 LLM 调用**：模型会自动使用 `control_netease_music` 工具。例如「放首周杰伦的歌」「下一首」「暂停音乐」「现在放的什么歌」。工具的返回文本会进入聊天，且 `metadata.playbackUrl` 会驱动桌宠出声。

> 说明：播放状态机存在 sidecar 内（当前曲目/队列/播放/暂停/停止）；真正的音频播放由前端 `<audio>` 完成——插件通过返回的 `metadata.playbackAction`（play/pause/resume/stop）指挥前端，自己不出声。

## 自动连播（队列 + 相似歌曲续播）

- **队列来源**：点播「搜索结果的第 N 首」或以歌名点播时，sidecar 会把该次搜索结果快照成播放队列，并从被点的那首开始。直接点名单曲（未先搜索）时队列为该单曲。
- **自动续播**：`play`/`next`/`prev` 的返回值带 `metadata.autoNext`（布尔）与 `metadata.queue { index, size, source }`。前端 `<audio>` 播完且 `autoNext === true` 时自动发一次 `下一首`，实现无人值守连播。
  - 队列内还有下一首 → `autoNext: true`。
  - 已到队尾 → `autoNext: false`；下一次 `next` 会先尝试用 `/simi/song`（相似歌曲）**补歌**——补到新歌就继续播（新补入的这首自身仍可能处于队尾，所以它的 `autoNext` 还是 `false`，靠再下一次 `next` 继续补），补不到才判定结束。
  - 相似歌曲也拿不到（或无网络）→ 返回 `{ ok:false, message: '已经是最后一首了。' }`，前端停止，不报错。
- **去重与上限**：同一首 seed 只用相似歌曲补过一次（`filledFromSimilar`），且队列长度不超过 `queueSize`，避免无限续播。
- **关闭连播**：把 `autoNext` 设为 `false` 后所有 `play` 结果都返回 `autoNext: false`，前端播完即停。
- **UI 反馈**：音乐岛「正在播放」显示 `当前/总数`，并提供「⏭ 下一首」手动切歌（与自动连播共用同一条 `next` 路径）。

## 返回契约（前端/LLM 依赖）

`control`（action 与 tool 共用同一解析内核）返回：

```jsonc
{
  "ok": true,
  "intent": "play",                  // search/play/next/prev/pause/resume/stop/lyrics/status
  "message": "正在播放：晴天 - 周杰伦（4:29）",  // 人类可读摘要（tool 用）
  "songId": 186016,
  "track": { "songId": 186016, "name": "晴天", "artists": "周杰伦", "album": "叶惠美", "duration": "4:29", ... },
  "playbackUrl": "http://...",        // 播放直链（play/next/prev/resume 且 openPlaybackUrl=true 时）
  "metadata": {                       // 前端 handlePluginPlaybackResult 消费
    "playbackAction": "play",         // play | pause | resume | stop
    "playbackUrl": "http://...",
    "track": { ... },
    "autoNext": true,                 // 队列里还有下一首 → 前端播完自动续播
    "queue": { "index": 0, "size": 5, "source": "周杰伦" },
    "state": { "current": { ... }, "playback": "playing" }
  }
}
```

- `play` 且歌曲可播 → `metadata.playbackAction="play"` + `playbackUrl`（前端换曲）+ `autoNext`/`queue`。
- `next` → 队列下一首；队尾时先尝试相似歌曲补歌（`message` 形如 `下一首（3/5）：…`）。
- `prev` → 回退到队列内上一首（不跨队列），队首时 `ok:false` + `已经是第一首了。`。
- `pause`/`stop` → 只给 `playbackAction`，前端暂停/停止当前音频。
- `resume` → 复用上次 `playbackUrl` 继续播放。
- 付费/VIP 或 cookie 不对 → `ok:false`，message 提示；`lyrics` 返回 `lyrics`(纯文本) + `parsed`(逐行 {time,text})。

**工具调用形式**：`invoke_tool` 返回 `{ "result": "<JSON 字符串>" }`（宿主工具桩约定，字符串内容同上），LLM 直接读 `message` 即可回复用户。

## 自然语言解析规则（message）

- 动词前缀（可后接标点/空格）：`搜索/搜/搜一下`、`播放/放/来一首/点歌/唱/听`、`下一首/下一曲/下首/切歌/换一首/换歌`、`上一首/上一曲/前一首`、`暂停`、`继续`、`停止/停掉/关了/别放/别播/不放了`、`歌词`、`状态`。
- 其余文本默认当「搜索关键词」（所以直接说歌名也能搜到）。
- `播放 1`、`播放 第2首`：命中最近一次搜索结果序号；若尚未搜索则回退为按「1」搜歌。
- 防误判：`放风筝`/`点歌台`/`听雨` 等歌名/短语不会被当作指令。

## 开发与测试

```bash
# 语法/回归（9 项：意图解析、自动连播队列、状态机、付费兜底、歌词、LRC、曲目规整、JSON-RPC 闭环、连接错误）
node --check plugins/netease-music/main.js
node --test plugins/netease-music/main.test.js
```

回归测试不依赖真实网易服务：JSON-RPC 用例用进程内 mock HTTP 服务模拟 api-enhanced 端点，自动连播用例用 mock `search`/`songUrl`/`similar` 驱动队列。真实联调请启动本机 NeteaseCloudMusicApi 后在桌宠插件页/音乐岛操作。

## 限制与后续

- 播放依赖 `apiBaseUrl` 服务可用；直链有效期一般较短（20 分钟左右），失效需重新点播。
- cookie 只对 `MUSIC_U` 类受限曲目有帮助；部分灰色/版权受限歌曲仍无法播放（返回不可播提示，连播会自动跳过到下一首）。
- 已知待办：歌单 / 我的收藏接入、播放列表持久化、音量控制、歌词滚动同步。
