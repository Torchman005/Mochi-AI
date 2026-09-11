'use strict';
// NetEase Cloud Music 目录插件 sidecar 入口。
// 协议见 docs/PLUGIN-GUIDE.md：宿主在首次调用时用 `node <entry>` 拉起本进程，
// 通过 stdin/stdout 的 newline-delimited JSON-RPC 通信（invoke_action / invoke_tool）。
// 依赖：本机 NetEaseCloudMusicApi（api-enhanced，默认 http://127.0.0.1:3000）已启动，
// 该服务把网易云私有接口封装成公开 REST API。BaseURL 在 config.json 的 apiBaseUrl 配置。

const readline = require('readline');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// 配置（宿主注入 YUYU_PLUGIN_CONFIG，JSON 字符串；解析失败回退 config.json 默认值）
// ---------------------------------------------------------------------------

function defaultConfig() {
  return {
    apiBaseUrl: 'http://127.0.0.1:3000',
    timeoutSeconds: 12,
    cookie: '',
    defaultLimit: 5,
    defaultQuality: 'exhigh',
    openPlaybackUrl: true,
    autoNext: true,
    queueSize: 20,
  };
}

// 配置规范化：把任意来源（宿主注入 / 直接调用）的配置补齐字段并钳制取值范围。
// loadConfig 与 createController 共用，保证「直接 new controller（测试/嵌入）」也有一致默认值。
function normalizeConfig(raw) {
  const merged = Object.assign(defaultConfig(), raw && typeof raw === 'object' ? raw : {});
  merged.apiBaseUrl = String(merged.apiBaseUrl || defaultConfig().apiBaseUrl).trim().replace(/\/+$/, '');
  merged.timeoutSeconds = Math.max(1, Number(merged.timeoutSeconds) || 12);
  merged.cookie = String(merged.cookie || '');
  merged.defaultLimit = Math.min(50, Math.max(1, Math.floor(Number(merged.defaultLimit) || 5)));
  merged.defaultQuality = String(merged.defaultQuality || 'exhigh').toLowerCase();
  merged.openPlaybackUrl = merged.openPlaybackUrl !== false;
  // 自动连播：默认开启；queueSize 限制队列/补歌上限，防止无限扩张。
  merged.autoNext = merged.autoNext !== false;
  merged.queueSize = Math.min(100, Math.max(1, Math.floor(Number(merged.queueSize) || 20)));
  return merged;
}

function loadConfig() {
  let injected = {};
  try {
    injected = JSON.parse(process.env.YUYU_PLUGIN_CONFIG || '{}');
  } catch (_) { /* 宿主注入异常时用默认值 */ }
  return normalizeConfig(injected);
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// HTTP 客户端（Node 原生 http/https，无第三方依赖；支持 cookie）
// ---------------------------------------------------------------------------

function pickTransport(url) {
  return url.protocol === 'https:' ? https : http;
}

function getErrorUrlText(err) {
  if (!err) return '未知错误';
  const msg = String(err.message || err);
  if (err.code === 'ECONNREFUSED') return '无法连接音乐 API 服务（' + msg + '）';
  if (err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT' || err.code === 'ESOCKETTIMEDOUT') return '请求音乐 API 超时';
  if (err.code === 'ENOTFOUND') return '无法解析音乐 API 域名';
  return msg;
}

function httpGetJson(urlString, { timeoutMs = config.timeoutSeconds * 1000, cookie = config.cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(new Error('无效的 API 地址：' + String(e && e.message || e)));
      return;
    }
    const transport = pickTransport(url);
    const req = transport.request(url, {
      method: 'GET',
      headers: Object.assign({
        'User-Agent': 'Yuyu-Mind/netease-music-plugin',
        Accept: 'application/json',
      }, cookie ? { Cookie: cookie } : {}, headers),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          reject(new Error('音乐 API 返回 HTTP ' + status + (raw ? '：' + raw.slice(0, 200) : '')));
          return;
        }
        let json;
        try {
          json = JSON.parse(raw);
        } catch (e) {
          reject(new Error('音乐 API 返回的不是有效 JSON（HTTP ' + status + '）'));
          return;
        }
        const code = json && typeof json === 'object' ? Number(json.code) : NaN;
        if (!Number.isNaN(code) && code !== 200) {
          const msg = String((json && (json.message || json.msg)) || ('网易云错误码 ' + code));
          reject(new Error(msg));
          return;
        }
        resolve(json);
      });
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' }));
    });
    req.end();
  });
}

