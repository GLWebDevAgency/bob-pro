import BobLiveAudioModule, {
  assertBobLiveAudioCapabilities,
  BobLiveAudioPcmStreamDecoder,
  type BobLiveAudioErrorEvent,
  type BobLiveAudioNativeModule,
  type BobLiveAudioPcmChunkEvent,
  type BobLiveAudioStoppedEvent,
} from '../../modules/bob-live-audio';

import type { MistralPcmCapturePort, MistralPcmCaptureSession } from './mistral-pcm-uplink';
import { MistralPcmCaptureStopError } from './mistral-pcm-uplink';

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/u;
const MIN_CAPTURE_DURATION_MS = 1_000;
const MAX_CAPTURE_DURATION_MS = 900_000;
const NATIVE_STOP_ATTEMPTS = 2;

type NativeSubscription = { remove(): void };

function sameCapture(event: unknown, sessionId: string, captureId: string): boolean {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return false;
  try {
    const value = event as Record<string, unknown>;
    return value.sessionId === sessionId && value.captureId === captureId;
  } catch {
    return false;
  }
}

function safeRemove(subscription: NativeSubscription | null): void {
  try {
    subscription?.remove();
  } catch {
    // Une subscription native défaillante ne doit jamais empêcher l'arrêt du micro.
  }
}

function preparedCaptureId(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const captureId = (value as Record<string, unknown>).captureId;
    return typeof captureId === 'string' && SESSION_ID.test(captureId) ? captureId : null;
  } catch {
    return null;
  }
}

async function stopNativeCapture(
  nativeModule: BobLiveAudioNativeModule,
  sessionId: string,
  captureId: string,
): Promise<void> {
  for (let attempt = 0; attempt < NATIVE_STOP_ATTEMPTS; attempt += 1) {
    try {
      await nativeModule.stopAsync(sessionId, captureId);
      return;
    } catch {
      // Le bridge peut subir une erreur transitoire. Une seule relance immédiate est autorisée :
      // au-delà, l'absence de preuve d'arrêt doit remonter jusqu'à l'autorité audio.
    }
  }
  throw new MistralPcmCaptureStopError();
}

/**
 * Adaptateur strict entre Expo Modules et le transport PCM Mistral.
 *
 * Le module natif est optionnel (Expo Go/web). Quand il existe, le démarrage reste en deux
 * phases : préparation, installation des trois listeners et du décodeur fencé, puis seulement
 * ouverture physique du flux. Une trame n'est acquittée qu'après acceptation par l'uplink.
 */
