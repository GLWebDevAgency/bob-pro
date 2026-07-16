import type {
  BobLiveAudioCapabilities,
  BobLiveAudioNativeModule,
  BobLiveAudioPcmChunkEvent,
  BobLiveAudioVadEvent,
} from '../../modules/bob-live-audio';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../modules/bob-live-audio/src/BobLiveAudioModule', () => ({
  default: null,
}));

import {
  createBobLiveNativeVadSession,
  type BobLiveNativeVadSessionInput,
} from './bob-live-native-vad-session';

const SESSION_ID = '018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a21';
const CAPTURE_ID = '018f1f47-4bd5-7e3f-8f48-1cc9b7ec5a22';
const MAX_DURATION_MS = 60_000;
const FRAME = new Uint8Array(1_280).map((_, index) => index % 251);

type EventName = 'onPcmChunk' | 'onVadEvent' | 'onCaptureError' | 'onCaptureStopped';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

function pcmEvent(
  sequence: number,
  overrides: Partial<BobLiveAudioPcmChunkEvent> = {},
): BobLiveAudioPcmChunkEvent {
  return {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    sequence,
    capturedAtMonotonicMs: 1_000 + sequence * 40,
    pcmBase64: frameBase64(FRAME),
    ...overrides,
  };
}

function speechStarted(overrides: Partial<BobLiveAudioVadEvent> = {}): BobLiveAudioVadEvent {
  return {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    kind: 'speech_started',
    configVersion: 'bob-live-vad-foundation-1',
    utteranceIndex: 1,
    detectedAtMonotonicMs: 1_380,
    preRollMs: 240,
    startedAtMonotonicMs: 1_320,
    endedAtMonotonicMs: null,
    forcedEnd: false,
    energyDbfs: -24,
    noiseFloorDbfs: -52,
    ...overrides,
  };
}

function speechEnded(overrides: Partial<BobLiveAudioVadEvent> = {}): BobLiveAudioVadEvent {
  return {
    ...speechStarted(),
    kind: 'speech_ended',
    detectedAtMonotonicMs: 2_180,
    endedAtMonotonicMs: 1_480,
    ...overrides,
  };
}

function nativeHarness(
  input: {
    readonly prepare?: () => Promise<BobLiveAudioCapabilities>;
    readonly start?: () => Promise<void>;
    readonly acknowledge?: (sequence: number) => Promise<void>;
    readonly stop?: (attempt: number) => Promise<void>;
    readonly addListener?: (name: EventName) => void;
  } = {},
) {
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
      input.addListener?.(name);
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
    emit(name: EventName, value: unknown): void {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(value as never);
    },
    listenerCount(name: EventName): number {
      return listeners.get(name)?.size ?? 0;
    },
  };
}

async function startSession(
  harness: ReturnType<typeof nativeHarness>,
  overrides: Partial<
    Parameters<NonNullable<ReturnType<typeof createBobLiveNativeVadSession>>['start']>[0]
  > = {},
) {
  const port = createBobLiveNativeVadSession(
    {
      sessionId: SESSION_ID,
      maxCaptureDurationMs: MAX_DURATION_MS,
    },
    harness.module,
  );
  if (!port) throw new Error('port missing');
  return port.start({
    signal: new AbortController().signal,
    onSpeechStarted: () => true,
    onSpeechFrame: () => true,
    onSpeechEnded: () => true,
    onSpeechCancelled: () => undefined,
    onError: () => undefined,
    ...overrides,
  });
}

function emitPreRoll(harness: ReturnType<typeof nativeHarness>): void {
  for (let sequence = 0; sequence <= 9; sequence += 1) {
    harness.emit('onPcmChunk', pcmEvent(sequence));
  }
}

