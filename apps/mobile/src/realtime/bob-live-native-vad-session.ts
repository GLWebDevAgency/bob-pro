import BobLiveAudioModule, {
  assertBobLiveAudioCapabilities,
  type BobLiveAudioCapabilities,
  type BobLiveAudioErrorEvent,
  type BobLiveAudioNativeModule,
  type BobLiveAudioPcmChunkEvent,
  type BobLiveAudioStoppedEvent,
  type BobLiveAudioVadEvent,
} from '../../modules/bob-live-audio';

import {
  BobLiveNativeVadCaptureStream,
  type BobLiveNativePcmAcceptance,
  type BobLiveNativeVadAcceptance,
} from './bob-live-native-vad-capture';

const BOUNDED_ID = /^[A-Za-z0-9-]{1,64}$/u;
const MIN_CAPTURE_DURATION_MS = 1_000;
const MAX_CAPTURE_DURATION_MS = 900_000;
const NATIVE_STOP_TIMEOUT_MS = 2_000;

type NativeSubscription = { remove(): void };

export type BobLiveNativeVadSessionErrorCode =
  | 'native_vad_session_unavailable'
  | 'native_vad_session_aborted'
  | 'native_vad_session_stop_failed';

export class BobLiveNativeVadSessionError extends Error {
  constructor(readonly code: BobLiveNativeVadSessionErrorCode) {
    super(code);
    this.name = 'BobLiveNativeVadSessionError';
  }
}

export type BobLiveNativeSpeechCancellationReason =
  | 'requested'
  | 'aborted'
  | 'background'
  | 'context_destroyed'
  | 'capture_failed'
  | 'protocol_failed'
  | 'transport_rejected';

export interface BobLiveNativeSpeechCancellation {
  readonly utteranceIndex: number;
  readonly lastCaptureSequence: number;
  readonly reason: BobLiveNativeSpeechCancellationReason;
}

export interface BobLiveNativeVadSessionInput {
  readonly signal: AbortSignal;
  /** Doit accepter synchroniquement le pré-roll avant que la capture native soit acquittée. */
  readonly onSpeechStarted: (
    acceptance: Extract<BobLiveNativeVadAcceptance, { readonly kind: 'speech_started' }>,
  ) => boolean;
  /** Doit accepter synchroniquement la trame active avant son ACK natif. */
  readonly onSpeechFrame: (
    acceptance: Extract<BobLiveNativePcmAcceptance, { readonly kind: 'speech_frame' }>,
  ) => boolean;
  readonly onSpeechEnded: (
    acceptance: Extract<BobLiveNativeVadAcceptance, { readonly kind: 'speech_ended' }>,
  ) => boolean;
  /** Le transport doit convertir cette terminalité locale en `turn.cancel` ou `session.end`. */
  readonly onSpeechCancelled: (cancellation: BobLiveNativeSpeechCancellation) => void;
  readonly onError: () => void;
}

export interface BobLiveNativeVadSession {
  readonly captureId: string;
  readonly capabilities: BobLiveAudioCapabilities;
  stop(): Promise<void>;
}

export interface BobLiveNativeVadSessionPort {
  start(input: BobLiveNativeVadSessionInput): Promise<BobLiveNativeVadSession>;
}

function preparedCaptureId(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const captureId = (value as Record<string, unknown>).captureId;
    return typeof captureId === 'string' && BOUNDED_ID.test(captureId) ? captureId : null;
  } catch {
    return null;
  }
}

function sameCapture(value: unknown, sessionId: string, captureId: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const event = value as Record<string, unknown>;
    return event.sessionId === sessionId && event.captureId === captureId;
  } catch {
    return false;
  }
}

function safeRemove(subscription: NativeSubscription | null): void {
  try {
    subscription?.remove();
  } catch {
    // Une subscription native défaillante ne doit jamais empêcher la fermeture du micro.
  }
}

function accepted(callback: () => boolean): boolean {
  try {
    return callback() === true;
  } catch {
    return false;
  }
}

