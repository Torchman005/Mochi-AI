import {app} from '../wailsjs/go/models';
import {AvatarPerformance} from './components/Live2DStage';

export type Message = app.CompanionMessage;
export type ChatResponse = app.ChatReply;

export type SpeechStreamEvent = {
    sessionId?: string;
    audioBase64?: string;
    contentType?: string;
    error?: string;
    provider?: string;
    phase?: string;
    elapsedMs?: number;
    detail?: string;
};

export type SpeechMetric = {
    phase: string;
    elapsedMs?: number;
    detail?: string;
};

export type FishLiveProbeResult = {
    ok?: boolean;
    error?: string;
    events?: string[];
    elapsedMs?: number;
    audioSize?: number;
};

export type ASRReply = {
    text?: string;
    provider?: string;
    language?: string;
    duration?: number;
    error?: string;
};

export type ChatStreamEvent = {
    type?: string;
    content?: string;
    tool_id?: string;
    tool_name?: string;
    emotion?: string;
    mood?: string;
    energy?: number;
    valence?: number;
    dominance?: number;
    gesture?: string;
    hand?: string;
};

export type PerformanceHint = {
    mood?: AvatarPerformance['mood'];
    energy?: number;
    valence?: number;
    dominance?: number;
    gesture?: string;
    hand?: AvatarPerformance['hand'];
};

export type ViewKey = 'room' | 'chat' | 'skins' | 'model' | 'plugins' | 'tasks' | 'settings' | 'logs';

export type PluginChange = {
    status?: string;
    kind?: string;
    path?: string;
    oldPath?: string;
    directory?: boolean;
    nestedRepo?: boolean;
    nestedCount?: number;
    nestedFiles?: PluginChange[];
};
