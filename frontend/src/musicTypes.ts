// netease-music 插件的「控制层结果」类型与纯函数。
// 与 plugins/netease-music/main.js 的 createController 返回契约保持一致，
// 让前端音乐岛 / Room 视图只依赖这些稳定字段，不直接解析 sidecar 文本。

export type MusicTrack = {
    songId?: number;
    name?: string;
    artists?: string;
    album?: string;
    duration?: string;
};

export type MusicControlState = {
    current?: MusicTrack | null;
    playback?: 'playing' | 'paused' | 'stopped';
};

/** 播放队列位置信息（插件 metadata.queue）。 */
export type MusicQueueInfo = {
    index?: number;
    size?: number;
    source?: string;
};

export type MusicControlResult = {
    ok?: boolean;
    intent?: 'search' | 'play' | 'next' | 'prev' | 'pause' | 'resume' | 'stop' | 'lyrics' | 'status' | string;
    message?: string;
    songId?: number;
    query?: string;
    track?: MusicTrack;
    tracks?: MusicTrack[];
    lyrics?: string;
    playbackUrl?: string;
    state?: MusicControlState;
    metadata?: {
        playbackAction?: 'play' | 'pause' | 'resume' | 'stop';
        playbackUrl?: string;
        track?: MusicTrack;
        state?: MusicControlState;
        /** 队列里还有下一首（插件 cfg.autoNext 开启时），前端播完自动续播。 */
        autoNext?: boolean;
        queue?: MusicQueueInfo;
    };
};

export type MusicUiStatus = 'idle' | 'working' | 'ok' | 'error';

/** 把任意 JSON（Wails 返回值）规整成 MusicControlResult；非对象返回 null。 */
export function normalizeMusicResult(raw: unknown): MusicControlResult | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as MusicControlResult;
}

/** 从 result 顶层或 metadata 里取播放地址。 */
export function musicPlaybackUrl(result: MusicControlResult | null): string {
    if (!result) return '';
    const raw = result.metadata?.playbackUrl ?? result.playbackUrl;
    return typeof raw === 'string' ? raw.trim() : '';
}

/** 从 result 顶层或 metadata 里取播放动作（play/pause/resume/stop）。 */
export function musicPlaybackAction(result: MusicControlResult | null): string {
    if (!result) return '';
    return String(result.metadata?.playbackAction ?? '').trim().toLowerCase();
}

/** 当前曲目展示名：「晴天 - 周杰伦」；无信息返回空串。 */
export function musicTrackLabel(track?: MusicTrack | null): string {
    if (!track) return '';
    const name = String(track.name || '').trim();
    const artist = String(track.artists || '').trim();
    return artist ? `${name} - ${artist}` : name;
}

/** 搜索词 → 直接点播的指令文案（交给 control 的 message）。 */
export function playCommandFor(query: string): string {
    const q = String(query || '').trim();
    if (!q) return '';
    return `播放 ${q}`;
}

/** 简洁状态文本。 */
export function musicStateText(status: MusicUiStatus): string {
    switch (status) {
        case 'working': return '处理中…';
        case 'ok': return '';
        case 'error': return '出错了';
        default: return '待机';
    }
}
