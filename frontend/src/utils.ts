import {AvatarPerformance} from './components/Live2DStage';

export function canUseWailsRuntime() {
    return Boolean((window as any).runtime);
}

export function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

export function readStoredPetScale() {
    const value = Number(localStorage.getItem('yuyu.petScale') ?? localStorage.getItem('mochi.petScale'));
    if (!Number.isFinite(value)) {
        return 1;
    }
    return clamp(value, 0.6, 1.8);
}

export function isEditableTarget(target: EventTarget | null) {
    const element = target as HTMLElement | null;
    return Boolean(element?.closest('input, textarea, [contenteditable="true"]'));
}

export function visibleChatMessages<T extends { role?: string }>(items: T[], maxRounds: number) {
    if (!Number.isFinite(maxRounds) || maxRounds <= 0) {
        return items;
    }

    const userIndexes = items
        .map((message, index) => message.role === 'user' ? index : -1)
        .filter((index) => index >= 0);
    if (userIndexes.length <= maxRounds) {
        return items;
    }

    return items.slice(userIndexes[userIndexes.length - maxRounds]);
}

export function decodeBase64Audio(base64: string) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

export function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = String(reader.result || '');
            resolve(result.includes(',') ? result.split(',')[1] : result);
        };
        reader.onerror = () => reject(reader.error || new Error('read blob failed'));
        reader.readAsDataURL(blob);
    });
}