function aborted(): BobLiveNativeVadSessionError {
  return new BobLiveNativeVadSessionError('native_vad_session_aborted');
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(aborted()));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function stopAttempt(operation: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(
          new BobLiveNativeVadSessionError('native_vad_session_stop_failed'),
        ), NATIVE_STOP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopPreparedCaptureAuthoritatively(
  nativeModule: BobLiveAudioNativeModule,
  sessionId: string,
  captureId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await stopAttempt(nativeModule.stopAsync(sessionId, captureId));
      return;
    } catch {
      // stopAsync est idempotent : un unique retry absorbe une rupture transitoire du bridge.
    }
  }
  throw new BobLiveNativeVadSessionError('native_vad_session_stop_failed');
}

function normalNativeStop(
  event: BobLiveAudioStoppedEvent,
): Extract<BobLiveNativeSpeechCancellationReason,
  'requested' | 'background' | 'context_destroyed'> | null {
  if (
    event.reason === 'requested'
    || event.reason === 'background'
    || event.reason === 'context_destroyed'
  ) return event.reason;
  return null;
}

/**
 * Lifecycle continu PCM + VAD prêt pour le protocole conversationnel v2.
 *
 * La capture est préparée avant l'ouverture physique du micro. Les quatre listeners, les deux
 * décodeurs générationnels et le ring de pré-roll sont installés avant `startPreparedAsync`.
 * Chaque frame est acquittée uniquement après admission dans le ring borné ou acceptation
 * synchrone par le transport. Toute dérive ferme la génération et signale au plus une erreur.
 */
