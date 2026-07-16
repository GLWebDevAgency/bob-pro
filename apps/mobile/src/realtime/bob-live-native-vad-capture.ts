import {
  BOB_LIVE_AUDIO_FRAME_BYTES,
  BOB_LIVE_AUDIO_FRAME_DURATION_MS,
  BobLiveAudioPcmStreamDecoder,
  BobLiveAudioVadStreamDecoder,
} from '../../modules/bob-live-audio/src/BobLiveAudio.contract';
import type { BobLiveAudioVadEvent } from '../../modules/bob-live-audio/src/BobLiveAudio.types';

const PCM_BYTES_PER_MILLISECOND = 32;
const PROTOCOL_AUDIO_QUANTUM_MS = 10;
const TIMELINE_TOLERANCE_MS = 0.01;
const DEFAULT_MAX_PRE_ROLL_MS = 300;
const DEFAULT_ONSET_DETECTION_MS = 60;

export type BobLiveNativeVadCaptureErrorCode =
  | 'invalid_pcm_frame'
  | 'invalid_vad_transition'
  | 'insufficient_pre_roll';

/** Erreur opaque : aucune donnée audio ou événement natif n'est recopié dans son message. */
export class BobLiveNativeVadCaptureError extends Error {
  constructor(readonly code: BobLiveNativeVadCaptureErrorCode) {
    super(code);
    this.name = 'BobLiveNativeVadCaptureError';
  }
}

export interface BobLiveNativeCaptureFrame {
  readonly captureSequence: number;
  readonly startedAtMonotonicMs: number;
  readonly pcm: Uint8Array;
}

export type BobLiveNativePcmAcceptance =
  | { readonly kind: 'buffered' }
  | { readonly kind: 'speech_frame'; readonly frame: BobLiveNativeCaptureFrame };

export type BobLiveNativeVadAcceptance =
  | {
      readonly kind: 'speech_started';
      readonly event: BobLiveAudioVadEvent;
      /** Commence exactement au pré-roll annoncé, sur un quantum protocolaire de 10 ms. */
      readonly initialFrames: readonly BobLiveNativeCaptureFrame[];
    }
  | {
      readonly kind: 'speech_ended';
      readonly event: BobLiveAudioVadEvent;
      /** Séquence du flux natif uniquement. Elle ne doit jamais être utilisée comme
       * `lastAudioSequence` v2, attribuée après admission effective par le transport réseau. */
      readonly lastForwardedCaptureSequence: number;
    };

interface RingOptions {
  readonly maxPreRollMs?: number;
  readonly onsetDetectionMs?: number;
}

function validFrame(frame: BobLiveNativeCaptureFrame): boolean {
  return Number.isSafeInteger(frame.captureSequence)
    && frame.captureSequence >= 0
    && Number.isFinite(frame.startedAtMonotonicMs)
    && !Object.is(frame.startedAtMonotonicMs, -0)
    && frame.startedAtMonotonicMs >= 0
    && frame.pcm instanceof Uint8Array
    && frame.pcm.byteLength === BOB_LIVE_AUDIO_FRAME_BYTES;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= TIMELINE_TOLERANCE_MS;
}

/**
 * Ring PCM borné entre le module natif et le transport conversationnel v2.
 *
 * Le module publie toujours la trame PCM avant la transition VAD du même callback. Le ring garde
 * donc assez de trames pour reconstruire le pré-roll exact quand `speech_started` arrive, puis
 * remet les trames suivantes au transport sans conserver l'énoncé complet.
 */
export class BobLiveNativeVadPcmRing {
  private readonly frames: Array<BobLiveNativeCaptureFrame | null>;
  private writeIndex = 0;
  private frameCount = 0;
  private lastCaptureSequence = -1;
  private lastFrameStartedAtMonotonicMs = -1;
  private activeUtteranceIndex: number | null = null;
  private lastForwardedCaptureSequence: number | null = null;