export function encodeWavPCM(float32: Float32Array, sampleRate: number): ArrayBuffer {
    const buffer = new ArrayBuffer(44 + float32.length * 2);
    const view = new DataView(buffer);
    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + float32.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, float32.length * 2, true);
    let offset = 44;
    for (let i = 0; i < float32.length; i += 1, offset += 2) {
        const sample = Math.max(-1, Math.min(1, float32[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return buffer;
}

export async function webmToWav16kMono(blob: Blob): Promise<{base64: string; contentType: string}> {
    const arrayBuffer = await blob.arrayBuffer();
    const OfflineCtx = (window as any).OfflineAudioContext;
    const AudioCtxClass = (window as any).AudioContext || (window as any).webkitAudioContext;
    const decodeCtx = (OfflineCtx ? new OfflineCtx(1, 1, 16000) : new AudioCtxClass());
    const decoded: AudioBuffer = await new Promise((resolve, reject) => {
        const promise = decodeCtx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
        if (promise && typeof promise.then === 'function') promise.then(resolve).catch(reject);
    });
    const targetRate = 16000;
    const duration = decoded.duration;
    const frameCount = Math.max(1, Math.ceil(duration * targetRate));
    const offline = new OfflineCtx(1, frameCount, targetRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered: AudioBuffer = await offline.startRendering();
    const pcm = rendered.getChannelData(0);
    const wav = encodeWavPCM(pcm, targetRate);
    const wavBlob = new Blob([wav], {type: 'audio/wav'});
    return {base64: await blobToBase64(wavBlob), contentType: 'audio/wav'};
}

export function normalizeSpeechLanguage(value: string | null | undefined) {
    return String(value || '').trim().toLowerCase().startsWith('zh') ? 'zh' : 'ja';
}

export function speechRecognitionLang(language: string) {
    return normalizeSpeechLanguage(language) === 'zh' ? 'zh-CN' : 'ja-JP';
}

export function asrRecognitionLanguage(speechLanguage: string) {
    const value = ((import.meta.env.VITE_ASR_LANGUAGE as string | undefined) || 'zh').trim().toLowerCase();
    const asrLanguage = value === 'auto' ? 'auto' : value.startsWith('ja') ? 'ja' : 'zh';
    return asrLanguage === 'auto' ? normalizeSpeechLanguage(speechLanguage) : asrLanguage;
}

export function asrProviderLanguage(speechLanguage: string) {
    const value = ((import.meta.env.VITE_ASR_LANGUAGE as string | undefined) || 'zh').trim().toLowerCase();
    return value === 'auto' ? '' : asrRecognitionLanguage(speechLanguage);
}

export function isInterruptedPlaybackError(reason: unknown) {
    const message = String((reason as any)?.message || reason || '').toLowerCase();
    const name = String((reason as any)?.name || '').toLowerCase();
    return name === 'aborterror' || message.includes('interrupted') || message.includes('abort');
}

export function isWithinQuietHours(value: string) {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(value || '');
    if (!match) return false;
    const [, sh, sm, eh, em] = match;
    const start = Number(sh) * 60 + Number(sm);
    const end = Number(eh) * 60 + Number(em);
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    if (start === end) return false;
    if (start < end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end;
}

export function normalizeSpeechText(value: string) {
    return String(value || '')
        .trim()
        .replace(/[\s，。！？、,.!?~～"'“”‘’：:；;（）()[\]{}<>《》]/g, '')
        .toLowerCase();
}

export function textSimilarity(left: string, right: string) {
    const a = normalizeSpeechText(left);
    const b = normalizeSpeechText(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const short = a.length <= b.length ? a : b;
    const long = a.length > b.length ? a : b;
    if (long.includes(short)) return short.length / long.length;
    let common = 0;
    for (const ch of short) {
        if (long.includes(ch)) common += 1;
    }
    return common / Math.max(long.length, 1);
}

export function isLikelyNoiseTranscript(text: string) {
    const normalized = normalizeSpeechText(text);
    if (!normalized) return true;
    const noise = new Set([
        '啊', '呃', '额', '嗯', '唔', '哦', '喔', '诶', '欸', '哎', '唉',
        '哈', '哈哈', '呵呵', '嗯嗯', '啊啊', '呃呃',
        'um', 'uh', 'hmm', 'mmm', 'ah', 'oh',
    ]);
    if (noise.has(normalized)) return true;
    return /^[啊呃额嗯唔哦喔诶欸哎唉哈呵]+$/.test(normalized) && normalized.length <= 4;
}

export function isUsableVoiceTranscript(text: string, confidence = 0, options: {fromLoop?: boolean; assistantLine?: string} = {}) {
    const trimmed = String(text || '').trim();
    const normalized = normalizeSpeechText(trimmed);
    const minChars = options.fromLoop ? 3 : 2;
    if (normalized.length < minChars) return false;
    if (isLikelyNoiseTranscript(trimmed)) return false;
    if (confidence > 0 && confidence < 0.35 && normalized.length < 8) return false;
    if (options.assistantLine && textSimilarity(trimmed, options.assistantLine) >= 0.68) return false;
    return true;
}

export function inferAvatarPerformance(text: string, emotion: string, isSpeaking: boolean): AvatarPerformance {
    const line = text.trim();
    const lower = line.toLowerCase();
    const hasQuestion = /[?？]|\bwhy\b|\bhow\b|为什么|怎么|如何|什么/.test(lower);
    const hasExcitement = /[!！]{1,}|太好了|好耶|厉害|不错|开心|喜欢|かわいい|すごい/.test(lower);
    const hasComfort = /没事|别急|慢慢|辛苦|抱抱|安心|大丈夫|そばに/.test(lower);
    const hasTechnical = /代码|报错|配置|接口|模型|延迟|tts|api|bug|日志|构建|测试/i.test(line);
    const hasPlayful = /嘿|哼|欸|诶|嘛|呀|哦|ふふ|えへ|にゃ|喵|～|~/.test(line);
    const hasSad = /抱歉|难过|低落|失败|崩|痛|泪|ごめん|かなしい/.test(lower);
    const hasSurprise = /欸|诶|哇|竟然|真的|突然|surprise|えっ|びっくり/.test(lower);

    let mood: AvatarPerformance['mood'] = 'calm';
    if (emotion === 'surprised' || hasSurprise) {
        mood = 'surprised';
    } else if (emotion === 'happy' || hasExcitement) {
        mood = 'cheer';
    } else if (hasComfort || emotion === 'sad') {
        mood = 'comfort';
    } else if (hasQuestion || emotion === 'thinking') {
        mood = 'curious';
    } else if (hasTechnical || emotion === 'focused') {
        mood = 'confident';
    } else if (hasPlayful) {
        mood = 'playful';
    }

    const energyBase = isSpeaking ? 0.42 : 0.2;
    const energy = clamp(
        energyBase +
        (hasExcitement ? 0.22 : 0) +
        (hasPlayful ? 0.16 : 0) +
        (hasTechnical ? 0.08 : 0) +
        (hasSad ? -0.08 : 0),
        0.12,
        0.92,
    );
    const tiltSeed = ((line.length % 7) - 3) / 3;
    const valence = emotion === 'sad' || hasSad ? -0.5
        : emotion === 'happy' || hasExcitement ? 0.7
        : mood === 'cheer' ? 0.6
        : mood === 'playful' ? 0.5
        : mood === 'comfort' ? 0.25
        : mood === 'confident' ? 0.3
        : mood === 'surprised' ? 0.2
        : 0.05;
    const dominance = mood === 'confident' || hasTechnical ? 0.4
        : emotion === 'sad' || hasSad ? -0.3
        : emotion === 'surprised' || hasSurprise ? -0.1
        : 0;

    return {
        key: `${line.slice(0, 18)}:${line.length}:${emotion}`,
        mood,
        energy,
        valence,
        dominance,
        lean: hasTechnical ? 0.32 : hasComfort ? -0.12 : hasPlayful ? 0.22 : 0,
        headTilt: mood === 'curious' ? 0.42 : mood === 'playful' ? tiltSeed * 0.34 : mood === 'surprised' ? -0.18 : tiltSeed * 0.12,
        eyeSmile: mood === 'cheer' || mood === 'playful' ? 0.55 : mood === 'comfort' ? 0.25 : 0.08,
        sparkle: mood === 'cheer' || hasExcitement ? 0.8 : 0,
        blush: mood === 'cheer' || mood === 'playful' ? 0.35 : 0,
        tears: hasSad ? 0.55 : 0,
        puff: mood === 'playful' && /哼|不嘛|才不|む/.test(lower) ? 0.45 : 0,
        hand: hasExcitement ? 'left' : hasTechnical ? 'right' : hasComfort ? 'left' : 'none',
        gesture: 'none',
    };
}

/**
 * 从一组时间值里找出最早的合法时间（ISO 字符串）。
 *
 * 用途：状态岛的「陪伴天数」需要**首次对话时间**。会话列表是按 `updated_at DESC` 排序的，
 * 因此不能简单地取首项或末项（续聊旧会话会让它在列表里靠前），必须真正求最小值。
 * 解析失败的值一律忽略；都没有合法值返回 undefined（调用方据此隐藏该项而不是显示 NaN）。
 */
export function earliestTimestamp(values: unknown[]): string | undefined {
    let earliestMs = Number.POSITIVE_INFINITY;
    let earliestRaw: string | undefined;
    for (const value of values) {
        if (value === null || value === undefined || value === '') {
            continue;
        }
        const ms = new Date(value as string).getTime();
        if (!Number.isFinite(ms)) {
            continue;
        }
        if (ms < earliestMs) {
            earliestMs = ms;
            earliestRaw = String(value);
        }
    }
    return earliestRaw;
}
