import type { BobLiveAudioPcmChunkEvent, BobLiveAudioVadEvent } from './BobLiveAudio.types';

export const BOB_LIVE_AUDIO_SAMPLE_RATE_HZ = 16_000 as const;
export const BOB_LIVE_AUDIO_CHANNELS = 1 as const;
export const BOB_LIVE_AUDIO_FRAME_DURATION_MS = 40 as const;
export const BOB_LIVE_AUDIO_FRAME_BYTES = 1_280 as const;
export const BOB_LIVE_AUDIO_MAX_IN_FLIGHT_FRAMES = 16 as const;
export const BOB_LIVE_AUDIO_MIN_CAPTURE_DURATION_MS = 1_000 as const;
export const BOB_LIVE_AUDIO_MAX_CAPTURE_DURATION_MS = 900_000 as const;
export const BOB_LIVE_VAD_PROFILE = Object.freeze({
  configVersion: 'bob-live-vad-foundation-1',
  analysisWindowMs: 20,
  preRollMs: 240,
  speechStartMs: 60,
  speechEndMs: 700,
  maximumUtteranceMs: 30_000,
} as const);
export const BOB_LIVE_VAD_CONFIG_VERSION = BOB_LIVE_VAD_PROFILE.configVersion;
export const BOB_LIVE_VAD_EVENT_ORDERING = 'pcm_before_vad' as const;
export const BOB_LIVE_VAD_ANALYSIS_WINDOW_MS = BOB_LIVE_VAD_PROFILE.analysisWindowMs;
export const BOB_LIVE_VAD_PRE_ROLL_MS = BOB_LIVE_VAD_PROFILE.preRollMs;
export const BOB_LIVE_VAD_SPEECH_START_MS = BOB_LIVE_VAD_PROFILE.speechStartMs;
export const BOB_LIVE_VAD_SPEECH_END_MS = BOB_LIVE_VAD_PROFILE.speechEndMs;
export const BOB_LIVE_VAD_MAXIMUM_UTTERANCE_MS = BOB_LIVE_VAD_PROFILE.maximumUtteranceMs;

const BASE64_FRAME_LENGTH = 1_708;
const BOUNDED_ID = /^[A-Za-z0-9-]{1,64}$/u;
const VAD_CONFIG_VERSION = /^[A-Za-z0-9._-]{1,64}$/u;
// iOS preserves nanosecond fractions in a JS Double. One microsecond absorbs only floating-point
// conversion noise; it is far below the 20 ms analysis quantum and cannot hide profile drift.
const VAD_TIMELINE_TOLERANCE_MS = 0.001;
const PROCESSING_STATUS = new Set(['enabled', 'unavailable', 'unknown']);
const CAPABILITIES_KEYS = [
  'sessionId',
  'captureId',
  'encoding',
  'sampleRateHz',
  'channels',
  'frameDurationMs',
  'maxInFlightFrames',
  'maxCaptureDurationMs',
  'acousticEchoCancellation',
  'noiseSuppression',
  'automaticGainControl',
  'vadConfigVersion',
  'vadEventOrdering',
  'vadAnalysisWindowMs',
  'vadPreRollMs',
  'vadSpeechStartMs',
  'vadSpeechEndMs',
  'vadMaximumUtteranceMs',
  'fullDuplexCertified',
] as const;
const PCM_EVENT_KEYS = [
  'sessionId',
  'captureId',
  'sequence',
  'capturedAtMonotonicMs',
  'pcmBase64',
] as const;
const VAD_EVENT_KEYS = [
  'sessionId',
  'captureId',
  'kind',
  'configVersion',
  'utteranceIndex',
  'detectedAtMonotonicMs',
  'preRollMs',
  'startedAtMonotonicMs',
  'endedAtMonotonicMs',
  'forcedEnd',
  'energyDbfs',
  'noiseFloorDbfs',
] as const;