export function createBobLiveNativePcmCapture(
  input: {
    readonly sessionId: string;
    readonly maxCaptureDurationMs: number;
  },
  nativeModule: BobLiveAudioNativeModule | null = BobLiveAudioModule,
): MistralPcmCapturePort | null {
  if (
    nativeModule === null ||
    !SESSION_ID.test(input.sessionId) ||
    !Number.isSafeInteger(input.maxCaptureDurationMs) ||
    input.maxCaptureDurationMs < MIN_CAPTURE_DURATION_MS ||
    input.maxCaptureDurationMs > MAX_CAPTURE_DURATION_MS
  )
    return null;

  return {
    async start(captureInput): Promise<MistralPcmCaptureSession> {
      if (
        captureInput.encoding !== 'pcm_s16le' ||
        captureInput.sampleRateHz !== 16_000 ||
        captureInput.channels !== 1 ||
        captureInput.signal.aborted
      )
        throw new Error('native_capture_unavailable');

      let capabilities: Awaited<ReturnType<BobLiveAudioNativeModule['prepareAsync']>>;
      let allocatedCaptureId: string | null = null;
      try {
        capabilities = await nativeModule.prepareAsync(input.sessionId, input.maxCaptureDurationMs);
        allocatedCaptureId = preparedCaptureId(capabilities);
        assertBobLiveAudioCapabilities(capabilities, input.sessionId);
        if (capabilities.maxCaptureDurationMs !== input.maxCaptureDurationMs) {
          throw new Error('native_capture_contract_mismatch');
        }
      } catch {
        if (allocatedCaptureId) {
          await stopNativeCapture(nativeModule, input.sessionId, allocatedCaptureId);
        }
        throw new Error('native_capture_unavailable');
      }

      const captureId = capabilities.captureId;
      const decoder = new BobLiveAudioPcmStreamDecoder(input.sessionId, captureId);
      let active = true;
      let expectedStop = false;
      let failureReported = false;
      let stopTask: Promise<void> | null = null;
      let acknowledgementTail = Promise.resolve();
      let pcmSubscription: NativeSubscription | null = null;
      let errorSubscription: NativeSubscription | null = null;
      let stoppedSubscription: NativeSubscription | null = null;
      let abortListener: (() => void) | null = null;

      const removeListeners = (): void => {
        safeRemove(pcmSubscription);
        safeRemove(errorSubscription);
        safeRemove(stoppedSubscription);
        pcmSubscription = null;
        errorSubscription = null;
        stoppedSubscription = null;
      };

      const stopNative = (reportFailure: boolean): Promise<void> => {
        if (!stopTask) {
          active = false;
          expectedStop = true;
          if (abortListener) {
            captureInput.signal.removeEventListener('abort', abortListener);
            abortListener = null;
          }
          removeListeners();
          stopTask = stopNativeCapture(nativeModule, input.sessionId, captureId);
        }
        // Le Promise d'arrêt est installé avant le callback : un onError réentrant ne peut pas
        // lancer un second stop ni perdre la rejection autoritative.
        if (reportFailure && !failureReported) {
          failureReported = true;
          try {
            captureInput.onError();
          } catch {
            // Le callback applicatif ne possède pas le cycle de vie natif.
          }
        }
        return stopTask;
      };

      const failClosed = (): void => {
        void stopNative(true).catch(() => undefined);
      };

      const onPcmChunk = (event: BobLiveAudioPcmChunkEvent): void => {
        if (!active || captureInput.signal.aborted) return;
        let decoded: ReturnType<BobLiveAudioPcmStreamDecoder['decode']>;
        try {
          decoded = decoder.decode(event);
        } catch {
          failClosed();
          return;
        }

        let accepted = false;
        try {
          accepted = captureInput.onChunk(decoded.pcm) === true;
        } catch {
          accepted = false;
        }
        if (!accepted) {
          failClosed();
          return;
        }

        // Les ACK restent strictement ordonnés même si le bridge natif résout ses Promises dans
        // un ordre différent. La fenêtre native de 16 trames borne le retard de cette chaîne.
        acknowledgementTail = acknowledgementTail.then(async () => {
          if (!active) return;
          await nativeModule.acknowledgePcmAsync(input.sessionId, captureId, decoded.sequence);
        });
        void acknowledgementTail.catch(() => {
          if (active) failClosed();
        });
      };

      const onCaptureError = (event: BobLiveAudioErrorEvent): void => {
        if (active && sameCapture(event, input.sessionId, captureId)) failClosed();
      };

      const onCaptureStopped = (event: BobLiveAudioStoppedEvent): void => {
        if (!sameCapture(event, input.sessionId, captureId) || expectedStop) return;
        failClosed();
      };

      abortListener = (): void => {
        void stopNative(false).catch(() => undefined);
      };
      captureInput.signal.addEventListener('abort', abortListener, { once: true });

      try {
        if (captureInput.signal.aborted) throw new Error('native_capture_aborted');
        pcmSubscription = nativeModule.addListener('onPcmChunk', onPcmChunk);
        errorSubscription = nativeModule.addListener('onCaptureError', onCaptureError);
        stoppedSubscription = nativeModule.addListener('onCaptureStopped', onCaptureStopped);
        if (captureInput.signal.aborted) throw new Error('native_capture_aborted');
        await nativeModule.startPreparedAsync(input.sessionId, captureId);
        if (!active || captureInput.signal.aborted) throw new Error('native_capture_aborted');
      } catch {
        await stopNative(false);
        throw new Error('native_capture_unavailable');
      }

      return {
        async stop(): Promise<void> {
          await stopNative(false);
        },
      };
    },
  };
}
