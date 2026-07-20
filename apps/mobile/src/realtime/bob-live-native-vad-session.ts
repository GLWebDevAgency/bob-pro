import { randomUUID } from 'expo-crypto';

import BobLiveAudioModule, {
  assertBobLiveAudioCapabilities,
  decodeBobLiveAudioStoppedEvent,
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
const NATIVE_PREPARE_TIMEOUT_MS = 8_000;
const NATIVE_START_TIMEOUT_MS = 4_000;
const NATIVE_TERMINAL_GRACE_MS = 2_000;

type NativeSubscription = { remove(): void };

export type BobLiveNativeVadSessionErrorCode =
  | 'native_vad_session_unavailable'
  | 'native_vad_session_aborted'
  | 'native_vad_session_stop_failed'
  | 'native_vad_session_quarantined';

export class BobLiveNativeVadSessionError extends Error {
  constructor(
    readonly code: BobLiveNativeVadSessionErrorCode,
    /** Résout seulement après la preuve native exacte; peut rester pending jusqu'au restart. */
    readonly terminalProof: Promise<void> | null = null,
  ) {
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
  /** Une quarantaine interdit toute nouvelle autorité audio sur ce port. */
  isQuarantined(): boolean;
}

interface BobLiveAudioNativeModuleV2 extends BobLiveAudioNativeModule {
  prepareCaptureV2Async(
    sessionId: string,
    captureId: string,
    maxCaptureDurationMs?: number,
  ): Promise<BobLiveAudioCapabilities>;
  startPreparedCaptureV2Async(sessionId: string, captureId: string): Promise<void>;
  cancelCaptureV2(sessionId: string, captureId: string): boolean;
}

function cancelableV2Module(
  nativeModule: BobLiveAudioNativeModule | null,
): BobLiveAudioNativeModuleV2 | null {
  if (nativeModule === null) return null;
  try {
    const candidate = nativeModule as Partial<BobLiveAudioNativeModuleV2>;
    return typeof candidate.prepareCaptureV2Async === 'function'
      && typeof candidate.startPreparedCaptureV2Async === 'function'
      && typeof candidate.cancelCaptureV2 === 'function'
      ? nativeModule as BobLiveAudioNativeModuleV2
      : null;
  } catch {
    return null;
  }
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

class NativeStartupInterrupted extends Error {
  constructor(readonly reason: 'aborted' | 'timeout') {
    super(reason);
    this.name = 'NativeStartupInterrupted';
  }
}

function raceStartup<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new NativeStartupInterrupted('aborted'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      timer = null;
      callback();
    };
    const onAbort = (): void => finish(() => reject(new NativeStartupInterrupted('aborted')));
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => finish(() => reject(new NativeStartupInterrupted('timeout'))),
      timeoutMs,
    );
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

async function proofWithin(
  proof: Promise<void>,
  observed: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (observed()) return true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      proof.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const quarantinedNativeModules = new WeakMap<object, Promise<void>>();

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
    /** Injection de test uniquement; chaque appel doit retourner un nonce jamais réutilisé. */
    readonly createCaptureId?: () => string;
    readonly prepareTimeoutMs?: number;
    readonly startTimeoutMs?: number;
    readonly terminalGraceMs?: number;
  },
  nativeModule: BobLiveAudioNativeModule | null = BobLiveAudioModule,
): BobLiveNativeVadSessionPort | null {
  const v2NativeModule = cancelableV2Module(nativeModule);
  const prepareTimeoutMs = config.prepareTimeoutMs ?? NATIVE_PREPARE_TIMEOUT_MS;
  const startTimeoutMs = config.startTimeoutMs ?? NATIVE_START_TIMEOUT_MS;
  const terminalGraceMs = config.terminalGraceMs ?? NATIVE_TERMINAL_GRACE_MS;
  if (
    v2NativeModule === null
    || !BOUNDED_ID.test(config.sessionId)
    || !Number.isSafeInteger(config.maxCaptureDurationMs)
    || config.maxCaptureDurationMs < MIN_CAPTURE_DURATION_MS
    || config.maxCaptureDurationMs > MAX_CAPTURE_DURATION_MS
    || !Number.isSafeInteger(prepareTimeoutMs)
    || prepareTimeoutMs < 1
    || prepareTimeoutMs > 30_000
    || !Number.isSafeInteger(startTimeoutMs)
    || startTimeoutMs < 1
    || startTimeoutMs > 30_000
    || !Number.isSafeInteger(terminalGraceMs)
    || terminalGraceMs < 1
    || terminalGraceMs > 10_000
  ) return null;

  const quarantineError = (proof: Promise<void>): BobLiveNativeVadSessionError => {
    const existing = quarantinedNativeModules.get(v2NativeModule);
    if (!existing) quarantinedNativeModules.set(v2NativeModule, proof);
    return new BobLiveNativeVadSessionError(
      'native_vad_session_quarantined',
      existing ?? proof,
    );
  };

  return {
    isQuarantined(): boolean {
      return quarantinedNativeModules.has(v2NativeModule);
    },

    async start(input): Promise<BobLiveNativeVadSession> {
      if (input.signal.aborted) throw aborted();
      const quarantined = quarantinedNativeModules.get(v2NativeModule);
      if (quarantined) throw quarantineError(quarantined);
      let captureId: string;
      try {
        captureId = (config.createCaptureId ?? randomUUID)();
      } catch {
        throw new BobLiveNativeVadSessionError('native_vad_session_unavailable');
      }
      if (!BOUNDED_ID.test(captureId)) {
        throw new BobLiveNativeVadSessionError('native_vad_session_unavailable');
      }

      let terminalObserved = false;
      let resolveTerminal: () => void = () => undefined;
      const terminalProof = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      let terminalHandler: ((event: BobLiveAudioStoppedEvent) => void) | null = null;
      let stoppedSubscription: NativeSubscription | null = null;
      const removeTerminalListener = (): void => {
        safeRemove(stoppedSubscription);
        stoppedSubscription = null;
      };
      try {
        stoppedSubscription = v2NativeModule.addListener('onCaptureStopped', (event) => {
          let decoded: BobLiveAudioStoppedEvent;
          try {
            decoded = decodeBobLiveAudioStoppedEvent(event, config.sessionId, captureId);
          } catch {
            return;
          }
          if (terminalObserved) return;
          terminalObserved = true;
          resolveTerminal();
          terminalHandler?.(decoded);
        });
      } catch {
        removeTerminalListener();
        throw new BobLiveNativeVadSessionError('native_vad_session_unavailable');
      }
      void terminalProof.then(removeTerminalListener, removeTerminalListener);

      const cancelAndAwaitTerminal = async (): Promise<boolean> => {
        try {
          v2NativeModule.cancelCaptureV2(config.sessionId, captureId);
        } catch {
          // Une terminalité native exacte peut encore arriver après une rupture du bridge.
        }
        return proofWithin(terminalProof, () => terminalObserved, terminalGraceMs);
      };

      let capabilities: BobLiveAudioCapabilities;
      let prepareTask: Promise<BobLiveAudioCapabilities>;
      try {
        prepareTask = v2NativeModule.prepareCaptureV2Async(
          config.sessionId,
          captureId,
          config.maxCaptureDurationMs,
        );
      } catch {
        const proved = await cancelAndAwaitTerminal();
        if (!proved) throw quarantineError(terminalProof);
        throw input.signal.aborted
          ? aborted()
          : new BobLiveNativeVadSessionError('native_vad_session_unavailable');
      }
      void prepareTask.catch(() => undefined);
      try {
        capabilities = await raceStartup(prepareTask, input.signal, prepareTimeoutMs);
        assertBobLiveAudioCapabilities(capabilities, config.sessionId);
        if (
          preparedCaptureId(capabilities) !== captureId
          || capabilities.maxCaptureDurationMs !== config.maxCaptureDurationMs
        ) throw new Error('native_vad_session_contract_mismatch');
      } catch (prepareError) {
        const proved = await cancelAndAwaitTerminal();
        if (!proved) throw quarantineError(terminalProof);
        if (
          input.signal.aborted
          || (prepareError instanceof NativeStartupInterrupted
            && prepareError.reason === 'aborted')
        ) throw aborted();
        throw new BobLiveNativeVadSessionError('native_vad_session_unavailable');
      }

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
      let abortListener: (() => void) | null = null;

      const removeDataListeners = (): void => {
        safeRemove(pcmSubscription);
        safeRemove(vadSubscription);
        safeRemove(errorSubscription);
        pcmSubscription = null;
        vadSubscription = null;
        errorSubscription = null;
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
        removeDataListeners();
        const cancelledUtterance = activeUtterance;
        activeUtterance = null;
        stopTask = Promise.resolve().then(async () => {
          const proved = await cancelAndAwaitTerminal();
          if (!proved) {
            reportErrorOnce();
            throw quarantineError(terminalProof);
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
          await v2NativeModule.acknowledgePcmAsync(config.sessionId, captureId, sequence);
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
        if (expectedStop) return;
        active = false;
        removeDataListeners();
        if (abortListener) {
          input.signal.removeEventListener('abort', abortListener);
          abortListener = null;
        }
        const cancelledUtterance = activeUtterance;
        activeUtterance = null;
        const normalReason = normalNativeStop(event);
        if (!normalReason) reportErrorOnce();
        if (cancelledUtterance) {
          try {
            input.onSpeechCancelled({
              ...cancelledUtterance,
              reason: normalReason ?? 'capture_failed',
            });
          } catch {
            // La terminalité réseau reste indépendante du nettoyage natif déjà prouvé.
          }
        }
      };
      terminalHandler = onCaptureStopped;

      abortListener = (): void => {
        void stopNative(false, 'aborted').catch(() => undefined);
      };
      input.signal.addEventListener('abort', abortListener, { once: true });

      try {
        if (input.signal.aborted) throw aborted();
        pcmSubscription = v2NativeModule.addListener('onPcmChunk', onPcmChunk);
        vadSubscription = v2NativeModule.addListener('onVadEvent', onVadEvent);
        errorSubscription = v2NativeModule.addListener('onCaptureError', onCaptureError);
        if (input.signal.aborted) throw aborted();
        const startTask = v2NativeModule.startPreparedCaptureV2Async(
          config.sessionId,
          captureId,
        );
        void startTask.catch(() => undefined);
        try {
          await raceStartup(startTask, input.signal, startTimeoutMs);
        } catch (error) {
          await stopNative(false, input.signal.aborted ? 'aborted' : 'capture_failed');
          throw error;
        }
        if (!active || terminalObserved || input.signal.aborted) throw aborted();
      } catch (startError) {
        try {
          await stopNative(false, input.signal.aborted ? 'aborted' : 'capture_failed');
        } catch (stopError) {
          if (stopError instanceof BobLiveNativeVadSessionError) throw stopError;
          throw quarantineError(terminalProof);
        }
        throw input.signal.aborted
          || (startError instanceof NativeStartupInterrupted
            && startError.reason === 'aborted')
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