export class BobLiveAudioContractError extends Error {
  readonly code = 'invalid_native_audio_frame' as const;

  constructor() {
    super('invalid_native_audio_frame');
    this.name = 'BobLiveAudioContractError';
  }
}

/**
 * Frontière défensive entre le module natif et le transport réseau.
 * Elle borne l'allocation avant décodage et refuse une trame/session hors contrat.
 */
export function decodeBobLiveAudioPcmChunk(
  event: unknown,
  expectedSessionId: string,
  expectedCaptureId: string,
): Uint8Array {
  const parsed = parsePcmChunkEvent(event);
  if (
    !BOUNDED_ID.test(expectedSessionId) ||
    parsed.sessionId !== expectedSessionId ||
    !BOUNDED_ID.test(expectedCaptureId) ||
    parsed.captureId !== expectedCaptureId ||
    parsed.pcmBase64.length !== BASE64_FRAME_LENGTH
  ) {
    throw new BobLiveAudioContractError();
  }

  const pcm = new Uint8Array(BOB_LIVE_AUDIO_FRAME_BYTES);
  let outputIndex = 0;
  for (let inputIndex = 0; inputIndex < parsed.pcmBase64.length; inputIndex += 4) {
    const isLastGroup = inputIndex === parsed.pcmBase64.length - 4;
    const first = base64Value(parsed.pcmBase64.charCodeAt(inputIndex));
    const second = base64Value(parsed.pcmBase64.charCodeAt(inputIndex + 1));
    const third = base64Value(parsed.pcmBase64.charCodeAt(inputIndex + 2));
    const fourthCode = parsed.pcmBase64.charCodeAt(inputIndex + 3);
    const fourth = fourthCode === 0x3d ? -1 : base64Value(fourthCode);
    if (
      first < 0 ||
      second < 0 ||
      third < 0 ||
      fourth < -1 ||
      (fourth === -1 && !isLastGroup) ||
      (isLastGroup && (fourth !== -1 || (third & 0b11) !== 0))
    ) {
      throw new BobLiveAudioContractError();
    }

    pcm[outputIndex] = (first << 2) | (second >> 4);
    outputIndex += 1;
    pcm[outputIndex] = ((second & 0x0f) << 4) | (third >> 2);
    outputIndex += 1;
    if (fourth >= 0) {
      if (outputIndex >= pcm.length) throw new BobLiveAudioContractError();
      pcm[outputIndex] = ((third & 0x03) << 6) | fourth;
      outputIndex += 1;
    }
  }
  if (outputIndex !== BOB_LIVE_AUDIO_FRAME_BYTES) throw new BobLiveAudioContractError();
  return pcm;
}

function parsePcmChunkEvent(value: unknown): BobLiveAudioPcmChunkEvent {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BobLiveAudioContractError();
    }
    const candidate = value as Record<string, unknown>;
    if (!hasExactKeys(candidate, PCM_EVENT_KEYS)) throw new BobLiveAudioContractError();
    const { sessionId, captureId, sequence, capturedAtMonotonicMs, pcmBase64 } = candidate;
    if (
      typeof sessionId !== 'string' ||
      typeof captureId !== 'string' ||
      !BOUNDED_ID.test(captureId) ||
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      typeof capturedAtMonotonicMs !== 'number' ||
      !Number.isFinite(capturedAtMonotonicMs) ||
      capturedAtMonotonicMs < 0 ||
      typeof pcmBase64 !== 'string'
    ) {
      throw new BobLiveAudioContractError();
    }
    return { sessionId, captureId, sequence, capturedAtMonotonicMs, pcmBase64 };
  } catch (error) {
    if (error instanceof BobLiveAudioContractError) throw error;
    throw new BobLiveAudioContractError();
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function finiteBetween(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    !Object.is(value, -0) &&
    value >= minimum &&
    value <= maximum
  );
}

function nearlyEqualMilliseconds(left: number, right: number): boolean {
  return Math.abs(left - right) <= VAD_TIMELINE_TOLERANCE_MS;
}

