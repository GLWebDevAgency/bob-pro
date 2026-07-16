import type {
  BobClient,
  RealtimeVoiceControlReference,
  RealtimeVoiceSpeechFeed,
} from '@bob/api-client';
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeAuditedSpeechPlayerController,
  type RealtimeAuditedSpeechPlaybackPort,
  type RealtimeAuditedSpeechPlayerEvent,
  type RealtimeVerifiedSpeechAudio,
} from './realtime-audited-speech-player';
import type { RealtimePublishedContextFence } from './realtime-control-gate';

const SESSION = '00000000-0000-4000-8000-000000000001';
const TURN = '00000000-0000-4000-8000-000000000002';
const ARTIFACT = '00000000-0000-4000-8000-000000000003';
const DELIVERY = '00000000-0000-4000-8000-000000000004';
const CANCELLATION = '00000000-0000-4000-8000-000000000005';
const DIGEST = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

const READY: Extract<RealtimeVoiceSpeechFeed, { status: 'ready' }> = {
  status: 'ready',
  artifactId: ARTIFACT,
  turnId: TURN,
  sequence: 1,
  contextRevision: 7,
  contextDigest: DIGEST,
  audioUrl: 'https://storage.bob.test/private/speech?opaque=token',
  audioSha256: SHA,
  mimeType: 'audio/mpeg',
  byteSize: 1_024,
  durationMs: 850,
};

const TERMINAL: Extract<RealtimeVoiceSpeechFeed, { status: 'terminal' }> = {
  status: 'terminal',
  artifactId: ARTIFACT,
  turnId: TURN,
  sequence: 1,
  contextRevision: 7,
  contextDigest: DIGEST,
  reason: 'cancelled',
};

const VERIFIED: RealtimeVerifiedSpeechAudio = {
  opaqueHandle: { local: true },
  sha256: SHA,
  mimeType: 'audio/mpeg',
  byteSize: 1_024,
};

type SpeechClient = Pick<
  BobClient,
  | 'getNextRealtimeVoiceSpeech'
  | 'acknowledgeRealtimeVoiceSpeechDelivery'
  | 'cancelRealtimeVoiceSpeech'
