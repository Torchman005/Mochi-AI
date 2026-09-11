import {RefObject, WheelEvent, useEffect, useRef, useState} from 'react';
import {Quit, WindowMinimise} from '../../wailsjs/runtime/runtime';
import {DESKTOP_PET_NAME, emotionLabel} from '../appConfig';
import {Message} from '../appTypes';
import {MusicControlResult} from '../musicTypes';
import {AvatarPerformance, Live2DStage} from './Live2DStage';
import {MusicIsland} from './MusicIsland';

export const ROOM_EMOTIONS = ['neutral', 'happy', 'thinking', 'focused', 'surprised', 'sad'];

// 点击角色的即时反应：一句短台词 + 对应情绪，让「戳一下」有真实反馈。
// 刻意使用情绪白名单内的取值，保证与 Live2DStage 的表达式映射一致。
const STAGE_TAP_REACTIONS: {text: string; emotion: string}[] = [
    {text: '诶？主人干嘛戳我呀~', emotion: 'surprised'},
    {text: '嘿嘿，被主人摸到了。', emotion: 'happy'},
    {text: '唔…在忙啦，等一下下。', emotion: 'focused'},
    {text: '主人今天怎么这么黏人呀？', emotion: 'happy'},
    {text: '别戳啦，会痒的嘛。', emotion: 'surprised'},
    {text: '嗯…让我想想哦。', emotion: 'thinking'},
];

// 反应台词/表情的持续时间；到时后被外部 emotion 覆盖（或由 effect 清除）。
const STAGE_TAP_DURATION_MS = 3000;
// 点击反馈动效（缩放脉冲）时长，需与 CSS 动画保持一致。
const STAGE_TAP_PULSE_MS = 620;

export type RoomViewProps = {
    emotion: string;
    voiceStatus: string;
    mouthLevel: number;
    petScale: number;
    performance: AvatarPerformance;
    assistantLine: string;
    agentStatus: string;
    agentProvider: string;

    messages: Message[];
    feedRef?: RefObject<HTMLDivElement>;
    composer: React.ReactNode;

    // 陪伴统计来源（均为现有数据，无需后端新增接口）：
    // 首次对话时间用于算「陪伴天数」，会话/消息条数用于算互动量。
    conversationCount: number;
    firstConversationAt?: string;

    musicEnabled: boolean;
    musicResult: MusicControlResult | null;
    musicPlaying: boolean;
    onMusicCommand: (message: string) => Promise<unknown>;

    onStageWheel: (event: WheelEvent<HTMLElement>) => void;
    onPickEmotion: (emotion: string) => void;
    onToggleSidebar: () => void;
};

