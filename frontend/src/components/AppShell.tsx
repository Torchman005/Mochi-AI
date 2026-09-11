import {FormEvent, WheelEvent, RefObject} from 'react';
import {Quit, WindowMinimise} from '../../wailsjs/runtime/runtime';
import {app, db} from '../../wailsjs/go/models';
import {DESKTOP_PET_NAME, PET_CONTROLS_SHORTCUT, WEB_NAV} from '../appConfig';
import {Message, ViewKey} from '../appTypes';
import {AvatarPerformance, Live2DStage} from './Live2DStage';

type ComposerProps = {
    isTextInputOpen: boolean;
    draft: string;
    isSending: boolean;
    voiceStatus: string;
    freeConversationMode: boolean;
    effectiveContinuousVoiceMode: boolean;
    inputRef: RefObject<HTMLInputElement>;
    onDraftChange: (value: string) => void;
    onToggleText: () => void;
    onVoice: () => void;
    onSubmit: (event: FormEvent) => void;
};

export function ChatComposer(props: ComposerProps) {
    return (
        <form className={props.isTextInputOpen ? 'composer composer-open' : 'composer'} onSubmit={props.onSubmit} noValidate>
            {props.isTextInputOpen && (
                <input
                    ref={props.inputRef}
                    value={props.draft}
                    onChange={(event) => props.onDraftChange(event.target.value)}
                    placeholder={`和 ${DESKTOP_PET_NAME} 说点什么...`}
                    autoComplete="off"
                />
            )}
            <button
                type="button"
                className="text-button"
                onClick={props.onToggleText}
                aria-pressed={props.isTextInputOpen}
            >
                <span aria-hidden="true">T</span>
                <span>文字</span>
            </button>
            <button
                type="button"
                className={`voice-button voice-${props.voiceStatus}`}
                onClick={props.onVoice}
                disabled={props.isSending || props.voiceStatus === 'thinking'}
            >
                <span aria-hidden="true">{props.voiceStatus === 'listening' ? '■' : '♪'}</span>
                <span>{props.voiceStatus === 'listening' ? '停止' : (props.freeConversationMode ? '自由' : props.effectiveContinuousVoiceMode ? '连续' : '语音')}</span>
            </button>
            {props.isTextInputOpen && (
                <button type="submit" disabled={props.isSending || !props.draft.trim()}>
                    <span aria-hidden="true">→</span>
                    <span>{props.isSending ? '发送中' : '发送'}</span>
                </button>
            )}
        </form>
    );
}

type PetModeViewProps = {
    emotion: string;
    voiceStatus: string;
    mouthLevel: number;
    petScale: number;
    performance: AvatarPerformance;
    assistantLine: string;
    controlsOpen: boolean;
    composer: JSX.Element;
    onWheel: (event: WheelEvent<HTMLElement>) => void;
    onExitPetMode: () => void;
};

export function PetModeView(props: PetModeViewProps) {
    return (
        <section className="stage" aria-label="Yuyu 桌宠" onWheel={props.onWheel}>
            <Live2DStage
                emotion={props.emotion}
                isSpeaking={props.voiceStatus === 'speaking'}
                mouthLevel={props.mouthLevel}
                petScale={props.petScale}
                performance={props.performance}
            />
            {props.voiceStatus === 'speaking' && props.assistantLine.trim() && (
                <div className="pet-subtitle" aria-live="polite"><p>{props.assistantLine}</p></div>
            )}
            {props.controlsOpen ? (
                <div className="pet-controls" aria-label="桌宠控制">
                    {props.composer}
                    <div className="pet-mode-actions">
                        <button type="button" className="pet-mode-toggle" onClick={props.onExitPetMode}>返回详情</button>
                    </div>
                    <span className="pet-shortcut">{PET_CONTROLS_SHORTCUT} · V 语音输入</span>
                </div>
            ) : null}
        </section>
    );
}

type WebSidebarProps = {
    conversations: db.Conversation[];
    activeConversationId: string;
    activeView: ViewKey;
    agentStatus: string;
    agentProvider: string;
    sidebarVisible?: boolean;
    onNewConversation: () => void;
    onSelectConversation: (id: string) => void;
    onSelectView: (view: ViewKey) => void;
    onPetMode: () => void;
};

export function WebSidebar(props: WebSidebarProps) {
    const activeNav = WEB_NAV.find((item) => item.key === props.activeView);

    return (
        <aside className={`web-sidebar${props.sidebarVisible ? ' sidebar-visible' : ''}`}>
            <div className="web-brand">
                <span className="web-brand-logo">Y</span>
                <div className="web-brand-text">
                    <strong>{DESKTOP_PET_NAME}</strong>
                    <small>Desktop Companion</small>
                </div>
            </div>
            <button type="button" className="new-conversation" onClick={props.onNewConversation}>
                <span aria-hidden="true">＋</span>
                <span>新对话</span>
            </button>
            <div className="sidebar-current">
                <span>当前房间</span>
                <strong>{activeNav?.label ?? '对话'}</strong>
            </div>
            <div className="conversation-list" aria-label="对话历史">
                {props.conversations.length === 0 && <div className="empty-state small">暂无历史对话</div>}
                {props.conversations.map((conv) => (
                    <button
                        key={conv.id}
                        type="button"
                        className={`conversation-item${props.activeConversationId === conv.id ? ' active' : ''}`}
                        onClick={() => props.onSelectConversation(conv.id)}
                    >
                        <span className="conversation-title">{conv.title || '未命名对话'}</span>
                    </button>
                ))}
            </div>
            <nav className="web-nav" aria-label="主导航">
                {WEB_NAV.map((item) => (
                    <button
                        key={item.key}
                        type="button"
                        className={`web-nav-item${props.activeView === item.key ? ' active' : ''}`}
                        onClick={() => props.onSelectView(item.key)}
                    >
                        <span className="web-nav-icon" aria-hidden="true">{item.icon}</span>
                        <span>{item.label}</span>
                    </button>
                ))}
            </nav>
            <div className="web-sidebar-foot">
                <span className={`pill agent-${props.agentStatus}`}>{props.agentStatus} · {props.agentProvider}</span>
                <button type="button" className="ghost-button" onClick={props.onPetMode}>桌宠模式</button>
                <small className="web-version">Yuyu-Mind2 · v0.1</small>
            </div>
        </aside>
    );
}

