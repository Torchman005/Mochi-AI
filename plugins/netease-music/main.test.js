'use strict';
// netease-music 插件回归测试：node --test plugins/netease-music/main.test.js
// 区分三层：① 纯意图解析（createController + mock api）；② JSON-RPC 壳 + 本地 mock HTTP
// 服务（不依赖外部网络/真实网易服务）；③ 真实网易服务联调需用户本地自行验证（见 README）。

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const m = require('./main.js');

// 一个带 mock api 的 controller，避免真实网络；搜索按关键词返回（模拟真实行为）
function mockController(overrides = {}) {
  const c = m.createController({ apiBaseUrl: 'http://mock.invalid', timeoutSeconds: 5, openPlaybackUrl: true });
  const ALL = [
    { songId: 1, name: '晴天', artists: '周杰伦', album: '叶惠美', durationSeconds: 269, duration: '4:29' },
    { songId: 2, name: '七里香', artists: '周杰伦', album: '七里香', durationSeconds: 300, duration: '5:00' },
    { songId: 3, name: '十年', artists: '陈奕迅', album: '黑白灰', durationSeconds: 210, duration: '3:30' },
  ];
  // 数字关键词（"播放 2"）按序号返回单首；文字关键词返回全部命中（受 limit 限制），
  // 这样「搜索 → 点播第 N 首 → 下一首」的队列行为与真实搜索一致。
  c.api.search = async (query, limit) => {
    const q = String(query || '');
    if (/^\d{1,2}$/.test(q)) {
      const one = ALL[Number(q) - 1];
      return { tracks: one ? [one] : [], total: one ? 1 : 0 };
    }
    const hits = ALL.filter((t) => q && (t.name.includes(q) || t.artists.includes(q)));
    return { tracks: hits.slice(0, Number(limit) || hits.length), total: hits.length };
  };
  c.api.songUrl = async (id) => ({ url: 'https://mock.cdn/song/' + id + '.mp3', free: true, level: 'exhigh' });
  c.api.lyric = async () => ({ lrc: '[00:01.00]词句一\n[00:05.50]词句二', tlyric: '' });
  c.api.similar = async () => [];
  Object.assign(c.api, overrides);
  return c;
}

test('意图解析：动词 + 自由文本 + 纯结构参数', async () => {
  const c = mockController();
  const searchCases = [
    // [输入, 期望 intent, 期望 query 或 null]
    ['播放 晴天', 'play', null],
    ['放一首 七里香', 'play', null],
    ['播放 2', 'play', null],
    ['搜索 周杰伦', 'search', '周杰伦'],
    ['搜一下 陈奕迅', 'search', '陈奕迅'],
    ['晴天', 'search', '晴天'],
    ['继续播放', 'resume', null],
    ['暂停一下', 'pause', null],
    ['别放音乐', 'stop', null],
    ['别播放了', 'stop', null],
    ['歌词', 'lyrics', null],
    ['现在放什么', 'status', null],
    // 防止歌名/歌词被误判成指令
    ['放风筝', 'search', '放风筝'],
    ['点歌台', 'search', '点歌台'],
    ['听雨', 'search', '听雨'],
  ];
  for (const [text, intent, query] of searchCases) {
    const r = await c.control({ message: text });
    assert.equal(r.intent, intent, '输入「' + text + '」应识别为 ' + intent + '，实际 ' + r.intent);
    if (query === null) {
      assert.ok(!r.query || r.query === '', '「' + text + '」不应产生 query，实际 ' + r.query);
    } else {
      assert.equal(r.query, query, '「' + text + '」的 query 应为 ' + query + '，实际 ' + r.query);
    }
  }
  // play 类返回点播结果（消息/曲目），query 只用于内部取歌
  const play = await c.control({ message: '播放 晴天' });
  assert.equal(play.ok, true);
  assert.equal(play.track.name, '晴天');
  // 无动词纯结构参数
  const structured = await c.control({ intent: 'play', query: '十年' });
  assert.equal(structured.ok, true);
  assert.equal(structured.track.name, '十年');
});