export function createBobLiveNativeVadSession(
  config: {
    readonly sessionId: string;
    readonly maxCaptureDurationMs: number;
  },
  nativeModule: BobLiveAudioNativeModule | null = BobLiveAudioModule,
): BobLiveNativeVadSessionPort | null {
  if (
    nativeModule === null
    || !BOUNDED_ID.test(config.sessionId)
    || !Number.isSafeInteger(config.maxCaptureDurationMs)
    || config.maxCaptureDurationMs < MIN_CAPTURE_DURATION_MS
    || config.maxCaptureDurationMs > MAX_CAPTURE_DURATION_MS
  ) return null;

  return {
    async start(input): Promise<BobLiveNativeVadSession> {
      if (input.signal.aborted) throw aborted();

      let capabilities: BobLiveAudioCapabilities;
      let allocatedCaptureId: string | null = null;
      const prepareTask = nativeModule.prepareAsync(
        config.sessionId,
        config.maxCaptureDurationMs,
      );
      try {
        capabilities = await raceAbort(prepareTask, input.signal);
        allocatedCaptureId = preparedCaptureId(capabilities);
        assertBobLiveAudioCapabilities(capabilities, config.sessionId);
        if (capabilities.maxCaptureDurationMs !== config.maxCaptureDurationMs) {
          throw new Error('native_vad_session_contract_mismatch');
        }
      } catch (prepareError) {
        if (allocatedCaptureId) {
          await stopPreparedCaptureAuthoritatively(
            nativeModule,
            config.sessionId,
            allocatedCaptureId,
          );
        } else if (input.signal.aborted) {
          // Une préparation native non annulable peut finir après l'abort. Elle n'a pas ouvert le
          // micro, mais l'appelant ne peut rendre son lease qu'après libération prouvée de la
          // génération tardive. On attend donc la Promise native au lieu d'un cleanup détaché.
          try {
            const lateCapabilities = await prepareTask;
            const lateCaptureId = preparedCaptureId(lateCapabilities);
            if (!lateCaptureId) {
              throw new BobLiveNativeVadSessionError('native_vad_session_stop_failed');
            }
            await stopPreparedCaptureAuthoritatively(
              nativeModule,
              config.sessionId,
              lateCaptureId,
            );
          } catch (lateError) {
            if (lateError instanceof BobLiveNativeVadSessionError) throw lateError;
            // Une préparation rejetée n'a créé aucune génération à libérer.
          }
        }
        if (prepareError instanceof BobLiveNativeVadSessionError) throw prepareError;
        throw input.signal.aborted
          ? aborted()
          : new BobLiveNativeVadSessionError('native_vad_session_unavailable');
      }

      const captureId = capabilities.captureId;
      const stream = new BobLiveNativeVadCaptureStream(
        config.sessionId,
        captureId,
        capabilities.vadConfigVersion,
      );
      let active = true;
      let expectedStop = false;
      let failureReported = false;
      let stopTask: Promise<void> | null = null;
      let acknowledgementTail = Promise.resolve();
      let unacknowledgedFrames = 0;
      let activeUtterance: {
        readonly utteranceIndex: number;
        lastCaptureSequence: number;
      } | null = null;
      let pcmSubscription: NativeSubscription | null = null;
      let vadSubscription: NativeSubscription | null = null;
      let errorSubscription: NativeSubscription | null = null;
      let stoppedSubscription: NativeSubscription | null = null;
      let abortListener: (() => void) | null = null;

      const removeListeners = (): void => {
        safeRemove(pcmSubscription);
        safeRemove(vadSubscription);
        safeRemove(errorSubscription);
        safeRemove(stoppedSubscription);
        pcmSubscription = null;
        vadSubscription = null;
        errorSubscription = null;
        stoppedSubscription = null;
      };

      const reportErrorOnce = (): void => {
        if (failureReported) return;
        failureReported = true;
        try {
          input.onError();
        } catch {
          // Le callback applicatif n'est jamais propriétaire du cycle de vie natif.
        }
      };

      const stopNative = (
        reportFailure: boolean,
        cancellationReason: BobLiveNativeSpeechCancellationReason,
      ): Promise<void> => {
        if (stopTask) return stopTask;
        // Fence avant tout callback : une reconnexion déclenchée par onError ne peut plus recevoir
        // d'événement de l'ancienne génération et ne court pas avant la fermeture native.
        active = false;
        expectedStop = true;
        if (abortListener) {
          input.signal.removeEventListener('abort', abortListener);
          abortListener = null;
        }
        removeListeners();
        const cancelledUtterance = activeUtterance;
        activeUtterance = null;
        stopTask = Promise.resolve().then(async () => {
          let stopped = false;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await stopAttempt(nativeModule.stopAsync(config.sessionId, captureId));
              stopped = true;
              break;
            } catch {
              // stopAsync est idempotent côté natif : un seul retry absorbe une rupture du bridge.
            }
          }
          if (!stopped) {
            reportErrorOnce();
            throw new BobLiveNativeVadSessionError('native_vad_session_stop_failed');
          }
          if (reportFailure) reportErrorOnce();
        });
        if (cancelledUtterance) {
          try {
            input.onSpeechCancelled({
              ...cancelledUtterance,
              reason: cancellationReason,
            });
          } catch {
            // La terminalité réseau appartient au transport, jamais au lifecycle natif.
          }
        }
        return stopTask;
      };

      const failClosed = (reason: BobLiveNativeSpeechCancellationReason): void => {
        void stopNative(true, reason).catch(() => undefined);
      };

      const acknowledge = (sequence: number): void => {
        acknowledgementTail = acknowledgementTail.then(async () => {
          if (!active) return;
          await nativeModule.acknowledgePcmAsync(config.sessionId, captureId, sequence);
          unacknowledgedFrames = Math.max(0, unacknowledgedFrames - 1);
        });
        void acknowledgementTail.catch(() => {
          if (active) failClosed('capture_failed');
        });
      };

      const onPcmChunk = (event: BobLiveAudioPcmChunkEvent): void => {
        if (!active || input.signal.aborted) return;
        if (unacknowledgedFrames >= capabilities.maxInFlightFrames) {
          failClosed('capture_failed');
          return;
        }
        let acceptance: BobLiveNativePcmAcceptance;
        try {
          acceptance = stream.acceptPcmEvent(event);
        } catch {
          failClosed('protocol_failed');
          return;
        }
        if (
          acceptance.kind === 'speech_frame'
          && !accepted(() => input.onSpeechFrame(acceptance))
        ) {
          failClosed('transport_rejected');
          return;
        }
        if (acceptance.kind === 'speech_frame' && activeUtterance) {
          activeUtterance.lastCaptureSequence = acceptance.frame.captureSequence;
        }
        unacknowledgedFrames += 1;
        acknowledge(event.sequence);
      };

      const onVadEvent = (event: BobLiveAudioVadEvent): void => {
        if (!active || input.signal.aborted) return;
        let acceptance: BobLiveNativeVadAcceptance;
        try {
          acceptance = stream.acceptVadEvent(event);
        } catch {
          failClosed('protocol_failed');
          return;
        }
        if (acceptance.kind === 'speech_started') {
          const last = acceptance.initialFrames.at(-1);
          if (!last) {
            failClosed('protocol_failed');
            return;
          }
          // Armer avant le callback protège un abort/stop synchrone déclenché par le transport.
          activeUtterance = {
            utteranceIndex: acceptance.event.utteranceIndex,
            lastCaptureSequence: last.captureSequence,
          };
        }
        const wasAccepted = acceptance.kind === 'speech_started'
          ? accepted(() => input.onSpeechStarted(acceptance))
          : accepted(() => input.onSpeechEnded(acceptance));
        if (!wasAccepted) {
          failClosed('transport_rejected');
          return;
        }
        if (acceptance.kind === 'speech_ended') {
          activeUtterance = null;
        }
      };

      const onCaptureError = (event: BobLiveAudioErrorEvent): void => {
        if (active && sameCapture(event, config.sessionId, captureId)) {
          failClosed('capture_failed');
        }
      };

      const onCaptureStopped = (event: BobLiveAudioStoppedEvent): void => {
        if (!sameCapture(event, config.sessionId, captureId) || expectedStop) return;
        const normalReason = normalNativeStop(event);
        if (normalReason) {
          void stopNative(false, normalReason).catch(() => undefined);
        } else {
          failClosed('capture_failed');
        }
      };

      abortListener = (): void => {
        void stopNative(false, 'aborted').catch(() => undefined);
      };
      input.signal.addEventListener('abort', abortListener, { once: true });

      try {
        if (input.signal.aborted) throw aborted();
        pcmSubscription = nativeModule.addListener('onPcmChunk', onPcmChunk);
        vadSubscription = nativeModule.addListener('onVadEvent', onVadEvent);
        errorSubscription = nativeModule.addListener('onCaptureError', onCaptureError);
        stoppedSubscription = nativeModule.addListener('onCaptureStopped', onCaptureStopped);
        if (input.signal.aborted) throw aborted();
        const startTask = nativeModule.startPreparedAsync(config.sessionId, captureId);
        try {
          await raceAbort(startTask, input.signal);
        } catch (error) {
          if (input.signal.aborted) {
            // Fermer d'abord la génération visible, puis attendre le démarrage non annulable. S'il
            // résout tardivement, une seconde preuve d'arrêt empêche toute résurrection du micro.
            await stopNative(false, 'aborted');
            try {
              await startTask;
            } catch {
              throw aborted();
            }
            await stopPreparedCaptureAuthoritatively(nativeModule, config.sessionId, captureId);
          }
          throw error;
        }
        if (!active || input.signal.aborted) throw aborted();
      } catch (startError) {
        try {
          await stopNative(false, input.signal.aborted ? 'aborted' : 'capture_failed');
        } catch (stopError) {
          if (stopError instanceof BobLiveNativeVadSessionError) throw stopError;
          throw new BobLiveNativeVadSessionError('native_vad_session_stop_failed');
        }
        if (startError instanceof BobLiveNativeVadSessionError
          && startError.code === 'native_vad_session_stop_failed') {
          throw startError;
        }
        throw input.signal.aborted
          ? aborted()
          : new BobLiveNativeVadSessionError('native_vad_session_unavailable');
      }

      return {
        captureId,
        capabilities,
        async stop(): Promise<void> {
          await stopNative(false, 'requested');
        },
      };
    },
  };
}