function alignsWithVadWindow(durationMs: number): boolean {
  const nearestWindowBoundaryMs =
    Math.round(durationMs / BOB_LIVE_VAD_ANALYSIS_WINDOW_MS) * BOB_LIVE_VAD_ANALYSIS_WINDOW_MS;
  return nearlyEqualMilliseconds(durationMs, nearestWindowBoundaryMs);
}

function vadTemporalFieldsAreValid(input: {
  readonly kind: 'speech_started' | 'speech_ended';
  readonly detectedAtMonotonicMs: number;
  readonly preRollMs: number;
  readonly startedAtMonotonicMs: number;
  readonly endedAtMonotonicMs: number | null;
  readonly forcedEnd: boolean;
}): boolean {
  if (
    Object.is(input.preRollMs, -0) ||
    input.preRollMs > BOB_LIVE_VAD_PRE_ROLL_MS ||
    !Number.isSafeInteger(input.preRollMs) ||
    input.preRollMs % BOB_LIVE_VAD_ANALYSIS_WINDOW_MS !== 0
  )
    return false;

  const startDetectionDelayMs = input.detectedAtMonotonicMs - input.startedAtMonotonicMs;
  if (input.kind === 'speech_started') {
    return (
      input.endedAtMonotonicMs === null &&
      !input.forcedEnd &&
      nearlyEqualMilliseconds(startDetectionDelayMs, BOB_LIVE_VAD_SPEECH_START_MS)
    );
  }

  if (input.endedAtMonotonicMs === null) return false;
  const utteranceDurationMs = input.endedAtMonotonicMs - input.startedAtMonotonicMs;
  const endpointDetectionDelayMs = input.detectedAtMonotonicMs - input.endedAtMonotonicMs;
  if (input.forcedEnd) {
    return (
      nearlyEqualMilliseconds(utteranceDurationMs, BOB_LIVE_VAD_MAXIMUM_UTTERANCE_MS) &&
      nearlyEqualMilliseconds(endpointDetectionDelayMs, 0)
    );
  }

  return (
    utteranceDurationMs + VAD_TIMELINE_TOLERANCE_MS >= BOB_LIVE_VAD_SPEECH_START_MS &&
    alignsWithVadWindow(utteranceDurationMs) &&
    startDetectionDelayMs < BOB_LIVE_VAD_MAXIMUM_UTTERANCE_MS &&
    nearlyEqualMilliseconds(endpointDetectionDelayMs, BOB_LIVE_VAD_SPEECH_END_MS)
  );
}

function parseVadEvent(value: unknown): BobLiveAudioVadEvent {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BobLiveAudioContractError();
    }
    const candidate = value as Record<string, unknown>;
    if (!hasExactKeys(candidate, VAD_EVENT_KEYS)) throw new BobLiveAudioContractError();
    const {
      sessionId,
      captureId,
      kind,
      configVersion,
      utteranceIndex,
      detectedAtMonotonicMs,
      preRollMs,
      startedAtMonotonicMs,
      endedAtMonotonicMs,
      forcedEnd,
      energyDbfs,
      noiseFloorDbfs,
    } = candidate;
    if (
      typeof sessionId !== 'string' ||
      !BOUNDED_ID.test(sessionId) ||
      typeof captureId !== 'string' ||
      !BOUNDED_ID.test(captureId) ||
      (kind !== 'speech_started' && kind !== 'speech_ended') ||
      typeof configVersion !== 'string' ||
      !VAD_CONFIG_VERSION.test(configVersion) ||
      typeof utteranceIndex !== 'number' ||
      !Number.isSafeInteger(utteranceIndex) ||
      utteranceIndex < 1 ||
      !finiteBetween(detectedAtMonotonicMs, 0, Number.MAX_SAFE_INTEGER) ||
      typeof preRollMs !== 'number' ||
      preRollMs < 0 ||
      !finiteBetween(startedAtMonotonicMs, 0, Number.MAX_SAFE_INTEGER) ||
      startedAtMonotonicMs > detectedAtMonotonicMs ||
      (endedAtMonotonicMs !== null &&
        !finiteBetween(endedAtMonotonicMs, startedAtMonotonicMs, detectedAtMonotonicMs)) ||
      typeof forcedEnd !== 'boolean' ||
      !finiteBetween(energyDbfs, -120, 0) ||
      !finiteBetween(noiseFloorDbfs, -120, 0) ||
      !vadTemporalFieldsAreValid({
        kind,
        detectedAtMonotonicMs,
        preRollMs,
        startedAtMonotonicMs,
        endedAtMonotonicMs,
        forcedEnd,
      })
    ) {
      throw new BobLiveAudioContractError();
    }
    return {
      sessionId,
      captureId,
      kind,
      configVersion,
      utteranceIndex,
      detectedAtMonotonicMs,
      preRollMs,
      startedAtMonotonicMs,
      endedAtMonotonicMs,
      forcedEnd,
      energyDbfs,
      noiseFloorDbfs,
    };
  } catch (error) {
    if (error instanceof BobLiveAudioContractError) throw error;
    throw new BobLiveAudioContractError();
  }
}