function fmtDurationSeconds(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return m + ':' + String(rest).padStart(2, '0');
}

function fmtArtists(artists) {
  if (!Array.isArray(artists) || artists.length === 0) return '';
  return artists.map((a) => String((a && (a.name || a.artistName)) || '')).filter(Boolean).join(' / ');
}

function fmtAlias(song) {
  if (!song) return '';
  const alias = Array.isArray(song.alias) ? song.alias : [];
  return alias.map((x) => String(x)).filter(Boolean).join(' ');
}

// 把一首歌规整成插件结果里的「曲目对象」，字段名稳定（camelCase），前端与 LLM 共用。
function normalizeTrack(song) {
  const id = Number(song && (song.id || song.songId));
  if (!song || !Number.isFinite(id) || id <= 0) return null;
  const artists = fmtArtists(song.artists || song.ar);
  const album = song.album ? String(song.album.name || '') : String((song.al && song.al.name) || '');
  return {
    songId: id,
    name: String(song.name || ''),
    artists,
    artist: artists,
    album,
    alias: fmtAlias(song),
    durationSeconds: Math.floor(Number(song.duration || song.dt || 0) / 1000),
    duration: fmtDurationSeconds(Math.floor(Number(song.duration || song.dt || 0) / 1000)),
    source: 'netease',
  };
}

// ---------------------------------------------------------------------------
// Netease api-enhanced 客户端
// ---------------------------------------------------------------------------

function neteaseApi(cfg) {
  const base = cfg.apiBaseUrl;
  const defaultParams = { cookie: cfg.cookie, realIP: cfg.realIP || '' };
  async function get(pathname, params) {
    const merged = Object.assign({}, defaultParams, params || {});
    const parts = Object.keys(merged)
      .filter((k) => merged[k] !== undefined && merged[k] !== '')
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(merged[k]));
    const url = base + pathname + (parts.length ? '?' + parts.join('&') : '');
    return httpGetJson(url, { timeoutMs: cfg.timeoutSeconds * 1000, cookie: cfg.cookie });
  }

  // /search?keywords=...&limit=... → 规范化曲目列表
  async function search(keywords, limit) {
    const data = await get('/search', { keywords, limit: limit || cfg.defaultLimit, type: 1 });
    const result = (data && data.result) || {};
    const songs = Array.isArray(result.songs) ? result.songs : [];
    const tracks = songs.map(normalizeTrack).filter(Boolean);
    return { tracks, total: Number(result.songCount || songs.length || tracks.length) };
  }

  // /song/url/v1?id=...&level=... → 返回可播放直链（不可播返回 { url: '', free: false }）
  async function songUrl(songId, level) {
    const data = await get('/song/url/v1', { id: songId, level: level || cfg.defaultQuality });
    const dataArr = (data && Array.isArray(data.data)) ? data.data : [];
    const first = dataArr[0] || {};
    return {
      url: String(first.url || ''),
      free: first.free !== false && first.free !== 0,
      level: String(first.level || ''),
    };
  }

  // /song/detail?ids=... → 曲目详情（含是否需要付费等信息）
  async function songDetail(songId) {
    const data = await get('/song/detail', { ids: songId });
    const songs = (data && Array.isArray(data.songs)) ? data.songs : [];
    return normalizeTrack(songs[0]);
  }

  // /lyric?id=... → lrc 与 tlyric 文本
  async function lyric(songId) {
    const data = await get('/lyric', { id: songId });
    const pick = (block) => {
      if (!block || typeof block !== 'object') return '';
      const raw = String(block.lyric || block.text || '');
      return raw.trim();
    };
    return { lrc: pick(data && data.lrc), tlyric: pick(data && data.tlyric) };
  }

  async function ping() {
    try {
      const data = await get('/login/status');
      return data && typeof data === 'object';
    } catch (_) {
      return false;
    }
  }

  // /simi/song?id=... → 相似歌曲（自动连播在队列耗尽时用它续播）。
  async function similar(songId, limit) {
    const data = await get('/simi/song', { id: songId, limit: limit || 10 });
    const songs = (data && Array.isArray(data.songs)) ? data.songs : [];
    return songs.map(normalizeTrack).filter(Boolean);
  }

  return { search, songUrl, songDetail, lyric, ping, similar };
}