test('自动连播：搜索队列 + 下一首/上一首 + 队列提示 + 耗尽用相似歌曲续播', async () => {
  const c = mockController({
    similar: async (id) => (Number(id) === 3
      ? [
        { songId: 3, name: '十年', artists: '陈奕迅', duration: '3:30' },
        { songId: 9, name: '浮夸', artists: '陈奕迅', duration: '4:47' },
      ]
      : []),
  });

  // 搜索 2 首 → 点播第 1 首：队列保留完整搜索结果，位置在第 1 首，且还有下一首
  const s = await c.control({ message: '搜索 周杰伦' });
  assert.equal(s.tracks.length, 2);
  const p1 = await c.control({ message: '播放 1' });
  assert.equal(p1.ok, true);
  assert.equal(p1.songId, 1);
  assert.deepEqual(p1.metadata.queue, { index: 0, size: 2, source: '1' });
  assert.equal(p1.metadata.autoNext, true, '队列中还有下一首时应标记 autoNext');

  // 下一首 → 队列第 2 首（七里香），此时已到队尾
  const n = await c.control({ message: '下一首' });
  assert.equal(n.ok, true);
  assert.equal(n.intent, 'next');
  assert.equal(n.songId, 2);
  assert.equal(n.metadata.queue.index, 1);
  assert.equal(n.metadata.autoNext, false, '队尾不应再标记 autoNext');

  // 上一首 → 回到第 1 首
  const pv = await c.control({ message: '上一首' });
  assert.equal(pv.ok, true);
  assert.equal(pv.intent, 'prev');
  assert.equal(pv.songId, 1);
  assert.match(pv.message, /上一首/);
  const pv2 = await c.control({ message: '上一首' });
  assert.equal(pv2.ok, false);
  assert.match(pv2.message, /已经是第一首/);

  // 队列耗尽 → 用相似歌曲续播（去重掉已在队列里的 十年）
  const p3 = await c.control({ message: '播放 十年' });
  assert.equal(p3.songId, 3);
  assert.equal(p3.metadata.autoNext, false);
  const n2 = await c.control({ message: '下一首' });
  assert.equal(n2.ok, true);
  assert.equal(n2.songId, 9, '队列耗尽后应续播相似歌曲');
  assert.match(n2.message, /下一首/);

  // 无可续播且无相似 → 明确提示，不崩
  const c2 = mockController({ similar: async () => [] });
  await c2.control({ message: '播放 晴天' });
  const end = await c2.control({ intent: 'next' });
  assert.equal(end.ok, false);
  assert.match(end.message, /最后一首/);
});

test('状态机：search → play(带 playbackUrl) → pause → resume → stop', async () => {
  const c = mockController();
  const s = await c.control({ message: '搜索 晴天' });
  assert.equal(s.ok, true);
  assert.equal(s.tracks[0].name, '晴天');
  const p = await c.control({ message: '播放 1' });
  assert.equal(p.ok, true);
  assert.equal(p.songId, 1);
  assert.equal(p.playbackUrl, 'https://mock.cdn/song/1.mp3');
  assert.equal(p.metadata.playbackAction, 'play');
  assert.equal(c.state.playback, 'playing');
  const pa = await c.control({ message: '暂停' });
  assert.equal(pa.metadata.playbackAction, 'pause');
  assert.equal(c.state.playback, 'paused');
  const re = await c.control({ message: '继续' });
  assert.equal(re.metadata.playbackAction, 'play');
  assert.equal(re.playbackUrl, 'https://mock.cdn/song/1.mp3');
  const st = await c.control({ message: '停掉' });
  assert.equal(st.metadata.playbackAction, 'stop');
  assert.equal(c.state.playback, 'stopped');
});

test('付费/无链接歌曲返回不可播提示并带 stop 指令', async () => {
  const c = mockController({ songUrl: async () => ({ url: '', free: false, level: '' }) });
  const r = await c.control({ message: '播放 晴天' });
  assert.equal(r.ok, false);
  assert.match(r.message, /无法播放/);
  assert.equal(r.metadata.playbackAction, 'stop');
});

test('歌词：LRC 解析去时间戳、纯文本、回落当前曲目', async () => {
  const c = mockController();
  const lyr = await c.control({ intent: 'lyrics', songId: 1 });
  assert.equal(lyr.ok, true);
  assert.equal(lyr.parsed.length, 2);
  assert.equal(lyr.parsed[0].text, '词句一');
  assert.equal(lyr.parsed[1].text, '词句二');
  assert.equal(lyr.parsed[1].time, 5.5);
  // 播放后再取歌词：无 songId 时回落当前曲目
  await c.control({ message: '播放 七里香' });
  const cur = await c.control({ message: '歌词' });
  assert.equal(cur.songId, 2);
});