/**
 * Décodeur générationnel des transitions VAD. Il interdit end sans start, chevauchements,
 * changement de profil en cours de capture et retour d'horloge avant exposition à l'UI/réseau.
 */
export class BobLiveAudioVadStreamDecoder {
  private activeStart: BobLiveAudioVadEvent | null = null;
  private lastUtteranceIndex = 0;
  private lastDetectedAtMonotonicMs = -1;

  constructor(
    private readonly expectedSessionId: string,
    private readonly expectedCaptureId: string,
    private readonly expectedConfigVersion: string,
  ) {
    if (
      !BOUNDED_ID.test(expectedSessionId) ||
      !BOUNDED_ID.test(expectedCaptureId) ||
      expectedConfigVersion !== BOB_LIVE_VAD_CONFIG_VERSION
    ) {
      throw new BobLiveAudioContractError();
    }
  }

  decode(value: unknown): BobLiveAudioVadEvent {
    const event = parseVadEvent(value);
    if (
      event.sessionId !== this.expectedSessionId ||
      event.captureId !== this.expectedCaptureId ||
      event.configVersion !== this.expectedConfigVersion ||
      event.detectedAtMonotonicMs < this.lastDetectedAtMonotonicMs
    )
      throw new BobLiveAudioContractError();

    if (event.kind === 'speech_started') {
      if (this.activeStart !== null || event.utteranceIndex <= this.lastUtteranceIndex) {
        throw new BobLiveAudioContractError();
      }
      this.activeStart = event;
      this.lastUtteranceIndex = event.utteranceIndex;
    } else {
      const start = this.activeStart;
      if (
        start === null ||
        event.utteranceIndex !== start.utteranceIndex ||
        event.startedAtMonotonicMs !== start.startedAtMonotonicMs ||
        event.preRollMs !== start.preRollMs
      )
        throw new BobLiveAudioContractError();
      this.activeStart = null;
    }
    this.lastDetectedAtMonotonicMs = event.detectedAtMonotonicMs;
    return event;
  }
}

/**
 * Decodeur lie a une capture. Il refuse duplications, trous et retours en arriere avant que
 * l'appelant n'acquitte la trame native. Une instance ne doit jamais etre reutilisee entre
 * deux sessions.
 */
export class BobLiveAudioPcmStreamDecoder {
  private nextSequence = 0;
  private lastCapturedAtMonotonicMs = -1;

  constructor(
    private readonly expectedSessionId: string,
    private readonly expectedCaptureId: string,
  ) {
    if (!BOUNDED_ID.test(expectedSessionId) || !BOUNDED_ID.test(expectedCaptureId)) {
      throw new BobLiveAudioContractError();
    }
  }