>;

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function unavailable() {
  return { ok: false as const, error: { kind: 'unavailable' as const, service: 'speech' } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function pendingUntilAbort<T>(signal?: AbortSignal): Promise<T> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

async function waitFor(predicate: () => boolean, message = 'condition non atteinte'): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

interface Harness {
  controller: RealtimeAuditedSpeechPlayerController;
  client: {
    getNextRealtimeVoiceSpeech: ReturnType<typeof vi.fn>;
    acknowledgeRealtimeVoiceSpeechDelivery: ReturnType<typeof vi.fn>;
    cancelRealtimeVoiceSpeech: ReturnType<typeof vi.fn>;
  };
  playback: {
    downloadVerified: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    stopImmediately: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  events: RealtimeAuditedSpeechPlayerEvent[];
  setFence(value: RealtimePublishedContextFence | null): void;
}

function harness(overrides: {
  getNext?: SpeechClient['getNextRealtimeVoiceSpeech'];
  deliver?: SpeechClient['acknowledgeRealtimeVoiceSpeechDelivery'];
  cancel?: SpeechClient['cancelRealtimeVoiceSpeech'];
  download?: RealtimeAuditedSpeechPlaybackPort['downloadVerified'];
  play?: RealtimeAuditedSpeechPlaybackPort['play'];
  initialFence?: RealtimePublishedContextFence | null;
  maxConsecutiveFeedErrors?: number;
  maxMutationAttempts?: number;
} = {}): Harness {
  let fence: RealtimePublishedContextFence | null = overrides.initialFence === undefined
    ? { sessionHandle: SESSION, contextRevision: 7, contextDigest: DIGEST }
    : overrides.initialFence;
  const getNext = vi.fn(overrides.getNext ?? ((_handle, _input, signal) => pendingUntilAbort(signal)));
  const deliver = vi.fn(overrides.deliver ?? (async () => ok({})));
  const cancel = vi.fn(overrides.cancel ?? (async () => ok(undefined)));
  const download = vi.fn(overrides.download ?? (async () => VERIFIED));
  const play = vi.fn(overrides.play ?? (async () => undefined));
  const stopImmediately = vi.fn();
  const release = vi.fn();
  const events: RealtimeAuditedSpeechPlayerEvent[] = [];
  let now = 1_000;
  const controller = new RealtimeAuditedSpeechPlayerController({
    sessionHandle: SESSION,
    client: {
      getNextRealtimeVoiceSpeech: getNext,
      acknowledgeRealtimeVoiceSpeechDelivery: deliver,
      cancelRealtimeVoiceSpeech: cancel,
    } as unknown as SpeechClient,
    playback: {
      downloadVerified: download,
      play,
      stopImmediately,
      release,
    },
    currentFence: () => fence,
    createDeliveryId: () => DELIVERY,
    createCancellationId: () => CANCELLATION,
    now: () => ++now,
    longPollMs: 0,
    idleDelayMs: 1,
    maxConsecutiveFeedErrors: overrides.maxConsecutiveFeedErrors,
    maxMutationAttempts: overrides.maxMutationAttempts,
  });
  controller.subscribe((event) => events.push(event));
  return {
    controller,
    client: {
      getNextRealtimeVoiceSpeech: getNext,
      acknowledgeRealtimeVoiceSpeechDelivery: deliver,
      cancelRealtimeVoiceSpeech: cancel,
    },
    playback: { downloadVerified: download, play, stopImmediately, release },
    events,
    setFence(value) { fence = value; },
  };
}

describe('RealtimeAuditedSpeechPlayerController', () => {
  it('refuse de fermer tant que le player natif ne confirme pas son arrêt', async () => {
    const value = harness();
    value.playback.stopImmediately.mockImplementationOnce(() => {
      throw new Error('native output still active');
    });

    await expect(value.controller.close()).rejects.toMatchObject({
      code: 'playback_stop_unconfirmed',
    });
    expect(value.events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'playback_contract_violation',
    }));

    await expect(value.controller.close()).resolves.toBeUndefined();
    expect(value.playback.stopImmediately).toHaveBeenCalledTimes(2);
  });

  it('lit une seule fois, ACK avant le contrôle, puis reprend au curseur suivant sans fuite audio', async () => {
    const control: RealtimeVoiceControlReference = {
      turnId: TURN,
      acknowledgementId: DELIVERY,
      contextRevision: 7,
      contextDigest: DIGEST,
    };
    let call = 0;
    const value = harness({
      getNext: (_handle, _input, signal) => {
        call += 1;
        return call === 1 ? Promise.resolve(ok(READY)) : pendingUntilAbort(signal);
      },
      deliver: async () => ok({ controlReference: control }),
    });

    const running = value.controller.start();
    expect(value.controller.start()).toBe(running);
    await waitFor(() => value.events.some((event) => event.type === 'control_candidate'));

    expect(value.playback.downloadVerified).toHaveBeenCalledWith({
      sourceUrl: READY.audioUrl,
      expectedSha256: SHA,
      expectedMimeType: 'audio/mpeg',
      expectedByteSize: 1_024,
      maximumBytes: 1_024,
      expectedTurnId: TURN,
      expectedArtifactId: ARTIFACT,
    }, expect.any(AbortSignal));
    expect(value.playback.play).toHaveBeenCalledTimes(1);
    expect(value.client.acknowledgeRealtimeVoiceSpeechDelivery).toHaveBeenCalledWith(
      SESSION,
      TURN,
      ARTIFACT,
      { deliveryId: DELIVERY, audioSha256: SHA },
      expect.any(AbortSignal),
    );
    expect(value.events.map((event) => event.type)).toEqual([
      'speech_started',
      'speech_completed',
      'control_candidate',
    ]);
    expect(value.client.getNextRealtimeVoiceSpeech.mock.calls[1]?.[1]).toEqual({
      afterSequence: 1,
      waitMs: 0,
    });
    expect(value.controller.metricsSnapshot()).toMatchObject({
      cursor: 1,
      completedSegments: 1,
      errorCount: 0,
    });
    expect(JSON.stringify(value.events)).not.toContain('audioUrl');
    expect(JSON.stringify(value.events)).not.toContain(READY.audioUrl);

    await value.controller.close();
    await running;
  });

  it('refuse un contexte périmé avant téléchargement, annule, puis avance sur le terminal', async () => {
    let call = 0;
    const value = harness({
      initialFence: { sessionHandle: SESSION, contextRevision: 8, contextDigest: 'c'.repeat(64) },
      getNext: (_handle, _input, signal) => {
        call += 1;
        if (call === 1) return Promise.resolve(ok(READY));
        if (call === 2) return Promise.resolve(ok(TERMINAL));
        return pendingUntilAbort(signal);
      },
    });

    const running = value.controller.start();
    await waitFor(() => value.controller.metricsSnapshot().cursor === 1);

    expect(value.playback.downloadVerified).not.toHaveBeenCalled();
    expect(value.client.cancelRealtimeVoiceSpeech).toHaveBeenCalledWith(
      SESSION,
      TURN,
      ARTIFACT,
      { cancellationId: CANCELLATION, reason: 'context_changed' },
      expect.any(AbortSignal),
    );
    expect(value.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'context_stale' }));

    await value.controller.close();
    await running;
  });

  it('un téléchargement tardif après barge-in ne peut jamais lancer la lecture', async () => {
    const pendingDownload = deferred<RealtimeVerifiedSpeechAudio>();
    const value = harness({
      getNext: vi.fn()
        .mockResolvedValueOnce(ok(READY))
        .mockImplementation((_handle, _input, signal) => pendingUntilAbort(signal)),
      download: () => pendingDownload.promise,
    });
    const running = value.controller.start();
    await waitFor(() => value.playback.downloadVerified.mock.calls.length === 1);

    const interruption = value.controller.interrupt('barge_in');
    expect(value.playback.stopImmediately).toHaveBeenCalledTimes(1);
    pendingDownload.resolve(VERIFIED);
    await interruption;
    await waitFor(() => value.playback.release.mock.calls.length === 1);

    expect(value.playback.play).not.toHaveBeenCalled();
    expect(value.client.acknowledgeRealtimeVoiceSpeechDelivery).not.toHaveBeenCalled();
    expect(value.client.cancelRealtimeVoiceSpeech).toHaveBeenCalledTimes(1);
    await value.controller.close();
    await running;
  });

  it('une lecture tardive après interruption ne livre ni contrôle ni completion', async () => {
    const pendingPlay = deferred<void>();
    const value = harness({
      getNext: vi.fn()
        .mockResolvedValueOnce(ok(READY))
        .mockImplementation((_handle, _input, signal) => pendingUntilAbort(signal)),
      play: () => pendingPlay.promise,
    });
    const running = value.controller.start();
    await waitFor(() => value.playback.play.mock.calls.length === 1);

    const interruption = value.controller.interrupt('user_cancel');
    pendingPlay.resolve();
    await interruption;
    await waitFor(() => value.playback.release.mock.calls.length === 1);

    expect(value.client.acknowledgeRealtimeVoiceSpeechDelivery).not.toHaveBeenCalled();
    expect(value.events.some((event) => event.type === 'speech_completed')).toBe(false);
    expect(value.events.some((event) => event.type === 'control_candidate')).toBe(false);
    await value.controller.close();
    await running;
  });

  it('rend une double interruption idempotente avec le même cancellationId', async () => {
    const pendingDownload = deferred<RealtimeVerifiedSpeechAudio>();
    const pendingCancel = deferred<ReturnType<typeof ok<void>>>();
    const value = harness({
      getNext: vi.fn().mockResolvedValueOnce(ok(READY)),
      download: () => pendingDownload.promise,
      cancel: () => pendingCancel.promise,
    });
    const running = value.controller.start();
    await waitFor(() => value.playback.downloadVerified.mock.calls.length === 1);

    const first = value.controller.interrupt('barge_in');
    const second = value.controller.interrupt('user_cancel');
    expect(first).toBe(second);
    expect(value.client.cancelRealtimeVoiceSpeech).toHaveBeenCalledTimes(1);
    expect(value.playback.stopImmediately).toHaveBeenCalledTimes(2);

    pendingCancel.resolve(ok(undefined));
    pendingDownload.resolve(VERIFIED);
    await Promise.all([first, second]);
    await value.controller.close();
    await running;
  });

  it('fait gagner l’annulation sur un ACK de livraison tardif', async () => {
    const pendingDelivery = deferred<ReturnType<typeof ok<{ controlReference: RealtimeVoiceControlReference }>>>();
    const value = harness({
      getNext: vi.fn().mockResolvedValueOnce(ok(READY)),
      deliver: () => pendingDelivery.promise,
    });
    const running = value.controller.start();
    await waitFor(() => value.client.acknowledgeRealtimeVoiceSpeechDelivery.mock.calls.length === 1);

    const interruption = value.controller.interrupt('barge_in');
    pendingDelivery.resolve(ok({
      controlReference: { turnId: TURN, acknowledgementId: DELIVERY, contextRevision: 7, contextDigest: DIGEST },
    }));
    await interruption;
    await waitFor(() => value.playback.release.mock.calls.length === 1);

    expect(value.events.some((event) => event.type === 'speech_completed')).toBe(false);
    expect(value.events.some((event) => event.type === 'control_candidate')).toBe(false);
    expect(value.controller.metricsSnapshot().cursor).toBe(0);
    await value.controller.close();
    await running;
  });

  it('réessaie une livraison ambiguë avec le même deliveryId sans rejouer', async () => {
    let deliveryAttempt = 0;
    const value = harness({
      getNext: vi.fn()
        .mockResolvedValueOnce(ok(READY))
        .mockImplementation((_handle, _input, signal) => pendingUntilAbort(signal)),
      deliver: async () => {
        deliveryAttempt += 1;
        return deliveryAttempt === 1 ? unavailable() : ok({});
      },
    });
    const running = value.controller.start();
    await waitFor(() => value.events.some((event) => event.type === 'speech_completed'));

    expect(value.playback.play).toHaveBeenCalledTimes(1);
    expect(value.client.acknowledgeRealtimeVoiceSpeechDelivery).toHaveBeenCalledTimes(2);
    expect(value.client.acknowledgeRealtimeVoiceSpeechDelivery.mock.calls[0]?.[3]).toEqual({
      deliveryId: DELIVERY,
      audioSha256: SHA,
    });
    expect(value.client.acknowledgeRealtimeVoiceSpeechDelivery.mock.calls[1]?.[3]).toEqual({
      deliveryId: DELIVERY,
      audioSha256: SHA,
    });
    await value.controller.close();
    await running;
  });

  it('réessaie une annulation avec le même cancellationId', async () => {
    let cancellationAttempt = 0;
    const rendering: Extract<RealtimeVoiceSpeechFeed, { status: 'rendering' }> = {
      status: 'rendering',
      artifactId: ARTIFACT,
      turnId: TURN,
      sequence: 1,
      contextRevision: 7,
      contextDigest: DIGEST,
    };
    const value = harness({
      getNext: vi.fn()
        .mockResolvedValueOnce(ok(rendering))
        .mockImplementation((_handle, _input, signal) => pendingUntilAbort(signal)),
      cancel: async () => {
        cancellationAttempt += 1;
        return cancellationAttempt === 1 ? unavailable() : ok(undefined);
      },
    });
    const running = value.controller.start();
    await waitFor(() => value.client.getNextRealtimeVoiceSpeech.mock.calls.length >= 2);

    await value.controller.interrupt('barge_in');

    expect(value.client.cancelRealtimeVoiceSpeech).toHaveBeenCalledTimes(2);
    expect(value.client.cancelRealtimeVoiceSpeech.mock.calls[0]?.[3]).toEqual({
      cancellationId: CANCELLATION,
      reason: 'barge_in',
    });
    expect(value.client.cancelRealtimeVoiceSpeech.mock.calls[1]?.[3]).toEqual({
      cancellationId: CANCELLATION,
      reason: 'barge_in',
    });
    await value.controller.close();
    await running;
  });

  it('ne rejoue jamais un ready répété après un échec de livraison', async () => {
    let call = 0;
    const value = harness({
      getNext: (_handle, _input, signal) => {
        call += 1;
        if (call <= 2) return Promise.resolve(ok(READY));
        if (call === 3) return Promise.resolve(ok(TERMINAL));
        return pendingUntilAbort(signal);
      },
      deliver: async () => unavailable(),
      maxMutationAttempts: 1,
    });
    const running = value.controller.start();
    await waitFor(() => value.controller.metricsSnapshot().cursor === 1);

    expect(value.playback.play).toHaveBeenCalledTimes(1);
    expect(value.client.acknowledgeRealtimeVoiceSpeechDelivery).toHaveBeenCalledTimes(1);
    expect(value.events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'delivery_failed',
    }));
    await value.controller.close();
    await running;
  });

  it.each([
    ['replay', TERMINAL, { ...TERMINAL }],
    ['trou', { ...TERMINAL }, { ...TERMINAL, sequence: 3 }],
  ])('rejette sans lecture une séquence en %s', async (_label, first, second) => {
    const value = harness({
      getNext: vi.fn()
        .mockResolvedValueOnce(ok(first as RealtimeVoiceSpeechFeed))
        .mockResolvedValueOnce(ok(second as RealtimeVoiceSpeechFeed)),
    });

    await value.controller.start();

    expect(value.playback.downloadVerified).not.toHaveBeenCalled();
    expect(value.events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'sequence_violation',
    }));
    expect(value.controller.metricsSnapshot().cursor).toBe(1);
  });

  it('ferme pendant un long-poll et ignore sa réponse tardive', async () => {
    const poll = deferred<ReturnType<typeof ok<RealtimeVoiceSpeechFeed>>>();
    let signal: AbortSignal | undefined;
    const value = harness({
      getNext: (_handle, _input, inputSignal) => {
        signal = inputSignal;
        return poll.promise;
      },
    });
    const running = value.controller.start();
    await waitFor(() => signal !== undefined);

    await value.controller.background();
    expect(signal?.aborted).toBe(true);
    poll.resolve(ok(READY));
    await running;

    expect(value.playback.downloadVerified).not.toHaveBeenCalled();
    expect(value.events).toEqual([]);
  });

  it('ferme pendant la lecture sans résurrection ni livraison', async () => {
    const pendingPlay = deferred<void>();
    const value = harness({
      getNext: vi.fn().mockResolvedValueOnce(ok(READY)),
      play: () => pendingPlay.promise,
    });
    const running = value.controller.start();
    await waitFor(() => value.playback.play.mock.calls.length === 1);

    const closing = value.controller.close();
    expect(value.playback.stopImmediately).toHaveBeenCalledTimes(1);
    pendingPlay.resolve();
    await closing;
    await running;

    expect(value.client.acknowledgeRealtimeVoiceSpeechDelivery).not.toHaveBeenCalled();
    expect(value.events.some((event) => event.type === 'speech_completed')).toBe(false);
  });

  it('rejette une référence de contrôle forgée après l’ACK durable', async () => {
    const value = harness({
      getNext: vi.fn().mockResolvedValueOnce(ok(READY)),
      deliver: async () => ok({
        controlReference: { turnId: TURN, acknowledgementId: DELIVERY, contextRevision: 7, contextDigest: 'f'.repeat(64) },
      }),
    });

    await value.controller.start();

    expect(value.events.some((event) => event.type === 'control_candidate')).toBe(false);
    expect(value.events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'control_reference_invalid',
    }));
    expect(value.controller.metricsSnapshot().cursor).toBe(1);
  });

  it('rejette un contrôle lié à un autre deliveryId malgré un tour et un contexte exacts', async () => {
    const value = harness({
      getNext: vi.fn().mockResolvedValueOnce(ok(READY)),
      deliver: async () => ok({
        controlReference: {
          turnId: TURN,
          acknowledgementId: '00000000-0000-4000-8000-000000000099',
          contextRevision: 7,
          contextDigest: DIGEST,
        },
      }),
    });

    await value.controller.start();

    expect(value.events.some((event) => event.type === 'control_candidate')).toBe(false);
    expect(value.events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'control_reference_invalid',
    }));
    expect(value.controller.metricsSnapshot().cursor).toBe(1);
  });

  it('annule en playback_error quand la lecture échoue', async () => {
    const value = harness({
      getNext: vi.fn()
        .mockResolvedValueOnce(ok(READY))
        .mockImplementation((_handle, _input, signal) => pendingUntilAbort(signal)),
      play: async () => { throw new Error('native failure'); },
    });
    const running = value.controller.start();
    await waitFor(() => value.client.cancelRealtimeVoiceSpeech.mock.calls.length === 1);

    expect(value.client.cancelRealtimeVoiceSpeech.mock.calls[0]?.[3]).toEqual({
      cancellationId: CANCELLATION,
      reason: 'playback_error',
    });
    expect(value.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'playback_failed' }));
    expect(value.client.acknowledgeRealtimeVoiceSpeechDelivery).not.toHaveBeenCalled();
    await value.controller.close();
    await running;
  });

  it('refence le contexte après download, avant play', async () => {
    const pendingDownload = deferred<RealtimeVerifiedSpeechAudio>();
    const value = harness({
      getNext: vi.fn()
        .mockResolvedValueOnce(ok(READY))
        .mockImplementation((_handle, _input, signal) => pendingUntilAbort(signal)),
      download: () => pendingDownload.promise,
    });
    const running = value.controller.start();
    await waitFor(() => value.playback.downloadVerified.mock.calls.length === 1);
    value.setFence({ sessionHandle: SESSION, contextRevision: 8, contextDigest: 'c'.repeat(64) });
    pendingDownload.resolve(VERIFIED);
    await waitFor(() => value.client.cancelRealtimeVoiceSpeech.mock.calls.length === 1);

    expect(value.playback.play).not.toHaveBeenCalled();
    expect(value.client.cancelRealtimeVoiceSpeech.mock.calls[0]?.[3]).toMatchObject({
      reason: 'context_changed',
    });
    await value.controller.close();
    await running;
  });

  it('refence le contexte après play, avant delivery', async () => {
    const pendingPlay = deferred<void>();
    const value = harness({
      getNext: vi.fn()
        .mockResolvedValueOnce(ok(READY))
        .mockImplementation((_handle, _input, signal) => pendingUntilAbort(signal)),
      play: () => pendingPlay.promise,
    });
    const running = value.controller.start();
    await waitFor(() => value.playback.play.mock.calls.length === 1);
    value.setFence({ sessionHandle: SESSION, contextRevision: 8, contextDigest: 'c'.repeat(64) });
    pendingPlay.resolve();
    await waitFor(() => value.client.cancelRealtimeVoiceSpeech.mock.calls.length === 1);

    expect(value.client.acknowledgeRealtimeVoiceSpeechDelivery).not.toHaveBeenCalled();
    await value.controller.close();
    await running;
  });

  it('refence encore après delivery et supprime completion/contrôle si l’écran a changé', async () => {
    const delivery = deferred<ReturnType<typeof ok<{ controlReference: RealtimeVoiceControlReference }>>>();
    const value = harness({
      getNext: vi.fn().mockResolvedValueOnce(ok(READY)),
      deliver: () => delivery.promise,
    });
    const running = value.controller.start();
    await waitFor(() => value.client.acknowledgeRealtimeVoiceSpeechDelivery.mock.calls.length === 1);
    value.setFence({ sessionHandle: SESSION, contextRevision: 8, contextDigest: 'c'.repeat(64) });
    delivery.resolve(ok({
      controlReference: { turnId: TURN, acknowledgementId: DELIVERY, contextRevision: 7, contextDigest: DIGEST },
    }));
    await waitFor(() => value.controller.metricsSnapshot().cursor === 1);

    expect(value.events.some((event) => event.type === 'speech_completed')).toBe(false);
    expect(value.events.some((event) => event.type === 'control_candidate')).toBe(false);
    expect(value.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'context_stale' }));
    await value.controller.close();
    await running;
  });

  it('borne les erreurs de feed et s’arrête sans boucle rapide', async () => {
    const value = harness({
      getNext: vi.fn().mockResolvedValue(unavailable()),
      maxConsecutiveFeedErrors: 3,
    });

    await value.controller.start();

    expect(value.client.getNextRealtimeVoiceSpeech).toHaveBeenCalledTimes(3);
    expect(value.events).toEqual([
      expect.objectContaining({ type: 'error', code: 'feed_unavailable' }),
    ]);
  });

  it('rejette un handle vérifié dont SHA/MIME/taille divergent du manifeste', async () => {
    const value = harness({
      getNext: vi.fn()
        .mockResolvedValueOnce(ok(READY))
        .mockImplementation((_handle, _input, signal) => pendingUntilAbort(signal)),
      download: async () => ({ ...VERIFIED, sha256: 'e'.repeat(64) }),
    });
    const running = value.controller.start();
    await waitFor(() => value.client.cancelRealtimeVoiceSpeech.mock.calls.length === 1);

    expect(value.playback.play).not.toHaveBeenCalled();
    expect(value.events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'playback_contract_violation',
    }));
    await value.controller.close();
    await running;
  });
});