test('LRC 工具函数：parseLrc/lrcToText 边界', () => {
  assert.deepEqual(m.parseLrc(''), []);
  assert.deepEqual(m.parseLrc('[ti:晴天]\n[00:00.50]  前奏'), [{ time: 0.5, text: '前奏' }]);
  const raw = '[01:02.03]甲\n[02:00]乙';
  const parsed = m.parseLrc(raw);
  assert.equal(parsed[0].time, 62.03);
  assert.equal(m.lrcToText(raw), '甲\n乙');
  // 纯文本行保留为无时间歌词
  assert.equal(m.parseLrc('一句没有时间戳的话')[0].text, '一句没有时间戳的话');
});

test('normalizeTrack：字段规整与无效输入', () => {
  const t = m.normalizeTrack({ id: 42, name: '歌', artists: [{ name: '歌手A' }, { name: '歌手B' }], album: { name: '专辑' }, duration: 189000, alias: ['别名'] });
  assert.equal(t.songId, 42);
  assert.equal(t.duration, '3:09');
  assert.equal(t.artists, '歌手A / 歌手B');
  assert.equal(t.alias, '别名');
  assert.equal(m.normalizeTrack(null), null);
  assert.equal(m.normalizeTrack({ id: 'x', name: 'n' }), null);
});

test('stdin/stdout JSON-RPC 壳：invoke_action 与 invoke_tool', async () => {
  // 用本地 mock HTTP 服务当「网易云 API」，驱动真实入口进程，验证完整协议闭环。
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/search')) {
      res.end(JSON.stringify({ code: 200, result: { songs: [{ id: 7, name: '测试曲', ar: [{ name: '测试歌手' }], al: { name: '测试专辑' }, dt: 125000 }], songCount: 1 } }));
    } else if (req.url.startsWith('/song/url/v1')) {
      res.end(JSON.stringify({ code: 200, data: [{ id: 7, url: 'https://mock.cdn/7.mp3', level: 'exhigh', free: true }] }));
    } else if (req.url.startsWith('/lyric')) {
      res.end(JSON.stringify({ code: 200, lrc: { lyric: '[00:00.10]哔哩哔哩\n' } }));
    } else {
      res.end(JSON.stringify({ code: 200, data: {} }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const entry = path.join(__dirname, 'main.js');
  const child = spawn(process.execPath, [entry], {
    env: Object.assign({}, process.env, { YUYU_PLUGIN_CONFIG: JSON.stringify({ apiBaseUrl: 'http://127.0.0.1:' + port, timeoutSeconds: 5 }) }),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { for (const l of d.split('\n')) { const t = l.trim(); if (t) lines.push(JSON.parse(t)); } });
  const send = (payload) => child.stdin.write(JSON.stringify(payload) + '\n');
  const waitFor = async (count, ms = 3000) => {
    const start = Date.now();
    while (lines.length < count && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
  };

  send({ id: 1, method: 'invoke_tool', params: { tool: 'control_netease_music', arguments: JSON.stringify({ message: '播放 测试曲' }) } });
  await waitFor(1);
  assert.equal(lines[0].id, 1);
  const toolResult = JSON.parse(lines[0].result.result);
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.songId, 7);
  assert.match(toolResult.message, /测试曲/);

  send({ id: 2, method: 'invoke_action', params: { action: 'control', input: { message: '歌词' } } });
  await waitFor(2);
  assert.equal(lines[1].id, 2);
  assert.equal(lines[1].result.ok, true);
  assert.equal(lines[1].result.intent, 'lyrics');
  assert.match(lines[1].result.lyrics, /哔哩哔哩/);

  child.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 50));
});

test('HTTP 兜底：连接拒绝给出可读错误而不是崩溃', async () => {
  const c = m.createController({ apiBaseUrl: 'http://127.0.0.1:1', timeoutSeconds: 2, openPlaybackUrl: true });
  const r = await c.control({ message: '搜索 测试' });
  assert.equal(r.ok, false);
  assert.match(r.message, /无法连接音乐 API/);
  assert.ok(r.error);
});