export function RoomView(props: RoomViewProps) {
    const {
        emotion, voiceStatus, mouthLevel, petScale, performance, assistantLine,
        agentStatus, agentProvider,
        messages, composer,
        conversationCount, firstConversationAt,
        musicEnabled, musicResult, musicPlaying, onMusicCommand,
        onStageWheel, onPickEmotion, onToggleSidebar,
    } = props;

    const isSpeaking = voiceStatus === 'speaking';

    // 点击角色的即时反应（本地临时覆盖，不写入后端情绪）。
    const [tapReaction, setTapReaction] = useState<{text: string; emotion: string} | null>(null);
    const [tapPulse, setTapPulse] = useState(false);
    const tapReactionTimerRef = useRef<number | null>(null);

    // 外部情绪一旦变化（用户点表情 chip、或 LLM 情绪事件、或发言中），立即让出控制权，
    // 避免本地反应覆盖真实情绪。
    useEffect(() => {
        setTapReaction(null);
    }, [emotion]);

    // 脉冲动效由 effect 自管生命周期：tapPulse 置真后计时复位，卸载/重触发时自动清理，
    // 避免手工维护多个定时器造成泄漏。
    useEffect(() => {
        if (!tapPulse) {
            return;
        }
        const timer = window.setTimeout(() => setTapPulse(false), STAGE_TAP_PULSE_MS);
        return () => window.clearTimeout(timer);
    }, [tapPulse]);

    // 卸载时清理反应定时器，避免对已卸载组件 setState。
    useEffect(() => () => {
        if (tapReactionTimerRef.current !== null) {
            window.clearTimeout(tapReactionTimerRef.current);
        }
    }, []);

    function handleStageTap() {
        const pick = STAGE_TAP_REACTIONS[Math.floor(Math.random() * STAGE_TAP_REACTIONS.length)];
        setTapReaction(pick);

        // 先复位再置真，保证连续点击时 CSS 动画能重新触发。
        setTapPulse(false);
        window.requestAnimationFrame(() => setTapPulse(true));

        if (tapReactionTimerRef.current !== null) {
            window.clearTimeout(tapReactionTimerRef.current);
        }
        tapReactionTimerRef.current = window.setTimeout(() => setTapReaction(null), STAGE_TAP_DURATION_MS);
    }

    // 点击反应期间由本地情绪驱动形象，其余时间用外部情绪。
    const stageEmotion = tapReaction ? tapReaction.emotion : emotion;
    // 气泡只在两种情况下出现：正在说话（真实台词），或刚被点击（反应台词）。
    // 注意不能仅以"有文本"为条件——assistantLine 在说完后仍会保留，会导致气泡常驻。
    const stageLine = (isSpeaking && assistantLine.trim())
        ? assistantLine
        : (tapReaction ? tapReaction.text : '');

    // 陪伴天数：从首次对话算起（含当天为第 1 天）。数据缺失时不显示，避免出现「第 NaN 天」。
    const companionDays = (() => {
        if (!firstConversationAt) {
            return null;
        }
        const started = new Date(firstConversationAt).getTime();
        if (!Number.isFinite(started)) {
            return null;
        }
        const days = Math.floor((Date.now() - started) / 86400000) + 1;
        return days > 0 ? days : 1;
    })();

    return (
        <div className="room-view">
            {/* 中置舞台：角色为王的视觉核心 */}
            <section
                className="room-stage"
                aria-label="Yuyu 房间舞台"
                onWheel={onStageWheel}
                style={{'--room-scale': petScale} as React.CSSProperties}
            >
                <div className="room-stage-actions">
                    <div className="room-emotion-chip-row" aria-label="表情切换">
                        {ROOM_EMOTIONS.map((key) => (
                            <button
                                type="button"
                                key={key}
                                className={`room-emotion-chip${emotion === key ? ' active' : ''}`}
                                onClick={() => onPickEmotion(key)}
                            >
                                {emotionLabel[key] ?? key}
                            </button>
                        ))}
                    </div>
                    <span className={`pill agent-${agentStatus}`}>{agentStatus} · {agentProvider}</span>
                    <span className="room-window-controls">
                        <button type="button" className="window-button" onClick={WindowMinimise} aria-label="最小化">−</button>
                        <button type="button" className="window-button window-close" onClick={Quit} aria-label="关闭">×</button>
                    </span>
                </div>

                {/* 点击角色区域触发互动；事件只绑在此区域，避免与顶部按钮/滚轮缩放冲突 */}
                <div
                    className={`room-stage-live2d${tapPulse ? ' is-tapped' : ''}`}
                    onClick={handleStageTap}
                    role="button"
                    tabIndex={0}
                    aria-label="点击和 Yuyu 互动"
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleStageTap();
                        }
                    }}
                >
                    <Live2DStage
                        emotion={stageEmotion}
                        isSpeaking={isSpeaking}
                        mouthLevel={mouthLevel}
                        petScale={petScale}
                        performance={performance}
                    />
                    {stageLine.trim() && (
                        <div className="room-speech-bubble" aria-live="polite"><p>{stageLine}</p></div>
                    )}
                </div>

                <div className="room-stage-footer">
                    <span>滚轮缩放 · 点击角色逗逗她 · 点击表情换心情</span>
                    <div className="room-stage-footer-actions">
                        <button type="button" className="ghost-button" onClick={onToggleSidebar}>☰ 房间门廊</button>
                    </div>
                </div>

                {/* 状态岛：角色内在状态与陪伴统计（数据全部来自现有会话/消息，无需后端新增接口） */}
                <aside className="room-status-island" aria-label="角色状态">
                    <span className={`room-status-emotion emotion-${stageEmotion}`}>
                        {emotionLabel[stageEmotion] ?? stageEmotion}
                    </span>
                    <span className="room-status-metrics">
                        {companionDays !== null && <b title="从首次对话算起">陪伴 {companionDays} 天</b>}
                        <b title="累计对话数">{conversationCount} 次对话</b>
                        <b title="当前会话消息数">{messages.length} 条消息</b>
                    </span>
                </aside>
            </section>

            {/* 右浮岛：聊天岛（含输入）在下，音乐岛在上 */}
            <aside className="room-islands" aria-label="房间面板">
                {musicEnabled && (
                    <MusicIsland onCommand={onMusicCommand} lastResult={musicResult} isPlaying={musicPlaying} />
                )}

                <section className="chat-island" aria-label="与 Yuyu 聊天">
                    <header className="chat-island-head">
                        <div className="chat-island-title">
                            <strong>{DESKTOP_PET_NAME}</strong>
                            <span className={`pill agent-${agentStatus}`}>
                                {voiceStatus === 'speaking' ? '说话中' : voiceStatus === 'listening' ? '聆听中' : '待机'} · {agentProvider}
                            </span>
                        </div>
                    </header>

                    <div className="room-message-feed" ref={props.feedRef}>
                        {messages.length === 0 && (
                            <div className="empty-state room-chat-empty">
                                <strong>今天想让 Yuyu 做什么？</strong>
                                <span>聊天、写代码、点歌，都可以从这一句开始。</span>
                            </div>
                        )}
                        {messages.map((message) => (
                            <article className={`message room-message ${message.role}`} key={message.id}>
                                <span className="message-role">{message.role === 'user' ? '你' : DESKTOP_PET_NAME}</span>
                                <p>{message.content}</p>
                            </article>
                        ))}
                    </div>

                    {composer}
                </section>
            </aside>
        </div>
    );
}