  decode(event: unknown): {
    readonly sequence: number;
    readonly capturedAtMonotonicMs: number;
    readonly pcm: Uint8Array;
  } {
    const parsed = parsePcmChunkEvent(event);
    if (
      parsed.sessionId !== this.expectedSessionId ||
      parsed.captureId !== this.expectedCaptureId ||
      parsed.sequence !== this.nextSequence ||
      parsed.capturedAtMonotonicMs < this.lastCapturedAtMonotonicMs
    ) {
      throw new BobLiveAudioContractError();
    }
    const pcm = decodeBobLiveAudioPcmChunk(parsed, this.expectedSessionId, this.expectedCaptureId);
    this.nextSequence += 1;
    this.lastCapturedAtMonotonicMs = parsed.capturedAtMonotonicMs;
    return {
      sequence: parsed.sequence,
      capturedAtMonotonicMs: parsed.capturedAtMonotonicMs,
      pcm,
    };
  }
}

function base64Value(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -2;
}

export function assertBobLiveAudioCapabilities(value: unknown, expectedSessionId: string): void {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BobLiveAudioContractError();
    }
    const candidate = value as Record<string, unknown>;
    if (
      !hasExactKeys(candidate, CAPABILITIES_KEYS) ||
      !BOUNDED_ID.test(expectedSessionId) ||
      candidate.sessionId !== expectedSessionId ||
      typeof candidate.captureId !== 'string' ||
      !BOUNDED_ID.test(candidate.captureId) ||
      candidate.encoding !== 'pcm_s16le' ||
      candidate.sampleRateHz !== BOB_LIVE_AUDIO_SAMPLE_RATE_HZ ||
      candidate.channels !== BOB_LIVE_AUDIO_CHANNELS ||
      candidate.frameDurationMs !== BOB_LIVE_AUDIO_FRAME_DURATION_MS ||
      candidate.maxInFlightFrames !== BOB_LIVE_AUDIO_MAX_IN_FLIGHT_FRAMES ||
      typeof candidate.maxCaptureDurationMs !== 'number' ||
      !Number.isSafeInteger(candidate.maxCaptureDurationMs) ||
      candidate.maxCaptureDurationMs < BOB_LIVE_AUDIO_MIN_CAPTURE_DURATION_MS ||
      candidate.maxCaptureDurationMs > BOB_LIVE_AUDIO_MAX_CAPTURE_DURATION_MS ||
      typeof candidate.acousticEchoCancellation !== 'string' ||
      !PROCESSING_STATUS.has(candidate.acousticEchoCancellation) ||
      typeof candidate.noiseSuppression !== 'string' ||
      !PROCESSING_STATUS.has(candidate.noiseSuppression) ||
      typeof candidate.automaticGainControl !== 'string' ||
      !PROCESSING_STATUS.has(candidate.automaticGainControl) ||
      candidate.vadConfigVersion !== BOB_LIVE_VAD_CONFIG_VERSION ||
      candidate.vadEventOrdering !== BOB_LIVE_VAD_EVENT_ORDERING ||
      candidate.vadAnalysisWindowMs !== BOB_LIVE_VAD_ANALYSIS_WINDOW_MS ||
      candidate.vadPreRollMs !== BOB_LIVE_VAD_PRE_ROLL_MS ||
      candidate.vadSpeechStartMs !== BOB_LIVE_VAD_SPEECH_START_MS ||
      candidate.vadSpeechEndMs !== BOB_LIVE_VAD_SPEECH_END_MS ||
      candidate.vadMaximumUtteranceMs !== BOB_LIVE_VAD_MAXIMUM_UTTERANCE_MS ||
      candidate.fullDuplexCertified !== false
    ) {
      throw new BobLiveAudioContractError();
    }
  } catch (error) {
    if (error instanceof BobLiveAudioContractError) throw error;
    throw new BobLiveAudioContractError();
  }
}