// 解析歌词 LRC 文本为 {time, text} 行数组（供前端展示/滚动）。
function parseLrc(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const lineRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const matches = [];
    let m;
    lineRe.lastIndex = 0;
    while ((m = lineRe.exec(line)) !== null) matches.push(m);
    if (matches.length === 0) {
      // 无时间戳的元信息行（如 [ti:xxx]）忽略；纯文本行保留为无时间歌词。
      if (!line.startsWith('[')) out.push({ time: null, text: line });
      continue;
    }
    // 最后一个时间戳之后才是歌词正文（[mm:ss] 全部位于行首）
    const last = matches[matches.length - 1];
    const content = line.slice(last.index + last[0].length).trim();
    for (const mm of matches) {
      const min = Number(mm[1]);
      const sec = Number(mm[2]);
      const fracRaw = mm[3] || '';
      const frac = fracRaw ? Number(fracRaw) / Math.pow(10, fracRaw.length) : 0;
      out.push({ time: +(min * 60 + sec + frac).toFixed(3), text: content });
    }
  }
  out.sort((a, b) => (a.time === null ? -1 : a.time) - (b.time === null ? -1 : b.time));
  return out;
}

// 把 LRC 换成纯文本（去时间戳），方便 LLM 与前端展示。
function lrcToText(lrc) {
  if (!lrc || typeof lrc !== 'string') return '';
  return lrc
    .split(/\r?\n/)
    .map((l) => l.replace(/\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// 控制层：解析 intent/输入 → 执行 → 返回「前端可消费」的结果对象。
// result.metadata 供宿主 UI：playbackUrl / playbackAction / track / state；
// result.message 是给用户/LLM 的人类可读摘要。
// ---------------------------------------------------------------------------

function createController(rawCfg) {
  const cfg = normalizeConfig(rawCfg);
  const api = neteaseApi(cfg);
  const state = {
    current: null, // { songId, name, artist, url }
    playback: 'stopped', // playing | paused | stopped（前端音频实际状态由 playbackAction 驱动）
    lastSearch: [], // 最近一次 search 的曲目对象
    history: [],
    queue: [], // 当前播放队列（搜索结果的快照；耗尽后用相似歌曲续播）
    queueIndex: -1, // state.queue 中正在播放的下标
    queueSource: '', // 队列来源描述（搜索词 / 相似歌名），用于提示
    filledFromSimilar: new Set(), // 已用哪些 songId 补过相似歌曲，避免重复补
  };

  function pushHistory(track) {
    state.history.push({ ...track, playedAt: new Date().toISOString() });
    if (state.history.length > 50) state.history.shift();
  }

  function resetQueue(tracks, source) {
    const limit = Math.max(1, Number(cfg.queueSize) || 20);
    state.queue = (Array.isArray(tracks) ? tracks : []).slice(0, limit);
    state.queueIndex = -1;
    state.queueSource = String(source || '');
    state.filledFromSimilar = new Set();
  }

  // 播放一首（已确定的）曲目：取直链 → 更新状态/历史 → 返回带 metadata 的结果。
  // 队列位置（queueIndex）与连播标记（autoNext）由调用方决定，便于 play/next/补歌共用。
  async function playTrack(track, options = {}) {
    const id = Number(track && track.songId);
    if (!(Number.isFinite(id) && id > 0)) {
      return { ok: false, intent: options.intent || 'play', message: '曲目信息不完整，无法播放。' };
    }
    const urlInfo = await api.songUrl(id, options.quality);
    const url = String(urlInfo.url || '');
    const displayName = [track.name, track.artists].filter(Boolean).join(' - ');
    if (!url) {
      return {
        ok: false, intent: options.intent || 'play', songId: id,
        message: '「' + displayName + '」暂时无法播放（可能是付费/VIP 歌曲或需要登录）。' +
          (cfg.cookie ? '' : ' 若已登录网易云，可在插件配置里填上 cookie 再试。'),
        metadata: { playbackAction: 'stop', track },
      };
    }
    state.current = { songId: id, name: track.name, artist: track.artists, url };
    state.playback = 'playing';
    pushHistory(track);
    const queueSize = state.queue.length;
    const atEnd = state.queueIndex >= queueSize - 1;
    const autoNext = Boolean(cfg.autoNext) && queueSize > 0 && !atEnd;
    const result = {
      ok: true,
      intent: options.intent || 'play',
      songId: id,
      message: (options.prefix || '正在播放：') + displayName + (track.duration ? '（' + track.duration + '）' : ''),
      track,
    };
    if (cfg.openPlaybackUrl) {
      result.playbackUrl = url;
      result.metadata = {
        playbackUrl: url,
        playbackAction: 'play',
        track,
        autoNext,
        queue: { index: state.queueIndex, size: queueSize, source: state.queueSource },
        state: { current: state.current, playback: state.playback },
      };
    }
    return result;
  }

  // 队列耗尽时用「相似歌曲」续播；用 filledFromSimilar 去重，避免无限补歌。
  async function fillQueueFromSimilar() {
    const cur = state.current;
    if (!cur || !Number.isFinite(Number(cur.songId))) return 0;
    const seedId = Number(cur.songId);
    if (state.filledFromSimilar.has(seedId)) return 0;
    state.filledFromSimilar.add(seedId);
    let more = [];
    try {
      more = await api.similar(seedId, 10);
    } catch (_) {
      return 0; // 补歌失败不阻断播放，只是不再续播。
    }
    const known = new Set(state.queue.map((t) => Number(t && t.songId)));
    const limit = Math.max(1, Number(cfg.queueSize) || 20);
    let added = 0;
    for (const t of more) {
      if (!t || known.has(Number(t.songId))) continue;
      if (state.queue.length >= limit) break;
      state.queue.push(t);
      known.add(Number(t.songId));
      added += 1;
    }
    if (added > 0 && !state.queueSource) state.queueSource = cur.name || '相似歌曲';
    return added;
  }

  // 下一首：优先队列内下一曲；队列耗尽则自动补相似歌曲后续播。
  async function playNext(options = {}) {
    const limit = Math.max(1, Number(cfg.queueSize) || 20);
    let nextIndex = state.queueIndex + 1;
    if (nextIndex >= state.queue.length || nextIndex >= limit) {
      const added = await fillQueueFromSimilar();
      if (added > 0) nextIndex = state.queueIndex + 1;
    }
    if (nextIndex < 0 || nextIndex >= state.queue.length) {
      return {
        ok: false, intent: 'next',
        message: state.current ? '已经是最后一首了。' : '还没有播放列表，先点一首歌吧。',
      };
    }
    state.queueIndex = nextIndex;
    const track = state.queue[nextIndex];
    const pos = (nextIndex + 1) + '/' + state.queue.length;
    return playTrack(track, {
      intent: 'next',
      quality: options.quality,
      prefix: '下一首（' + pos + '）：',
    });
  }

  async function playIntent(params) {
    const pick = pickTrack(params);
    if (pick.error) return { ok: false, intent: 'play', message: pick.error };
    let track = pick.cached || null;
    let contiguous = Boolean(pick.cached); // cached=来自最近搜索：队列保留完整搜索结果
    if (pick.query && !track) {
      track = await playByQuery(pick.query);
      contiguous = true; // playByQuery 刚写入 lastSearch，同样是完整队列
      if (!track) return { ok: false, intent: 'play', message: '没有找到与「' + pick.query + '」相关的歌曲。', query: pick.query };
    }
    // 播放队列 = 最近一次搜索结果（或点名单曲），供「下一首 / 自动连播」使用。
    // 点播搜索结果的第 N 首时，队列保持搜索顺序并从该首开始。
    const pool = contiguous && Array.isArray(state.lastSearch) && state.lastSearch.length > 0
      ? state.lastSearch
      : [track];
    resetQueue(pool, params.query || track.name || '');
    const idx = state.queue.findIndex((t) => Number(t && t.songId) === Number(track.songId));
    state.queueIndex = idx >= 0 ? idx : 0;
    if (state.queue.length === 0) state.queue = [track];
    return playTrack(track, { intent: 'play', quality: params.quality });
  }

  // 上一首：仅在本次队列内回退（不跨队列取历史，避免回到很久以前的歌）。
  async function prevIntent(params) {
    if (state.queue.length === 0 || state.queueIndex <= 0) {
      return { ok: false, intent: 'prev', message: '已经是第一首了。' };
    }
    state.queueIndex -= 1;
    const track = state.queue[state.queueIndex];
    const pos = (state.queueIndex + 1) + '/' + state.queue.length;
    return playTrack(track, { intent: 'prev', quality: params && params.quality, prefix: '上一首（' + pos + '）：' });
  }

  async function nextIntent(params) {
    return playNext({ quality: params && params.quality });
  }

  async function searchIntent(params) {
    const limit = Math.min(50, Math.max(1, Math.floor(Number(params.limit) || cfg.defaultLimit)));
    const query = String(params.query || '').trim();
    if (!query) return { ok: false, intent: 'search', message: '搜索需要提供歌名/歌手关键词（query）。' };
    const { tracks } = await api.search(query, limit);
    state.lastSearch = tracks;
    if (tracks.length === 0) {
      return { ok: false, intent: 'search', message: '没有搜到与「' + query + '」相关的歌曲。', query, tracks: [] };
    }
    const lines = tracks.map((t, i) => (i + 1) + '. ' + [t.name, t.artists, t.album].filter(Boolean).join(' - ') + '（' + t.duration + '）');
    const message = '「' + query + '」的搜索结果：\n' + lines.join('\n') +
      '\n\n回复“播放 1 / 播放 <歌名>”即可点播。';
    return { ok: true, intent: 'search', message, query, tracks };
  }

  function pickTrack(params) {
    const { query, songId } = params;
    // 指定 songId：优先命中最近搜索缓存，否则仍可直接播放（API 按 id 取详情/直链）。
    const id = Number(songId);
    if (Number.isFinite(id) && id > 0) {
      const cached = state.lastSearch.find((t) => t.songId === id) || null;
      return { id, cached };
    }
    const t = String(query || '').trim();
    if (!t) return { error: '播放需要歌名/歌曲序号（如 播放 1）或 songId。' };
    const indexMatch = /^(?:第\s*)?(\d{1,2})\s*[首号]?$/.exec(t);
    if (indexMatch) {
      const idx = Number(indexMatch[1]) - 1;
      const cached = state.lastSearch[idx];
      if (cached) return { id: cached.songId, cached };
      // 用户可能还没搜过：拿序号当普通关键词回退搜索，避免「请先搜索」的生硬体验。
      return { query: t };
    }
    return { query: t };
  }

  async function playByQuery(query) {
    const { tracks } = await api.search(query, 5);
    if (tracks.length === 0) return null;
    state.lastSearch = tracks;
    return tracks[0];
  }

  async function pauseIntent() {
    if (!state.current) return { ok: true, intent: 'pause', message: '当前没有正在播放的音乐。', metadata: { playbackAction: 'pause', state: { current: null, playback: 'stopped' } } };
    state.playback = 'paused';
    return { ok: true, intent: 'pause', message: '已暂停：' + state.current.name, metadata: { playbackAction: 'pause', track: { songId: state.current.songId, name: state.current.name, artist: state.current.artist }, state: { current: state.current, playback: state.playback } } };
  }

  async function resumeIntent() {
    if (!state.current) {
      return { ok: false, intent: 'resume', message: '没有可继续播放的音乐，请先点歌。', metadata: { playbackAction: 'stop' } };
    }
    state.playback = 'playing';
    const result = { ok: true, intent: 'resume', message: '继续播放：' + state.current.name, state: { current: state.current, playback: state.playback } };
    if (cfg.openPlaybackUrl) {
      result.playbackUrl = state.current.url;
      result.metadata = { playbackUrl: state.current.url, playbackAction: 'play', state: { current: state.current, playback: state.playback } };
    }
    return result;
  }

  const VERB_TABLE = [
    ['pause', '暂停', '停一下', '歇会'],
    ['resume', '继续', '接着放'],
    ['stop', '停止', '停掉', '关了', '别放', '别播', '别放了', '不放了'],
    ['next', '下一首', '下一曲', '下首', '切歌', '换一首', '换歌'],
    ['prev', '上一首', '上一曲', '前一首'],
    ['lyrics', '歌词'],
    ['status', '状态', '现在放', '在放什么'],
    ['search', '搜索', '搜一下', '搜'],
    ['play', '播放', '放', '来一首', '点播', '点歌', '唱', '听'],
  ];

  // 去掉文本开头的动作词，返回剩余内容（"播放 晴天"/"放一首 晴天" → "晴天"；无动词时原样返回）
  function stripIntent(text) {
    const t = String(text || '').trim();
    if (t.length < 2) return t;
    for (const [, ...words] of VERB_TABLE) {
      for (const w of words) {
        if (t.slice(0, w.length).toLowerCase() === w.toLowerCase()) {
          let after = t.slice(w.length).trim();
          if (!after) return '';
          // 时量补语/连动残留不是点歌目标（继续播放/暂停一下/别放了 → 无需 query）
          if (/^(?:一?下|一会|一会儿|会|点)$/.test(after) || /^(?:播放|放|唱|听|播)/.test(after)) return '';
          // 去掉量词/补语前缀（播放/放 后接 一首/首/下/个/一下）
          after = after.replace(/^(?:一?首|一个|一遍|首|遍|曲|下|个|点)\s*/u, '');
          if (!after) return '';
          // 去掉紧随其后的分隔标点
          return after.replace(/^[，,\s。.!！?？:：]+/, '');
        }
      }
    }
    return t;
  }

  // 识别文本开头的动作动词；没有则返回 ''。动词须「独立成词」：
  // 整串即动词、后随分隔标点/空格、或后随时量补语（暂停一下）、或后随（play/search 动词）量词（放一首/搜一下）、
  // 或继续/接着 + 播放类连动（继续播放→resume）、或 stop 类后随音乐名词（别放音乐）。
  function commandOf(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return '';
    // status 疑问句（不一定以动词开头）：「现在放什么」「放什么歌」「在放什么」「放的啥」
    if (/^(?:现在|正在)?\s*(?:在|正)?(?:放|播|唱|听|放得|放的)?\s*(?:什么|啥)/.test(t)) return 'status';
    const SEPS = [' ', '，', ',', '。', '!', '！', '?', '？', ':', '：'];
    const playFollowRe = /^(?:播放|放|唱|听|播|搜)/; // 连动动词
    const stopNounRe = /^(?:音乐|歌|曲|曲子|东西|了)/; // stop 类后的名词宾语
    for (const [intent, ...words] of VERB_TABLE) {
      const w = words.find((word) => {
        const wl = word.toLowerCase();
        if (!t.startsWith(wl)) return false;
        const rest = t.slice(wl.length);
        if (!rest) return true; // 恰好等于动词
        if (SEPS.some((s) => rest.startsWith(s))) return true; // 动词后是分隔符
        if (/^(?:一?下|一会|一会儿|会|点|下)$/.test(rest)) return true; // 暂停一下 / 停一下
        if (intent === 'play' && /^(?:一?首|一个|一下|一遍|首|遍|曲|点|下|个)/.test(rest)) return true; // 「放一首…」
        if (intent === 'search' && /^(?:一?下|一?找|找|看|听)/.test(rest)) return true; // 「搜一下…」
        if (intent === 'resume' && playFollowRe.test(rest)) return true; // 「继续播放」
        if (intent === 'pause' && playFollowRe.test(rest)) return true; // 「暂停播放」
        if (intent === 'stop' && (playFollowRe.test(rest) || stopNounRe.test(rest))) return true; // 「别放音乐」
        if (intent === 'status' && /^放什么|^放的|^在放|^放着/.test(rest)) return true; // 「现在放什么」→ 由「现在放」前缀匹配
        return false;
      });
      if (w) return intent;
    }
    return '';
  }

  // 从自由文本/结构化参数解析 intent（{"intent":"play","query":"晴天"} 或 "播放 晴天"）
  function resolveIntent(rawInput) {
    const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
    const message = String(input.message || input.text || '').trim();
    const explicit = String(input.intent || '').toLowerCase();
    const queryField = String(input.query || '').trim();

    // 有 message：优先识别动词，剩余内容当 query
    if (message) {
      const action = commandOf(message);
      if (action) {
        const rest = stripIntent(message);
        return { intent: action, query: queryField || rest, songId: input.songId };
      }
      // 没有动词：自由文本默认就是「搜索」；显式 intent 可覆盖
      return { intent: explicit || 'search', query: queryField || message, songId: input.songId };
    }
    // 纯结构化参数
    const intent = explicit || (queryField || Number(input.songId) > 0 ? 'search' : 'status');
    return { intent, query: queryField, songId: input.songId };
  }

  async function stopIntent() {
    state.playback = 'stopped';
    return { ok: true, intent: 'stop', message: '已停止播放。', metadata: { playbackAction: 'stop' }, state: { current: state.current, playback: 'stopped' } };
  }

  async function lyricIntent(params) {
    let id = Number(params.songId);
    if (!(Number.isFinite(id) && id > 0) && state.current) {
      id = state.current.songId; // 无 songId 时回落到当前曲目
    }
    if (!(Number.isFinite(id) && id > 0)) {
      return { ok: false, intent: 'lyrics', message: '歌词需要 songId 或当前正在播放的音乐。' };
    }
    const lyr = await api.lyric(id);
    const text = lrcToText(lyr.lrc);
    if (!text) return { ok: false, intent: 'lyrics', message: '这首歌暂无歌词。', songId: id };
    return { ok: true, intent: 'lyrics', songId: id, lyrics: text, lrc: lyr.lrc, parsed: parseLrc(lyr.lrc) };
  }

  async function statusIntent() {
    const cur = state.current;
    const base = { ok: true, intent: 'status', state: { current: cur, playback: state.playback } };
    if (!cur) return Object.assign(base, { message: '当前没有播放中的音乐。' });
    const statusText = state.playback === 'paused' ? '已暂停' : '播放中';
    return Object.assign(base, {
      message: '当前' + statusText + '：' + cur.name + (cur.artist ? ' - ' + cur.artist : ''),
      track: { songId: cur.songId, name: cur.name, artist: cur.artist },
    });
  }

  async function control(input) {
    const resolved = resolveIntent(input);
    try {
      switch (resolved.intent) {
        case 'play': return await playIntent(resolved);
        case 'next': return await nextIntent(resolved);
        case 'prev': return await prevIntent(resolved);
        case 'pause': return await pauseIntent();
        case 'resume': return await resumeIntent();
        case 'stop': return await stopIntent();
        case 'lyrics': return await lyricIntent(resolved);
        case 'status': return await statusIntent();
        case 'search': return await searchIntent(resolved);
        default:
          return { ok: false, intent: resolved.intent, message: '不支持的指令：' + resolved.intent + '。可用：search/play/next/prev/pause/resume/stop/lyrics/status。' };
      }
    } catch (err) {
      return { ok: false, intent: resolved.intent, message: getErrorUrlText(err), error: String(err && err.message || err) };
    }
  }

  return { control, state, api };
}

// ---------------------------------------------------------------------------
// JSON-RPC 壳：invoke_action(control) / invoke_tool(control_netease_music)
// 仅作为入口进程直接运行时挂载（require 供测试时不监听 stdin，避免句柄悬挂）。
// ---------------------------------------------------------------------------

const controller = createController(config);

function reply(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function parseArguments(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function handleLine(line) {
  let req;
  try { req = JSON.parse(line); } catch (_) { return; }
  const id = req.id;
  const method = req.method;
  const params = (req.params || {});
  const respond = (payload) => reply(Object.assign({ id }, payload));

  const run = async () => {
    try {
      if (method === 'invoke_action') {
        if (params.action !== 'control') throw new Error('unknown action ' + params.action);
        const result = await controller.control(params.input || {});
        respond({ result });
      } else if (method === 'invoke_tool') {
        if (params.tool !== 'control_netease_music') throw new Error('unknown tool ' + params.tool);
        const args = parseArguments(params.arguments);
        const result = await controller.control(args);
        // 工具桩约定：result.result 为字符串（LLM 直接消费）；把结构化字段并进字符串便于模型理解。
        respond({ result: { result: JSON.stringify(result) } });
      } else if (method === 'manifest') {
        // 宿主「重新加载」或 sidecar 启动协商时会询问；目录插件以 plugin.json 为准，这里原样回一声。
        respond({ result: { name: 'netease-music', ok: true } });
      } else if (method === 'start' || method === 'stop') {
        respond({ result: { ok: true } });
      } else {
        throw new Error('unknown method ' + method);
      }
    } catch (err) {
      respond({ error: { message: String(err && err.message || err) } });
    }
  };
  run();
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', handleLine);
}

// 让 Node 测试可以用 require 拿到纯逻辑（不带 stdin 壳）。
module.exports = {
  defaultConfig,
  normalizeConfig,
  loadConfig,
  httpGetJson,
  neteaseApi,
  createController,
  normalizeTrack,
  parseLrc,
  lrcToText,
  fmtDurationSeconds,
  getErrorUrlText,
};
