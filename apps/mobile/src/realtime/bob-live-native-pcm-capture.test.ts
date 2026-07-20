import type {
  BobLiveAudioCapabilities,
  BobLiveAudioNativeModule,
  BobLiveAudioPcmChunkEvent,
} from '../../modules/bob-live-audio';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../modules/bob-live-audio/src/BobLiveAudioModule', () => ({
  default: null,
}));

import { createBobLiveNativePcmCapture } from './bob-live-native-pcm-capture';

const SESSION_ID = '018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a11';
const CAPTURE_ID = '018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a12';
const MAX_DURATION_MS = 60_000;
const FRAME = new Uint8Array(1_280).map((_, index) => index % 251);

function frameBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

function capability(overrides: Partial<BobLiveAudioCapabilities> = {}): BobLiveAudioCapabilities {
  return {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    encoding: 'pcm_s16le',
    sampleRateHz: 16_000,
    channels: 1,
    frameDurationMs: 40,
    maxInFlightFrames: 16,
    maxCaptureDurationMs: MAX_DURATION_MS,
    acousticEchoCancellation: 'unknown',
    noiseSuppression: 'unknown',
    automaticGainControl: 'unknown',
    vadConfigVersion: 'bob-live-vad-foundation-1',
    vadEventOrdering: 'pcm_before_vad',
    vadAnalysisWindowMs: 20,
    vadPreRollMs: 240,
    vadSpeechStartMs: 60,
    vadSpeechEndMs: 700,
    vadMaximumUtteranceMs: 30_000,
    fullDuplexCertified: false,
    ...overrides,
  };
}

type EventName = 'onPcmChunk' | 'onCaptureError' | 'onCaptureStopped';

function nativeHarness(
  input: {
    readonly prepare?: () => Promise<BobLiveAudioCapabilities>;
    readonly start?: () => Promise<void>;
    readonly acknowledge?: (sequence: number) => Promise<void>;
    readonly stop?: (attempt: number) => Promise<void>;
  } = {},
): {
  readonly module: BobLiveAudioNativeModule;
  readonly log: string[];
  readonly prepare: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
  readonly acknowledge: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  emit(name: EventName, value: unknown): void;
  listenerCount(name: EventName): number;
} {
  const listeners = new Map<EventName, Set<(value: never) => void>>();
  const log: string[] = [];
  const prepare = vi.fn(async () => {
    log.push('prepare');
    return input.prepare ? input.prepare() : capability();
  });
  const start = vi.fn(async () => {
    log.push('start');
    await input.start?.();
  });
  const acknowledge = vi.fn(async (_sessionId: string, _captureId: string, sequence: number) => {
    log.push(`ack:${sequence}`);
    await input.acknowledge?.(sequence);
  });
  let stopAttempt = 0;
  const stop = vi.fn(async () => {
    log.push('stop');
    stopAttempt += 1;
    await input.stop?.(stopAttempt);
  });
  const module = {
    prepareAsync: prepare,
    startPreparedAsync: start,
    acknowledgePcmAsync: acknowledge,
    stopAsync: stop,
    addListener(name: EventName, listener: (value: never) => void) {
      log.push(`listen:${name}`);
      const bucket = listeners.get(name) ?? new Set<(value: never) => void>();
      listeners.set(name, bucket);
      bucket.add(listener);
      return {
        remove: vi.fn(() => {
          bucket.delete(listener);
        }),
      };
    },
  } as unknown as BobLiveAudioNativeModule;
  return {
    module,
    log,
    prepare,
    start,
    acknowledge,
    stop,
    emit(name, value) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(value as never);
    },
    listenerCount(name) {
      return listeners.get(name)?.size ?? 0;
    },
  };
}

function pcmEvent(
  sequence: number,
  overrides: Partial<BobLiveAudioPcmChunkEvent> = {},
): BobLiveAudioPcmChunkEvent {
  return {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    sequence,
    capturedAtMonotonicMs: 100 + sequence * 40,
    pcmBase64: frameBase64(FRAME),
    ...overrides,
  };
}

