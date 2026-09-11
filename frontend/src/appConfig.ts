import {ViewKey} from './appTypes';
import {clamp} from './utils';

export const emotionLabel: Record<string, string> = {
    neutral: '待机',
    happy: '开心',
    focused: '专注',
    thinking: '思考',
    sad: '低落',
    surprised: '惊讶',
};

export const taskStatusLabel: Record<string, string> = {
    queued: '排队中',
    running: '执行中',
    waiting_for_input: '等待补充',
    waiting_for_approval: '待审批',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
};

export const PET_MODE_KEY = 'yuyu.petMode';
export const PET_SCALE_KEY = 'yuyu.petScale';
export const CONTINUOUS_VOICE_KEY = 'yuyu.continuousVoice';
export const CONVERSATION_MODE_KEY = 'yuyu.conversationMode';
export const SPEECH_LANGUAGE_KEY = 'yuyu.speechLanguage';
export const LEGACY_PET_MODE_KEY = 'mochi.petMode';
export const LEGACY_PET_SCALE_KEY = 'mochi.petScale';
export const LEGACY_CONTINUOUS_VOICE_KEY = 'mochi.continuousVoice';
export const PET_CONTROLS_SHORTCUT = 'Ctrl + Shift + M';
export const PET_BASE_WIDTH = 380;
export const PET_BASE_HEIGHT = 560;
export const PET_MIN_SCALE = 0.6;
export const PET_MAX_SCALE = 1.8;
export const PET_SCALE_STEP = 0.08;
export const PET_HIT_INSET_X = 0.06;
export const PET_HIT_INSET_TOP = 0.02;
export const PET_HIT_INSET_BOTTOM = 0.02;
export const DESKTOP_PET_NAME = (
    (import.meta.env.VITE_YUYU_DESKTOP_PET_NAME as string | undefined)
    || (import.meta.env.VITE_DESKTOP_PET_NAME as string | undefined)
    || ''
).trim() || 'Yuyu';
export const DESKTOP_COMPANION_CONVERSATION_ID = 'desktop-companion';
export const SPEECH_OUTPUT_MODE = ((import.meta.env.VITE_SPEECH_OUTPUT_MODE as string | undefined) || 'cloud').trim().toLowerCase();
export const ALLOW_SYSTEM_TTS_FALLBACK = ((import.meta.env.VITE_ALLOW_SYSTEM_TTS_FALLBACK as string | undefined) || 'false').trim().toLowerCase() === 'true';
export const ENABLE_STREAMING_TTS = ((import.meta.env.VITE_ENABLE_STREAMING_TTS as string | undefined) || 'false').trim().toLowerCase() === 'true';
export const ENABLE_GPT_SOVITS_STREAMING = ((import.meta.env.VITE_ENABLE_GPT_SOVITS_STREAMING as string | undefined) || 'false').trim().toLowerCase() === 'true';
export const ENABLE_REALTIME_SPEECH = ((import.meta.env.VITE_REALTIME_SPEECH as string | undefined) || 'false').trim().toLowerCase() === 'true';
export const SHOW_SPEECH_DEBUG = ((import.meta.env.VITE_SHOW_SPEECH_DEBUG as string | undefined) || 'false').trim().toLowerCase() === 'true';
export const ASR_PROVIDER = ((import.meta.env.VITE_ASR_PROVIDER as string | undefined) || 'browser').trim().toLowerCase();
export const ASR_LANGUAGE = (() => {
    const value = ((import.meta.env.VITE_ASR_LANGUAGE as string | undefined) || 'zh').trim().toLowerCase();
    return value === 'auto' ? 'auto' : value.startsWith('ja') ? 'ja' : 'zh';
})();
export const DEFAULT_SPEECH_LANGUAGE = ((import.meta.env.VITE_SPEECH_LANGUAGE as string | undefined) || 'zh').trim().toLowerCase().startsWith('ja') ? 'ja' : 'zh';
export const PROACTIVE_ENABLED = ((import.meta.env.VITE_PROACTIVE_ENABLED as string | undefined) || 'true').trim().toLowerCase() === 'true';
export const PROACTIVE_IDLE_MINUTES = Number((import.meta.env.VITE_PROACTIVE_IDLE_MINUTES as string | undefined) || '8');
export const PROACTIVE_COOLDOWN_MINUTES = Number((import.meta.env.VITE_PROACTIVE_COOLDOWN_MINUTES as string | undefined) || '15');
export const PROACTIVE_QUIET_HOURS = ((import.meta.env.VITE_PROACTIVE_QUIET_HOURS as string | undefined) || '01:00-09:00').trim();
export const PROACTIVE_CHECK_SECONDS = Number((import.meta.env.VITE_PROACTIVE_CHECK_SECONDS as string | undefined) || '30');
export const PROACTIVE_FREE_MODE_ENABLED = ((import.meta.env.VITE_PROACTIVE_FREE_MODE_ENABLED as string | undefined) || 'true').trim().toLowerCase() === 'true';
export const PROACTIVE_PLUGIN_CONTEXT_HINT_MINUTES = Number((import.meta.env.VITE_PROACTIVE_PLUGIN_CONTEXT_HINT_MINUTES as string | undefined) || '20');
export const PROACTIVE_CHANCE_PERCENT = clamp(Number((import.meta.env.VITE_PROACTIVE_CHANCE_PERCENT as string | undefined) || '65'), 0, 100);
export const PROACTIVE_MAX_PER_HOUR = Number((import.meta.env.VITE_PROACTIVE_MAX_PER_HOUR as string | undefined) || '8');
export const FOLLOW_UP_ENABLED = ((import.meta.env.VITE_FOLLOW_UP_ENABLED as string | undefined) || 'true').trim().toLowerCase() === 'true';
export const FOLLOW_UP_CHANCE_PERCENT = clamp(Number((import.meta.env.VITE_FOLLOW_UP_CHANCE_PERCENT as string | undefined) || '55'), 0, 100);
export const FOLLOW_UP_DELAY_MS = Number((import.meta.env.VITE_FOLLOW_UP_DELAY_MS as string | undefined) || '1800');
export const FOLLOW_UP_COOLDOWN_MS = Number((import.meta.env.VITE_FOLLOW_UP_COOLDOWN_MS as string | undefined) || '12000');
export const MAX_VISIBLE_CHAT_ROUNDS = Number((import.meta.env.VITE_MAX_VISIBLE_CHAT_ROUNDS as string | undefined) || '20');
export const DEFAULT_CONVERSATION_MODE = ((import.meta.env.VITE_CONVERSATION_MODE as string | undefined) || 'manual').trim().toLowerCase() === 'free' ? 'free' : 'manual';
export const VOICE_RELISTEN_DELAY_MS = 280;
export const VOICE_LOOP_MAX_EMPTY_TURNS = 4;
export const VOICE_LOOP_EMPTY_BACKOFF_MS = 900;
export const VOICE_LOOP_MAX_BACKOFF_MS = 3500;
export const VOICE_MIN_CHARS = 2;
export const VOICE_LOOP_MIN_CHARS = 3;
export const VOICE_LOW_CONFIDENCE = 0.35;
export const VOICE_GATE_ENABLED = ((import.meta.env.VITE_VOICE_GATE_ENABLED as string | undefined) || 'true').trim().toLowerCase() === 'true';
export const VOICE_GATE_THRESHOLD = Number((import.meta.env.VITE_VOICE_GATE_THRESHOLD as string | undefined) || '0.035');
export const VOICE_GATE_HOLD_MS = Number((import.meta.env.VITE_VOICE_GATE_HOLD_MS as string | undefined) || '160');
export const VOICE_GATE_TIMEOUT_MS = Number((import.meta.env.VITE_VOICE_GATE_TIMEOUT_MS as string | undefined) || '12000');
export const VOICE_AUTO_SUBMIT_SILENCE_MS = Number((import.meta.env.VITE_VOICE_AUTO_SUBMIT_SILENCE_MS as string | undefined) || '900');
export const VOICE_MAX_UTTERANCE_MS = Number((import.meta.env.VITE_VOICE_MAX_UTTERANCE_MS as string | undefined) || '15000');
export const BARGE_IN_MIN_CHARS = 2;
export const BARGE_IN_ECHO_SIMILARITY = 0.68;

export const REVIEW_ACTION_NAMES = new Set(['show_diff', 'list_changes', 'open_changes', 'accept_changes', 'reject_changes', 'open_in_ide', 'open_workspace']);
// 详情模式的导航：全部以「右侧抽屉」叠加在房间之上，不再有独立的列表页
// （因此不含 chat / skins —— 聊天就在房间右侧的聊天岛里，形象就在房间舞台上）。
export const WEB_NAV: { key: ViewKey; label: string; icon: string }[] = [
    {key: 'room', label: '房间', icon: '♥'},
    {key: 'model', label: '模型信息', icon: '◇'},
    {key: 'plugins', label: '插件管理', icon: '✧'},
    {key: 'tasks', label: '后台任务', icon: '▣'},
    {key: 'logs', label: '桌宠日志', icon: '☰'},
    {key: 'settings', label: '设置', icon: '⚙'},
];