describe('Bob Live native VAD continuous session', () => {
  it('reste indisponible sans module ou avec une configuration non bornée', () => {
    expect(
      createBobLiveNativeVadSession(
        {
          sessionId: SESSION_ID,
          maxCaptureDurationMs: MAX_DURATION_MS,
        },
        null,
      ),
    ).toBeNull();
    expect(
      createBobLiveNativeVadSession(
        {
          sessionId: '../outside',
          maxCaptureDurationMs: MAX_DURATION_MS,
        },
        nativeHarness().module,
      ),
    ).toBeNull();
    expect(
      createBobLiveNativeVadSession(
        {
          sessionId: SESSION_ID,
          maxCaptureDurationMs: 999,
        },
        nativeHarness().module,
      ),
    ).toBeNull();
  });

  it('installe les quatre listeners avant le micro et remet pré-roll, frames et fin', async () => {
    const harness = nativeHarness();
    const onSpeechStarted = vi.fn<BobLiveNativeVadSessionInput['onSpeechStarted']>(() => true);
    const onSpeechFrame = vi.fn<BobLiveNativeVadSessionInput['onSpeechFrame']>(() => true);
    const onSpeechEnded = vi.fn<BobLiveNativeVadSessionInput['onSpeechEnded']>(() => true);
    const session = await startSession(harness, {
      onSpeechStarted,
      onSpeechFrame,
      onSpeechEnded,
    });

    expect(harness.log.slice(0, 6)).toEqual([
      'prepare',
      'listen:onPcmChunk',
      'listen:onVadEvent',
      'listen:onCaptureError',
      'listen:onCaptureStopped',
      'start',
    ]);
    emitPreRoll(harness);
    harness.emit('onVadEvent', speechStarted());
    harness.emit('onPcmChunk', pcmEvent(10));
    harness.emit('onPcmChunk', pcmEvent(11));
    harness.emit('onVadEvent', speechEnded());

    expect(onSpeechStarted).toHaveBeenCalledTimes(1);
    const startAcceptance = onSpeechStarted.mock.calls[0]?.[0];
    expect(startAcceptance?.initialFrames.map((frame) => frame.captureSequence)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(startAcceptance?.initialFrames[0]?.startedAtMonotonicMs).toBe(1_080);
    expect(onSpeechFrame.mock.calls.map(([value]) => value.frame.captureSequence)).toEqual([
      10, 11,
    ]);
    expect(onSpeechEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'speech_ended',
        lastForwardedCaptureSequence: 11,
      }),
    );
    await vi.waitFor(() => expect(harness.acknowledge).toHaveBeenCalledTimes(12));
    expect(harness.acknowledge.mock.calls.map((call) => call[2])).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);

    await session.stop();
    await session.stop();
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.listenerCount('onVadEvent')).toBe(0);
  });

  it('sérialise les ACK natifs même si leur première Promise reste pendante', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const harness = nativeHarness({
      acknowledge: (sequence) => (sequence === 0 ? first : Promise.resolve()),
    });
    const session = await startSession(harness);
    harness.emit('onPcmChunk', pcmEvent(0));
    harness.emit('onPcmChunk', pcmEvent(1));
    await Promise.resolve();
    expect(harness.acknowledge).toHaveBeenCalledTimes(1);
    releaseFirst();
    await vi.waitFor(() => expect(harness.acknowledge).toHaveBeenCalledTimes(2));
    expect(harness.acknowledge.mock.calls.map((call) => call[2])).toEqual([0, 1]);
    await session.stop();
  });

  it('fail-close sur rejet ACK et borne la queue JS à la capacité native attestée', async () => {
    const rejected = nativeHarness({
      acknowledge: async () => {
        throw new Error('bridge failed');
      },
    });
    const rejectedError = vi.fn();
    await startSession(rejected, { onError: rejectedError });
    rejected.emit('onPcmChunk', pcmEvent(0));
    await vi.waitFor(() => expect(rejectedError).toHaveBeenCalledTimes(1));
    expect(rejected.stop).toHaveBeenCalledTimes(1);

    const firstAck = deferred<void>();
    const bounded = nativeHarness({
      acknowledge: (sequence) => (sequence === 0 ? firstAck.promise : Promise.resolve()),
    });
    const boundedError = vi.fn();
    await startSession(bounded, { onError: boundedError });
    for (let sequence = 0; sequence <= 16; sequence += 1) {
      bounded.emit('onPcmChunk', pcmEvent(sequence));
    }
    await vi.waitFor(() => expect(boundedError).toHaveBeenCalledTimes(1));
    // Les événements ont rempli la borne dans le même tour JS : le fence coupe avant même le
    // premier ACK asynchrone, aucun backlog supplémentaire n'est créé.
    expect(bounded.acknowledge).not.toHaveBeenCalled();
    expect(bounded.stop).toHaveBeenCalledTimes(1);
    firstAck.resolve();
  });

  it('fail-close si le transport refuse le pré-roll ou une frame active, sans ACK de cette frame', async () => {
    const startHarness = nativeHarness();
    const startError = vi.fn();
    const startCancelled = vi.fn();
    await startSession(startHarness, {
      onSpeechStarted: () => false,
      onSpeechCancelled: startCancelled,
      onError: startError,
    });
    emitPreRoll(startHarness);
    startHarness.emit('onVadEvent', speechStarted());
    await vi.waitFor(() => expect(startError).toHaveBeenCalledTimes(1));
    expect(startHarness.stop).toHaveBeenCalledTimes(1);
    expect(startCancelled).toHaveBeenCalledWith({
      utteranceIndex: 1,
      lastCaptureSequence: 9,
      reason: 'transport_rejected',
    });

    const frameHarness = nativeHarness();
    const frameError = vi.fn();
    const frameCancelled = vi.fn();
    await startSession(frameHarness, {
      onSpeechFrame: () => false,
      onSpeechCancelled: frameCancelled,
      onError: frameError,
    });
    emitPreRoll(frameHarness);
    frameHarness.emit('onVadEvent', speechStarted());
    frameHarness.emit('onPcmChunk', pcmEvent(10));
    await vi.waitFor(() => expect(frameError).toHaveBeenCalledTimes(1));
    expect(frameHarness.acknowledge.mock.calls.some((call) => call[2] === 10)).toBe(false);
    expect(frameHarness.stop).toHaveBeenCalledTimes(1);
    expect(frameCancelled).toHaveBeenCalledWith({
      utteranceIndex: 1,
      lastCaptureSequence: 9,
      reason: 'transport_rejected',
    });
  });

  it('émet exactement une terminalité locale si stop survient pendant une utterance', async () => {
    const harness = nativeHarness();
    const onSpeechCancelled = vi.fn();
    const session = await startSession(harness, { onSpeechCancelled });
    emitPreRoll(harness);
    harness.emit('onVadEvent', speechStarted());
    harness.emit('onPcmChunk', pcmEvent(10));
    await session.stop();
    expect(onSpeechCancelled).toHaveBeenCalledTimes(1);
    expect(onSpeechCancelled).toHaveBeenCalledWith({
      utteranceIndex: 1,
      lastCaptureSequence: 10,
      reason: 'requested',
    });
    await session.stop();
    expect(onSpeechCancelled).toHaveBeenCalledTimes(1);
  });

  it('fail-close une dérive PCM ou VAD et ne signale l’erreur qu’une fois', async () => {
    const pcmHarness = nativeHarness();
    const pcmError = vi.fn();
    await startSession(pcmHarness, { onError: pcmError });
    pcmHarness.emit('onPcmChunk', pcmEvent(1));
    pcmHarness.emit('onPcmChunk', pcmEvent(2));
    await vi.waitFor(() => expect(pcmError).toHaveBeenCalledTimes(1));
    expect(pcmHarness.stop).toHaveBeenCalledTimes(1);

    const vadHarness = nativeHarness();
    const vadError = vi.fn();
    await startSession(vadHarness, { onError: vadError });
    vadHarness.emit('onPcmChunk', pcmEvent(0));
    vadHarness.emit(
      'onVadEvent',
      speechEnded({
        startedAtMonotonicMs: 1_000,
        preRollMs: 0,
        detectedAtMonotonicMs: 1_040,
        endedAtMonotonicMs: 1_020,
      }),
    );
    await vi.waitFor(() => expect(vadError).toHaveBeenCalledTimes(1));
    expect(vadHarness.stop).toHaveBeenCalledTimes(1);

    const profileHarness = nativeHarness();
    const profileError = vi.fn();
    const profileSpeechStarted = vi.fn(() => true);
    await startSession(profileHarness, {
      onSpeechStarted: profileSpeechStarted,
      onError: profileError,
    });
    emitPreRoll(profileHarness);
    profileHarness.emit(
      'onVadEvent',
      speechStarted({
        configVersion: 'bob-live-vad-foundation-2',
      }),
    );
    await vi.waitFor(() => expect(profileError).toHaveBeenCalledTimes(1));
    expect(profileSpeechStarted).not.toHaveBeenCalled();
    expect(profileHarness.stop).toHaveBeenCalledTimes(1);
  });

  it('annule explicitement le tour si le transport refuse speech_ended', async () => {
    const harness = nativeHarness();
    const onSpeechCancelled = vi.fn();
    const onError = vi.fn();
    await startSession(harness, {
      onSpeechEnded: () => false,
      onSpeechCancelled,
      onError,
    });
    emitPreRoll(harness);
    harness.emit('onVadEvent', speechStarted());
    harness.emit('onPcmChunk', pcmEvent(10));
    harness.emit('onVadEvent', speechEnded());
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onSpeechCancelled).toHaveBeenCalledWith({
      utteranceIndex: 1,
      lastCaptureSequence: 10,
      reason: 'transport_rejected',
    });
  });

  it('traite abort et stop comme normaux, puis ignore tout événement tardif', async () => {
    const harness = nativeHarness();
    const abort = new AbortController();
    const onSpeechStarted = vi.fn(() => true);
    const onError = vi.fn();
    const session = await startSession(harness, {
      signal: abort.signal,
      onSpeechStarted,
      onError,
    });
    abort.abort();
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledTimes(1));
    emitPreRoll(harness);
    harness.emit('onVadEvent', speechStarted());
    expect(onSpeechStarted).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    await session.stop();
    expect(harness.stop).toHaveBeenCalledTimes(1);
  });

  it('traite background de façon déterministe comme un arrêt normal avant ou après abort', async () => {
    const nativeFirst = nativeHarness();
    const nativeFirstAbort = new AbortController();
    const nativeFirstError = vi.fn();
    await startSession(nativeFirst, {
      signal: nativeFirstAbort.signal,
      onError: nativeFirstError,
    });
    nativeFirst.emit('onCaptureStopped', {
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      reason: 'background',
    });
    await vi.waitFor(() => expect(nativeFirst.stop).toHaveBeenCalledTimes(1));
    nativeFirstAbort.abort();
    expect(nativeFirstError).not.toHaveBeenCalled();

    const abortFirst = nativeHarness();
    const abortFirstController = new AbortController();
    const abortFirstError = vi.fn();
    await startSession(abortFirst, {
      signal: abortFirstController.signal,
      onError: abortFirstError,
    });
    abortFirstController.abort();
    await vi.waitFor(() => expect(abortFirst.stop).toHaveBeenCalledTimes(1));
    abortFirst.emit('onCaptureStopped', {
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      reason: 'background',
    });
    expect(abortFirst.stop).toHaveBeenCalledTimes(1);
    expect(abortFirstError).not.toHaveBeenCalled();
  });

  it('ignore une ancienne capture mais fail-close un arrêt natif inattendu de la capture active', async () => {
    const harness = nativeHarness();
    const onError = vi.fn();
    await startSession(harness, { onError });
    harness.emit('onCaptureError', {
      sessionId: SESSION_ID,
      captureId: 'stale-capture',
      code: 'capture_runtime_failed',
    });
    expect(harness.stop).not.toHaveBeenCalled();
    harness.emit('onCaptureStopped', {
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      reason: 'watchdog_timeout',
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(harness.stop).toHaveBeenCalledTimes(1);
  });

  it('libère toute génération préparée si le contrat ou le démarrage échoue', async () => {
    const mismatch = nativeHarness({
      prepare: async () => capability({ maxCaptureDurationMs: MAX_DURATION_MS + 1 }),
    });
    await expect(startSession(mismatch)).rejects.toThrow('native_vad_session_unavailable');
    expect(mismatch.start).not.toHaveBeenCalled();
    expect(mismatch.stop).toHaveBeenCalledWith(SESSION_ID, CAPTURE_ID);

    const startFailure = nativeHarness({
      start: async () => {
        throw new Error('native start failed');
      },
    });
    await expect(startSession(startFailure)).rejects.toThrow('native_vad_session_unavailable');
    expect(startFailure.stop).toHaveBeenCalledTimes(1);
    expect(startFailure.listenerCount('onPcmChunk')).toBe(0);
  });

  it('attend et ferme autoritairement une préparation ou un démarrage tardif après abort', async () => {
    const latePrepare = deferred<BobLiveAudioCapabilities>();
    const prepareHarness = nativeHarness({ prepare: () => latePrepare.promise });
    const prepareAbort = new AbortController();
    const preparing = startSession(prepareHarness, { signal: prepareAbort.signal });
    let prepareSettled = false;
    void preparing.then(
      () => { prepareSettled = true; },
      () => { prepareSettled = true; },
    );
    prepareAbort.abort();
    await Promise.resolve();
    expect(prepareSettled).toBe(false);
    latePrepare.resolve(capability());
    await expect(preparing).rejects.toThrow('native_vad_session_aborted');
    expect(prepareHarness.stop).toHaveBeenCalledWith(SESSION_ID, CAPTURE_ID);

    const lateStart = deferred<void>();
    const startHarness = nativeHarness({ start: () => lateStart.promise });
    const startAbort = new AbortController();
    const starting = startSession(startHarness, { signal: startAbort.signal });
    let startSettled = false;
    void starting.then(
      () => { startSettled = true; },
      () => { startSettled = true; },
    );
    await vi.waitFor(() => expect(startHarness.start).toHaveBeenCalledTimes(1));
    startAbort.abort();
    await vi.waitFor(() => expect(startHarness.stop).toHaveBeenCalledTimes(1));
    expect(startSettled).toBe(false);
    lateStart.resolve();
    await expect(starting).rejects.toThrow('native_vad_session_aborted');
    expect(startHarness.stop).toHaveBeenCalledTimes(2);
  });

  it('ne masque jamais un échec de fermeture après prepare/start tardif', async () => {
    const latePrepare = deferred<BobLiveAudioCapabilities>();
    const prepareHarness = nativeHarness({
      prepare: () => latePrepare.promise,
      stop: async () => { throw new Error('bridge unavailable'); },
    });
    const prepareAbort = new AbortController();
    const preparing = startSession(prepareHarness, { signal: prepareAbort.signal });
    prepareAbort.abort();
    latePrepare.resolve(capability());
    await expect(preparing).rejects.toThrow('native_vad_session_stop_failed');
    expect(prepareHarness.stop).toHaveBeenCalledTimes(2);

    const lateStart = deferred<void>();
    const startHarness = nativeHarness({
      start: () => lateStart.promise,
      stop: async (attempt) => {
        if (attempt >= 2) throw new Error('late bridge unavailable');
      },
    });
    const startAbort = new AbortController();
    const starting = startSession(startHarness, { signal: startAbort.signal });
    await vi.waitFor(() => expect(startHarness.start).toHaveBeenCalledTimes(1));
    startAbort.abort();
    await vi.waitFor(() => expect(startHarness.stop).toHaveBeenCalledTimes(1));
    lateStart.resolve();
    await expect(starting).rejects.toThrow('native_vad_session_stop_failed');
    expect(startHarness.stop).toHaveBeenCalledTimes(3);
  });

  it('nettoie les listeners déjà installés si une installation partielle échoue', async () => {
    const harness = nativeHarness({
      addListener: (name) => {
        if (name === 'onCaptureError') throw new Error('listener unavailable');
      },
    });
    await expect(startSession(harness)).rejects.toThrow('native_vad_session_unavailable');
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.listenerCount('onPcmChunk')).toBe(0);
    expect(harness.listenerCount('onVadEvent')).toBe(0);
  });

  it('fence avant onError, retente un stop rejeté et n’atteste jamais une fermeture impossible', async () => {
    const transient = nativeHarness({
      stop: async (attempt) => {
        if (attempt === 1) throw new Error('bridge transient');
      },
    });
    const transientSession = await startSession(transient);
    await transientSession.stop();
    expect(transient.stop).toHaveBeenCalledTimes(2);

    const rejected = nativeHarness({
      stop: async () => {
        throw new Error('bridge unavailable');
      },
    });
    const rejectedError = vi.fn(() => {
      expect(rejected.listenerCount('onPcmChunk')).toBe(0);
      expect(rejected.listenerCount('onVadEvent')).toBe(0);
      expect(rejected.stop).toHaveBeenCalledTimes(2);
    });
    const rejectedSession = await startSession(rejected, { onError: rejectedError });
    await expect(rejectedSession.stop()).rejects.toThrow('native_vad_session_stop_failed');
    expect(rejectedError).toHaveBeenCalledTimes(1);
    await expect(rejectedSession.stop()).rejects.toThrow('native_vad_session_stop_failed');
    expect(rejected.stop).toHaveBeenCalledTimes(2);
    expect(rejectedError).toHaveBeenCalledTimes(1);
  });

  it('borne aussi un stop natif qui ne résout jamais', async () => {
    vi.useFakeTimers();
    try {
      const harness = nativeHarness({
        stop: async () => new Promise<void>(() => undefined),
      });
      const onError = vi.fn();
      const session = await startSession(harness, { onError });
      const stopping = session.stop();
      const rejectedStop = expect(stopping).rejects.toThrow('native_vad_session_stop_failed');
      await vi.advanceTimersByTimeAsync(2_001);
      expect(harness.stop).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_001);
      await rejectedStop;
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
