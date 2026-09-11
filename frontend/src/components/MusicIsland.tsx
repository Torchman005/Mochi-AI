import {FormEvent, useEffect, useRef, useState} from 'react';
import {
    MusicControlResult,
    MusicTrack,
    MusicUiStatus,
    musicPlaybackAction,
    musicStateText,
    musicTrackLabel,
    normalizeMusicResult,
} from '../musicTypes';

export type MusicIslandProps = {
    // 交给宿主执行 control 动作：rawMessage 是自然语言点歌指令（如「播放 晴天」）。
    onCommand: (message: string) => Promise<unknown>;
    // 最近一次插件结果（宿主在 invokePluginAction 后回填），驱动「正在播放」区。
    lastResult?: MusicControlResult | null;
    // 宿主当前是否正在播放插件音频（music 场景由 handlePluginPlaybackResult 驱动）。
    isPlaying?: boolean;
};

function prettyMessage(result: MusicControlResult | null): string {
    if (!result) return '';
    if (typeof result.message === 'string' && result.message.trim()) {
        return result.message.trim().slice(0, 160);
    }
    if (result.lyrics) return '（已返回歌词）';
    return '';
}

export function MusicIsland(props: MusicIslandProps) {
    const {onCommand, lastResult, isPlaying} = props;
    const [draft, setDraft] = useState('');
    const [status, setStatus] = useState<MusicUiStatus>('idle');
    const [busy, setBusy] = useState(false);
    const [statusText, setStatusText] = useState('');
    const [error, setError] = useState('');
    const [displayTracks, setDisplayTracks] = useState<MusicTrack[]>([]);
    const [expanded, setExpanded] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    // 外部结果变化 → 刷新「正在播放 / 搜索结果」区；有结果时自动展开。
    useEffect(() => {
        const result = normalizeMusicResult(lastResult);
        if (!result) return;
        const action = musicPlaybackAction(result);
        if (action) {
            setError('');
        }
        if (Array.isArray(result.tracks) && result.tracks.length > 0) {
            setDisplayTracks(result.tracks);
        }
        if (result.ok === false && result.message) {
            setError(result.message.slice(0, 200));
        }
        if (result.message || (result.tracks && result.tracks.length > 0) || playingLabelOf(result)) {
            setExpanded(true);
        }
    }, [lastResult]);

    function playingLabelOf(result: MusicControlResult | null | undefined): string {
        if (!result) return '';
        return musicTrackLabel(
            result.metadata?.state?.current
            || result.state?.current
            || result.metadata?.track
            || result.track,
        );
    }

    async function submit(message: string) {
        const text = String(message || '').trim();
        if (!text || busy) return;
        setBusy(true);
        setStatus('working');
        setStatusText('');
        setError('');
        try {
            const raw = await onCommand(text);
            const result = normalizeMusicResult(raw);
            if (result && result.message) {
                setStatusText(prettyMessage(result));
            }
            setStatus('ok');
        } catch (reason) {
            setError(String((reason as Error)?.message || reason));
            setStatus('error');
        } finally {
            setBusy(false);
        }
    }

    function onFormSubmit(event: FormEvent) {
        event.preventDefault();
        void submit(draft);
    }

    function quickPlay(track: MusicTrack) {
        const label = musicTrackLabel(track);
        const id = Number(track?.songId);
        if (label) {
            void submit(id > 0 ? `播放 ${id}` : label);
        }
    }

    const playingLabel = playingLabelOf(lastResult);

    function toggle() {
        if (!expanded && inputRef.current) {
            // 展开后聚焦点歌输入框。
            window.setTimeout(() => inputRef.current?.focus(), 60);
        }
        setExpanded((value) => !value);
    }

    return (
        <section className={`music-island${expanded ? ' expanded' : ' collapsed'}`} aria-label="音乐岛">
            <button type="button" className="music-island-head" onClick={toggle} aria-expanded={expanded}>
                <strong>♪ 音乐</strong>
                <span className="music-island-now">
                    {playingLabel || (displayTracks.length > 0 ? `${displayTracks.length} 首结果` : '点歌')}
                </span>
                <span className="music-state-tag">{expanded ? '收起 ▾' : '展开 ▸'}</span>
            </button>

            {expanded && (
                <>
                    <form className="music-request-form" onSubmit={onFormSubmit} noValidate>
                        <input
                            ref={inputRef}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            placeholder="播放 晴天 / 下一首 / 暂停 / 继续 / 停止 / 歌词"
                            autoComplete="off"
                            aria-label="点歌指令"
                        />
                        <button type="submit" disabled={busy || !draft.trim()} className="music-send">
                            {busy ? '…' : '点歌'}
                        </button>
                    </form>

                    {playingLabel && (
                        <div className="music-now-playing" aria-live="polite">
                            <span className="music-eq" aria-hidden="true">{isPlaying ? '♫' : '♪'}</span>
                            <div className="music-now-text">
                                <span className="music-now-title">{playingLabel}</span>
                                <span className="music-now-sub">
                                    {lastResult?.metadata?.state?.playback
                                        ? (lastResult.metadata.state.playback === 'paused' ? '已暂停' : '播放中')
                                        : (isPlaying ? '播放中' : '')}
                                    {lastResult?.metadata?.queue
                                        ? ` · ${(lastResult.metadata.queue.index ?? 0) + 1}/${lastResult.metadata.queue.size ?? 1}`
                                        : ''}
                                </span>
                            </div>
                            <div className="music-now-actions">
                                <button type="button" onClick={() => void submit('暂停')} disabled={!isPlaying || busy} aria-label="暂停" title="暂停">⏸</button>
                                <button type="button" onClick={() => void submit('下一首')} disabled={busy} aria-label="下一首" title="下一首">⏭</button>
                                <button type="button" onClick={() => void submit('停止')} disabled={(!isPlaying && !playingLabel) || busy} aria-label="停止" title="停止">⏹</button>
                            </div>
                        </div>
                    )}

                    {statusText && !error && <p className="music-note">{statusText}</p>}
                    {error && <p className="music-error">{error}</p>}

                    {displayTracks.length > 0 && (
                        <div className="music-track-list" aria-label="搜索结果">
                            {displayTracks.slice(0, 5).map((track, index) => {
                                const label = musicTrackLabel(track);
                                if (!label) return null;
                                const isCurrent = Boolean(lastResult?.track && lastResult.track.songId === track.songId);
                                return (
                                    <button
                                        type="button"
                                        key={`${track.songId}-${index}`}
                                        className={`music-track${isCurrent ? ' current' : ''}`}
                                        onClick={() => quickPlay(track)}
                                    >
                                        <span className="music-track-index">{index + 1}</span>
                                        <span className="music-track-label">{label}</span>
                                        {track.duration && <span className="music-track-duration">{track.duration}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
