import type { SttPort, TtsPort } from '@bob/ai';
import type {
  RealtimeRenderedAudio,
  RealtimeSpeechAuditPort,
  RealtimeSpeechMimeType,
  RealtimeSpeechSynthesisPort,
} from './realtime-speech-renderer';

const MAX_TTS_BASE64_CHARS = Math.ceil((2 * 1024 * 1024) * 4 / 3) + 4;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function canonicalMime(value: string): RealtimeSpeechMimeType | null {
  switch (value.trim().toLowerCase().split(';', 1)[0]) {
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'audio/mpeg';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'audio/wav';
    default:
      return null;
  }
}

function decodeStrictBase64(value: string): Uint8Array | null {
  if (!value || value.length > MAX_TTS_BASE64_CHARS || value.length % 4 !== 0 || !BASE64.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64');
  // Buffer tolère historiquement des formes non canoniques : la ré-encodage ferme cette voie.
  return bytes.toString('base64') === value ? new Uint8Array(bytes) : null;
}

function synchsafe(bytes: Uint8Array, offset: number): number | null {
  const values = [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
  if (values.some((value) => value === undefined || (value & 0x80) !== 0)) return null;
  return ((values[0]! << 21) | (values[1]! << 14) | (values[2]! << 7) | values[3]!) >>> 0;
}

const MPEG1_LAYER3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] as const;
const MPEG2_LAYER3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] as const;

function mp3DurationMs(bytes: Uint8Array): number | null {
  let payloadStart = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    if (bytes.byteLength < 10) return null;
    const size = synchsafe(bytes, 6);
    if (size === null) return null;
    payloadStart = 10 + size;
  }
  const searchEnd = Math.min(bytes.byteLength - 4, payloadStart + 64 * 1024);
  for (let index = payloadStart; index <= searchEnd; index += 1) {
    const header = ((bytes[index]! << 24)
      | (bytes[index + 1]! << 16)
      | (bytes[index + 2]! << 8)
      | bytes[index + 3]!) >>> 0;
    if (((header & 0xffe00000) >>> 0) !== 0xffe00000) continue;
    const version = (header >>> 19) & 0b11;
    const layer = (header >>> 17) & 0b11;
    const bitrateIndex = (header >>> 12) & 0b1111;
    const sampleRateIndex = (header >>> 10) & 0b11;
    if (version === 0b01 || layer !== 0b01 || bitrateIndex === 0 || bitrateIndex === 0b1111 || sampleRateIndex === 0b11) {
      continue;
    }
    const kbps = version === 0b11
      ? MPEG1_LAYER3_KBPS[bitrateIndex]
      : MPEG2_LAYER3_KBPS[bitrateIndex];
    if (!kbps) continue;
    const encodedBytes = bytes.byteLength - index;
    return Math.max(1, Math.round((encodedBytes * 8 * 1_000) / (kbps * 1_000)));
  }
  return null;
}

function wavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44
    || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46
    || bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const size = view.getUint32(offset + 4, true);
    const contentStart = offset + 8;
    if (size > bytes.byteLength - contentStart) return null;
    if (id === 'fmt ' && size >= 16) byteRate = view.getUint32(contentStart + 8, true);
    if (id === 'data') dataBytes = size;
    if (byteRate && dataBytes !== null) break;
    offset = contentStart + size + (size % 2);
  }
  if (!byteRate || dataBytes === null) return null;
  return Math.max(1, Math.round((dataBytes * 1_000) / byteRate));
}

function parsedDurationMs(mimeType: RealtimeSpeechMimeType, bytes: Uint8Array): number | null {
  if (mimeType === 'audio/mpeg') return mp3DurationMs(bytes);
  if (mimeType === 'audio/wav') return wavDurationMs(bytes);
  return null;
}

export class BobAiRealtimeSpeechSynthesisAdapter implements RealtimeSpeechSynthesisPort {
  readonly id: string;
  readonly trustDomain: 'openai.com' | 'mistral.ai';

  constructor(private readonly tts: TtsPort) {
    const declaredTrustDomain = (tts as TtsPort & { readonly synthesisTrustDomain?: unknown })
      .synthesisTrustDomain;
    if (tts.id === 'openai-realtime-tts' && declaredTrustDomain === 'openai.com') {
      this.trustDomain = 'openai.com';
    } else if (tts.id === 'mistral-voxtral-tts' && declaredTrustDomain === 'mistral.ai') {
      this.trustDomain = 'mistral.ai';
    } else {
      throw new Error('Bob Live requires a qualified realtime TTS adapter.');
    }
    this.id = tts.id;
  }

  async synthesize(input: { readonly text: string; readonly signal: AbortSignal }): Promise<RealtimeRenderedAudio> {
    const output = await this.tts.synthesize(input.text, { signal: input.signal });
    input.signal.throwIfAborted();
    if (typeof output.audioBase64 !== 'string' || typeof output.mimeType !== 'string') {
      throw new Error('realtime_tts_invalid_output');
    }
    const mimeType = canonicalMime(output.mimeType);
    const audioBytes = decodeStrictBase64(output.audioBase64);
    if (!mimeType || !audioBytes) throw new Error('realtime_tts_invalid_output');
    const estimatedDurationMs = parsedDurationMs(mimeType, audioBytes);
    if (estimatedDurationMs === null) throw new Error('realtime_tts_invalid_container');
    return { audioBytes, mimeType, estimatedDurationMs };
  }
}

export class BobAiRealtimeSpeechAuditAdapter implements RealtimeSpeechAuditPort {
  readonly id: string;
  readonly trustDomain: 'openai.com' | 'bob.local-whisper';

  constructor(private readonly stt: SttPort) {
    const declaredTrustDomain = (stt as SttPort & { readonly auditTrustDomain?: unknown }).auditTrustDomain;
    if (stt.id === 'openai-realtime-audit-whisper' && declaredTrustDomain === 'openai.com') {
      this.trustDomain = 'openai.com';
    } else if (stt.id === 'local-whisper' && declaredTrustDomain === 'bob.local-whisper') {
      this.trustDomain = 'bob.local-whisper';
    } else {
      throw new Error('Bob Live requires a qualified independent audit STT adapter.');
    }
    this.id = stt.id;
  }

  async transcribe(input: {
    readonly audioBytes: Uint8Array;
    readonly mimeType: RealtimeSpeechMimeType;
    readonly signal: AbortSignal;
  }): Promise<{ readonly text: string }> {
    const output = await this.stt.transcribe(
      Buffer.from(input.audioBytes).toString('base64'),
      input.mimeType,
      { signal: input.signal },
    );
    input.signal.throwIfAborted();
    if (typeof output.text !== 'string') throw new Error('realtime_asr_invalid_output');
    return { text: output.text };
  }
}