async function startCapture(
  harness: ReturnType<typeof nativeHarness>,
  input: {
    readonly signal?: AbortSignal;
    readonly onChunk?: (pcm: Uint8Array) => boolean;
    readonly onError?: () => void;
  } = {},
) {
  const capture = createBobLiveNativePcmCapture(
    { sessionId: SESSION_ID, maxCaptureDurationMs: MAX_DURATION_MS },
    harness.module,
  );
  if (!capture) throw new Error('capture missing');
  return capture.start({
    encoding: 'pcm_s16le',
    sampleRateHz: 16_000,
    channels: 1,
    signal: input.signal ?? new AbortController().signal,
    onChunk: input.onChunk ?? (() => true),
    onError: input.onError ?? (() => undefined),
  });
}

describe('Bob Live native PCM capture adapter', () => {
  it('reste honnêtement indisponible sans module ou avec un budget invalide', () => {
    expect(
      createBobLiveNativePcmCapture(
        {
          sessionId: SESSION_ID,
          maxCaptureDurationMs: MAX_DURATION_MS,
        },
        null,
      ),
    ).toBeNull();
    expect(
      createBobLiveNativePcmCapture(
        {
          sessionId: '../outside',
          maxCaptureDurationMs: MAX_DURATION_MS,
        },
        nativeHarness().module,
      ),
    ).toBeNull();
    expect(
      createBobLiveNativePcmCapture(
        {
          sessionId: SESSION_ID,
          maxCaptureDurationMs: 999,
        },
        nativeHarness().module,
      ),
    ).toBeNull();
  });

  it('installe decoder et listeners avant start, puis ACK uniquement les trames acceptées', async () => {
    let releaseFirstAck!: () => void;
    const firstAck = new Promise<void>((resolve) => {
      releaseFirstAck = resolve;
    });
    const harness = nativeHarness({
      acknowledge: (sequence) => (sequence === 0 ? firstAck : Promise.resolve()),
    });
    const onChunk = vi.fn(() => true);
    const session = await startCapture(harness, { onChunk });

    expect(harness.log.slice(0, 5)).toEqual([
      'prepare',
      'listen:onPcmChunk',
      'listen:onCaptureError',
      'listen:onCaptureStopped',
      'start',
    ]);
    expect(harness.prepare).toHaveBeenCalledWith(SESSION_ID, MAX_DURATION_MS);
    harness.emit('onPcmChunk', pcmEvent(0));
    harness.emit('onPcmChunk', pcmEvent(1));
    await Promise.resolve();

    expect(onChunk).toHaveBeenNthCalledWith(1, FRAME);
    expect(onChunk).toHaveBeenNthCalledWith(2, FRAME);
    expect(harness.acknowledge).toHaveBeenCalledTimes(1);
    expect(harness.acknowledge).toHaveBeenCalledWith(SESSION_ID, CAPTURE_ID, 0);
    releaseFirstAck();
    await firstAck;
    await vi.waitFor(() => expect(harness.acknowledge).toHaveBeenCalledTimes(2));
    expect(harness.acknowledge).toHaveBeenNthCalledWith(2, SESSION_ID, CAPTURE_ID, 1);

    await session.stop();
    await session.stop();
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.listenerCount('onPcmChunk')).toBe(0);
  });

  it('coupe sans ACK et signale une seule fois si le transport refuse une trame', async () => {
    const harness = nativeHarness();
    const onError = vi.fn();
    await startCapture(harness, { onChunk: () => false, onError });
    harness.emit('onPcmChunk', pcmEvent(0));
    harness.emit('onPcmChunk', pcmEvent(1));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.acknowledge).not.toHaveBeenCalled();
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('fail-close sur dérive de séquence, échec ACK ou arrêt natif inattendu', async () => {
    const sequenceHarness = nativeHarness();
    const sequenceError = vi.fn();
    await startCapture(sequenceHarness, { onError: sequenceError });
    sequenceHarness.emit('onPcmChunk', pcmEvent(1));
    await Promise.resolve();
    expect(sequenceError).toHaveBeenCalledTimes(1);
    expect(sequenceHarness.stop).toHaveBeenCalledTimes(1);

    const ackHarness = nativeHarness({
      acknowledge: async () => {
        throw new Error('bridge failed');
      },
    });
    const ackError = vi.fn();
    await startCapture(ackHarness, { onError: ackError });
    ackHarness.emit('onPcmChunk', pcmEvent(0));
    await vi.waitFor(() => expect(ackError).toHaveBeenCalledTimes(1));
    expect(ackError).toHaveBeenCalledTimes(1);
    expect(ackHarness.stop).toHaveBeenCalledTimes(1);

    const stoppedHarness = nativeHarness();
    const stoppedError = vi.fn();
    await startCapture(stoppedHarness, { onError: stoppedError });
    stoppedHarness.emit('onCaptureStopped', {
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      reason: 'watchdog_timeout',
    });
    await Promise.resolve();
    expect(stoppedError).toHaveBeenCalledTimes(1);
    expect(stoppedHarness.stop).toHaveBeenCalledTimes(1);
  });

  it('ignore les événements d’une ancienne capture et traite abort comme une fermeture normale', async () => {
    const harness = nativeHarness();
    const abort = new AbortController();
    const onError = vi.fn();
    await startCapture(harness, { signal: abort.signal, onError });
    harness.emit('onCaptureError', {
      sessionId: SESSION_ID,
      captureId: 'stale-capture',
      code: 'capture_runtime_failed',
    });
    expect(harness.stop).not.toHaveBeenCalled();
    abort.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('retente une seule fois un stop bridge transitoire avant de confirmer la fermeture', async () => {
    const harness = nativeHarness({
      stop: async (attempt) => {
        if (attempt === 1) throw new Error('bridge transitoire');
      },
    });
    const session = await startCapture(harness);

    await expect(session.stop()).resolves.toBeUndefined();
    await expect(session.stop()).resolves.toBeUndefined();

    expect(harness.stop).toHaveBeenCalledTimes(2);
    expect(harness.listenerCount('onPcmChunk')).toBe(0);
  });

  it('rejette avec une erreur opaque et idempotente si aucun stop natif n’est confirmé', async () => {
    const harness = nativeHarness({
      stop: async () => {
        throw new Error('secret bridge detail');
      },
    });
    const session = await startCapture(harness);

    await expect(session.stop()).rejects.toMatchObject({
      name: 'MistralPcmCaptureStopError',
      code: 'capture_stop_unconfirmed',
      message: 'capture_stop_unconfirmed',
    });
    await expect(session.stop()).rejects.toMatchObject({ code: 'capture_stop_unconfirmed' });

    expect(harness.stop).toHaveBeenCalledTimes(2);
  });

  it('refuse une préparation native qui dérive du budget serveur et libère la génération', async () => {
    const harness = nativeHarness({
      prepare: async () => capability({ maxCaptureDurationMs: MAX_DURATION_MS + 1 }),
    });
    await expect(startCapture(harness)).rejects.toThrow('native_capture_unavailable');
    // Le contrat a dérivé avant installation des listeners : aucun micro ne doit être démarré.
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.stop).toHaveBeenCalledWith(SESSION_ID, CAPTURE_ID);
  });

  it('ne masque jamais un stop non confirmé pendant la compensation de préparation', async () => {
    const harness = nativeHarness({
      prepare: async () => capability({ maxCaptureDurationMs: MAX_DURATION_MS + 1 }),
      stop: async () => {
        throw new Error('native detail');
      },
    });

    await expect(startCapture(harness)).rejects.toMatchObject({
      code: 'capture_stop_unconfirmed',
      message: 'capture_stop_unconfirmed',
    });
    expect(harness.stop).toHaveBeenCalledTimes(2);
    expect(harness.start).not.toHaveBeenCalled();
  });
});