  constructor(options: RingOptions = {}) {
    const maxPreRollMs = options.maxPreRollMs ?? DEFAULT_MAX_PRE_ROLL_MS;
    const onsetDetectionMs = options.onsetDetectionMs ?? DEFAULT_ONSET_DETECTION_MS;
    if (
      !Number.isSafeInteger(maxPreRollMs)
      || maxPreRollMs < 0
      || maxPreRollMs > 300
      || !Number.isSafeInteger(onsetDetectionMs)
      || onsetDetectionMs < 0
      || onsetDetectionMs > 1_000
    ) throw new BobLiveNativeVadCaptureError('invalid_pcm_frame');
    // Une trame supplémentaire absorbe l'alignement 40 ms autour du début exact du pré-roll.
    const capacity = Math.ceil(
      (maxPreRollMs + onsetDetectionMs) / BOB_LIVE_AUDIO_FRAME_DURATION_MS,
    ) + 1;
    this.frames = Array<BobLiveNativeCaptureFrame | null>(capacity).fill(null);
  }

  acceptPcm(frame: BobLiveNativeCaptureFrame): BobLiveNativePcmAcceptance {
    if (
      !validFrame(frame)
      || frame.captureSequence !== this.lastCaptureSequence + 1
      || (
        this.lastFrameStartedAtMonotonicMs >= 0
        && frame.startedAtMonotonicMs + TIMELINE_TOLERANCE_MS
          < this.lastFrameStartedAtMonotonicMs + BOB_LIVE_AUDIO_FRAME_DURATION_MS
      )
    ) throw new BobLiveNativeVadCaptureError('invalid_pcm_frame');

    const owned: BobLiveNativeCaptureFrame = {
      captureSequence: frame.captureSequence,
      startedAtMonotonicMs: frame.startedAtMonotonicMs,
      pcm: Uint8Array.from(frame.pcm),
    };
    this.frames[this.writeIndex] = owned;
    this.writeIndex = (this.writeIndex + 1) % this.frames.length;
    this.frameCount = Math.min(this.frameCount + 1, this.frames.length);
    this.lastCaptureSequence = owned.captureSequence;
    this.lastFrameStartedAtMonotonicMs = owned.startedAtMonotonicMs;

    if (this.activeUtteranceIndex === null) return { kind: 'buffered' };
    this.lastForwardedCaptureSequence = owned.captureSequence;
    return { kind: 'speech_frame', frame: owned };
  }

  acceptVad(event: BobLiveAudioVadEvent): BobLiveNativeVadAcceptance {
    if (event.kind === 'speech_started') return this.acceptSpeechStart(event);
    if (
      this.activeUtteranceIndex === null
      || event.utteranceIndex !== this.activeUtteranceIndex
      || this.lastForwardedCaptureSequence === null
    ) throw new BobLiveNativeVadCaptureError('invalid_vad_transition');
    const lastForwardedCaptureSequence = this.lastForwardedCaptureSequence;
    this.activeUtteranceIndex = null;
    this.lastForwardedCaptureSequence = null;
    return { kind: 'speech_ended', event, lastForwardedCaptureSequence };
  }

  reset(): void {
    this.frames.fill(null);
    this.writeIndex = 0;
    this.frameCount = 0;
    this.lastCaptureSequence = -1;
    this.lastFrameStartedAtMonotonicMs = -1;
    this.activeUtteranceIndex = null;
    this.lastForwardedCaptureSequence = null;
  }