type ChatViewProps = {
    messages: Message[];
    feedRef: RefObject<HTMLDivElement>;
    voiceStatus: string;
    agentStatus: string;
    agentProvider: string;
    providerError: string;
    error: string;
    voiceError: string;
    composer: JSX.Element;
};

export function ChatView(props: ChatViewProps) {
    const stateText = props.voiceStatus === 'speaking' ? '朗读中' : props.voiceStatus === 'listening' ? '聆听中' : '待机';
    const lastAssistant = [...props.messages].reverse().find((message) => message.role === 'assistant');

    return (
        <section className="chat-panel" aria-label={`${DESKTOP_PET_NAME} chat`}>
            <header>
                <div className="header-title">
                    <h1>{DESKTOP_PET_NAME}</h1>
                    <p className="eyebrow">{stateText} · 桌面助手</p>
                </div>
                <div className="header-actions">
                    <span className={`pill agent-${props.agentStatus}`}>{props.agentStatus} · {props.agentProvider}</span>
                    <button type="button" className="window-button" onClick={WindowMinimise} aria-label="最小化">−</button>
                    <button type="button" className="window-button window-close" onClick={Quit} aria-label="关闭">×</button>
                </div>
            </header>
            <div className="chat-workbench">
                <div className="chat-stream-card">
                    <div className="message-feed" ref={props.feedRef}>
                        {props.messages.length === 0 && (
                            <div className="empty-state chat-empty">
                                <strong>今天想让 Yuyu 做什么？</strong>
                                <span>聊天、写代码、看任务进度，都可以从这一句开始。</span>
                            </div>
                        )}
                        {props.messages.map((message) => (
                            <article className={`message ${message.role}`} key={message.id}>
                                <span className="message-role">{message.role === 'user' ? '你' : DESKTOP_PET_NAME}</span>
                                <p>{message.content}</p>
                            </article>
                        ))}
                    </div>
                    {props.providerError && <div className="error">模型状态：{props.providerError}</div>}
                    {props.error && <div className="error">{props.error}</div>}
                    {props.voiceError && <div className="error">{props.voiceError}</div>}
                    {props.composer}
                </div>

                <aside className="companion-side-panel" aria-label="会话状态">
                    <div className="mini-profile">
                        <span className="mini-avatar">Y</span>
                        <div>
                            <strong>{DESKTOP_PET_NAME}</strong>
                            <span>{stateText}</span>
                        </div>
                    </div>
                    <div className="side-metrics">
                        <div><span>消息</span><strong>{props.messages.length}</strong></div>
                        <div><span>模型</span><strong>{props.agentProvider}</strong></div>
                        <div><span>状态</span><strong>{props.agentStatus}</strong></div>
                    </div>
                    <div className="side-card">
                        <span>最近回复</span>
                        <p>{lastAssistant?.content || '还没有回复。先发一句话，让对话开始。'}</p>
                    </div>
                    <div className="quick-prompts" aria-label="快捷提示">
                        <span>可以试试</span>
                        <span className="quick-prompt-chip">整理插件状态</span>
                        <span className="quick-prompt-chip">查看后台任务</span>
                        <span className="quick-prompt-chip">打开桌宠模式</span>
                    </div>
                </aside>
            </div>
        </section>
    );
}

type SkinsViewProps = {
    emotion: string;
    voiceStatus: string;
    mouthLevel: number;
    petScale: number;
    performance: AvatarPerformance;
};

export function SkinsView(props: SkinsViewProps) {
    return (
        <section className="web-view skins-view">
            <h2 className="web-view-title">外观 / Live2D 皮肤</h2>
            <div className="skin-preview">
                <Live2DStage
                    emotion={props.emotion}
                    isSpeaking={props.voiceStatus === 'speaking'}
                    mouthLevel={props.mouthLevel}
                    petScale={props.petScale}
                    performance={props.performance}
                />
            </div>
            <div className="empty-state">皮肤体系待接入。切换不同 Cubism 模型源后，可在此选择形象。</div>
        </section>
    );
}

export function ModelView(props: {agentProvider: string; agentStatus: string; providerError: string}) {
    return (
        <section className="web-view model-view">
            <h2 className="web-view-title">模型信息</h2>
            <div className="info-card"><b>对话模型（LLM）</b><span>{props.agentProvider} · {props.agentStatus}</span></div>
            <div className="info-card"><b>语音合成（TTS）</b><span>GPT-SoVITS · 本地 · 音色复刻</span></div>
            <div className="info-card"><b>语音识别（ASR）</b><span>SenseVoice · 本地</span></div>
            <div className="info-card"><b>视觉</b><span>未接入</span></div>
            {props.providerError && <div className="error">模型状态：{props.providerError}</div>}
        </section>
    );
}