  private acceptSpeechStart(
    event: BobLiveAudioVadEvent,
  ): Extract<BobLiveNativeVadAcceptance, { readonly kind: 'speech_started' }> {
    if (this.activeUtteranceIndex !== null || this.frameCount === 0) {
      throw new BobLiveNativeVadCaptureError('invalid_vad_transition');
    }
    const desiredStart = event.startedAtMonotonicMs - event.preRollMs;
    if (desiredStart < 0) throw new BobLiveNativeVadCaptureError('invalid_vad_transition');
    const ordered = this.orderedFrames();
    const selected = ordered.filter((frame) => (
      frame.startedAtMonotonicMs + BOB_LIVE_AUDIO_FRAME_DURATION_MS
        > desiredStart + TIMELINE_TOLERANCE_MS
      && frame.startedAtMonotonicMs <= event.detectedAtMonotonicMs + TIMELINE_TOLERANCE_MS
    ));
    const first = selected[0];
    if (!first || first.startedAtMonotonicMs > desiredStart + TIMELINE_TOLERANCE_MS) {
      throw new BobLiveNativeVadCaptureError('insufficient_pre_roll');
    }

    const leadingMs = Math.max(0, desiredStart - first.startedAtMonotonicMs);
    const leadingQuanta = Math.round(leadingMs / PROTOCOL_AUDIO_QUANTUM_MS);
    if (!nearlyEqual(leadingMs, leadingQuanta * PROTOCOL_AUDIO_QUANTUM_MS)) {
      throw new BobLiveNativeVadCaptureError('invalid_vad_transition');
    }
    const leadingBytes = leadingQuanta
      * PROTOCOL_AUDIO_QUANTUM_MS
      * PCM_BYTES_PER_MILLISECOND;
    if (leadingBytes >= first.pcm.byteLength) {
      throw new BobLiveNativeVadCaptureError('invalid_vad_transition');
    }
    const initialFrames = selected.map((frame, index): BobLiveNativeCaptureFrame => (
      index === 0 && leadingBytes > 0
        ? {
            ...frame,
            startedAtMonotonicMs: frame.startedAtMonotonicMs
              + leadingQuanta * PROTOCOL_AUDIO_QUANTUM_MS,
            pcm: frame.pcm.subarray(leadingBytes),
          }
        : frame
    ));
    if (!nearlyEqual(initialFrames[0]?.startedAtMonotonicMs ?? -1, desiredStart)) {
      throw new BobLiveNativeVadCaptureError('insufficient_pre_roll');
    }
    const last = initialFrames.at(-1);
    if (!last) throw new BobLiveNativeVadCaptureError('insufficient_pre_roll');
    this.activeUtteranceIndex = event.utteranceIndex;
    this.lastForwardedCaptureSequence = last.captureSequence;
    return { kind: 'speech_started', event, initialFrames };
  }

  private orderedFrames(): BobLiveNativeCaptureFrame[] {
    const result: BobLiveNativeCaptureFrame[] = [];
    const start = (this.writeIndex - this.frameCount + this.frames.length) % this.frames.length;
    for (let offset = 0; offset < this.frameCount; offset += 1) {
      const frame = this.frames[(start + offset) % this.frames.length];
      if (frame) result.push(frame);
    }
    return result;
  }
}

/**
 * Frontière prête à brancher aux listeners Expo. Elle valide d'abord les payloads natifs et leur
 * génération, puis seulement les remet au ring ; aucun objet `unknown` ne traverse vers l'uplink.
 */
export class BobLiveNativeVadCaptureStream {
  private readonly pcm: BobLiveAudioPcmStreamDecoder;
  private readonly vad: BobLiveAudioVadStreamDecoder;
  private readonly ring: BobLiveNativeVadPcmRing;

  constructor(
    sessionId: string,
    captureId: string,
    expectedVadConfigVersion: string,
    options: RingOptions = {},
  ) {
    this.pcm = new BobLiveAudioPcmStreamDecoder(sessionId, captureId);
    this.vad = new BobLiveAudioVadStreamDecoder(
      sessionId,
      captureId,
      expectedVadConfigVersion,
    );
    this.ring = new BobLiveNativeVadPcmRing(options);
  }

  acceptPcmEvent(value: unknown): BobLiveNativePcmAcceptance {
    const decoded = this.pcm.decode(value);
    return this.ring.acceptPcm({
      captureSequence: decoded.sequence,
      startedAtMonotonicMs: decoded.capturedAtMonotonicMs,
      pcm: decoded.pcm,
    });
  }

  acceptVadEvent(value: unknown): BobLiveNativeVadAcceptance {
    return this.ring.acceptVad(this.vad.decode(value));
  }
}
