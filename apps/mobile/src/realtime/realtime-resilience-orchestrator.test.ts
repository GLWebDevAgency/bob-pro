import { describe, expect, it, vi } from 'vitest';
import {
  classifyRealtimeFailure,
  legacyFallbackChannelFor,
} from './realtime-recovery-policy';
import {
  RealtimeResilienceOrchestrator,
  type LegacyVoiceFallbackPort,
  type LegacyVoiceFallbackSession,
} from './realtime-resilience-orchestrator';
import {
  RealtimeTransportError,
  type RealtimeCloseReason,
  type RealtimeFallbackReason,
  type RealtimeTransportEvent,
  type RealtimeTransportMetrics,
  type RealtimeTransportState,
  type VoiceConversationTransport,
} from './realtime-transport';

const EMPTY_METRICS: RealtimeTransportMetrics = Object.freeze({
  permissionToTrackMs: null,
  offerToAnswerMs: null,
  connectToDataChannelOpenMs: null,
  sessionReadyMs: null,
  speechStoppedEventToFirstAudioSignalMs: null,
  speechStoppedToFirstInboundRtpMs: null,
  bargeInToAudioClearedMs: null,
  reconnectCount: 0,
  roundTripTimeMs: null,
  jitterMs: null,
  packetsLost: null,
});

type ConnectBehavior = (signal: AbortSignal | undefined) => Promise<void>;

class FakePrimaryTransport implements VoiceConversationTransport {
  readonly capabilities = { fullDuplex: true, bargeIn: true, remoteAudio: true } as const;
  private currentState: RealtimeTransportState = {
    phase: 'idle',
    generation: 0,
    turn: 0,
    fallbackReason: null,
  };
  private readonly listeners = new Set<(event: RealtimeTransportEvent) => void>();
  readonly closeReasons: RealtimeCloseReason[] = [];
  connectCalls = 0;

  constructor(
    private readonly connectBehavior: ConnectBehavior,
    private readonly events?: string[],
    private readonly closeBehavior: () => Promise<void> = async () => undefined,
  ) {}

  get state(): RealtimeTransportState {
    return this.currentState;
  }

  getSessionHandle(): string | null { return null; }

  async connect(input: { signal?: AbortSignal } = {}): Promise<void> {
    this.connectCalls += 1;
    this.events?.push('primary.connect');
    await this.connectBehavior(input.signal);
    this.currentState = { ...this.currentState, phase: 'ready' };
  }

  sendUserText(): boolean { return false; }
  setMicrophoneEnabled(): void {}
  interrupt(): boolean { return false; }

  async close(reason: RealtimeCloseReason): Promise<void> {
    this.closeReasons.push(reason);
    this.events?.push('primary.close');
    await this.closeBehavior();
    this.currentState = { ...this.currentState, phase: 'closed' };
  }

  subscribe(listener: (event: RealtimeTransportEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'state', state: this.currentState });
    return () => this.listeners.delete(listener);
  }

  metricsSnapshot(): RealtimeTransportMetrics { return EMPTY_METRICS; }

  get subscriberCount(): number { return this.listeners.size; }

  emit(event: RealtimeTransportEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function resolvedPrimary(events?: string[]): FakePrimaryTransport {
  return new FakePrimaryTransport(async () => undefined, events);
}

function rejectedPrimary(
  reason: ConstructorParameters<typeof RealtimeTransportError>[0],
  events?: string[],
): FakePrimaryTransport {
  return new FakePrimaryTransport(
    async () => { throw new RealtimeTransportError(reason); },
    events,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition de test non atteinte');
}

function fallbackHarness(events: string[] = []) {
  const sessions: Array<{ session: LegacyVoiceFallbackSession; closeReasons: RealtimeCloseReason[] }> = [];
  const start = vi.fn<LegacyVoiceFallbackPort['start']>(async (input) => {
    events.push(`legacy.start:${input.channel}`);
    const closeReasons: RealtimeCloseReason[] = [];
    const session: LegacyVoiceFallbackSession = {
      close: vi.fn(async (reason) => {
        closeReasons.push(reason);
        events.push('legacy.close');
      }),
    };
    sessions.push({ session, closeReasons });
    return session;
  });
  return { port: { start } satisfies LegacyVoiceFallbackPort, start, sessions };
}

describe('politique de récupération Bob Live', () => {
  it('sépare exhaustivement les causes fatales des causes transitoires', () => {
    const fatalReasons: readonly RealtimeFallbackReason[] = [
      'native_module_unavailable',
      'backend_disabled',
      'not_entitled',
      'audio_busy',
      'microphone_denied',
      'aborted',
    ];
    const transientReasons: readonly RealtimeFallbackReason[] = [
      'bootstrap_failed',
      'entitlement_unavailable',
      'data_channel_timeout',
      'ice_failed',
      'provider_error',
    ];

    expect(fatalReasons.map(classifyRealtimeFailure)).toEqual([
      'fatal',
      'fatal',
      'fatal',
      'fatal',
      'fatal',
      'fatal',
    ]);
    expect(transientReasons.map(classifyRealtimeFailure)).toEqual([
      'transient',
      'transient',
      'transient',
      'transient',
      'transient',
    ]);
  });

  it('n ouvre jamais un second micro après refus et ne replie pas une annulation', () => {
    expect(legacyFallbackChannelFor('microphone_denied')).toBe('text_only');
    expect(legacyFallbackChannelFor('audio_busy')).toBe('text_only');
    expect(legacyFallbackChannelFor('not_entitled')).toBe('voice');
    expect(legacyFallbackChannelFor('entitlement_unavailable')).toBe('voice');
    expect(legacyFallbackChannelFor('aborted')).toBeNull();
  });
});

describe('RealtimeResilienceOrchestrator', () => {
  it('effectue une seule reconnexion transitoire avec jitter injecté', async () => {
    const events: string[] = [];
    const first = rejectedPrimary('ice_failed', events);
    const second = resolvedPrimary(events);
    const primaries = [first, second];
    const fallback = fallbackHarness(events);
    const sleep = vi.fn(async (milliseconds: number) => { events.push(`sleep:${milliseconds}`); });
    const jitter = vi.fn(() => 123);
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primaries.shift()!,
      legacyFallback: fallback.port,
      reconnectDelayMs: jitter,
      sleep,
    });
    const metricReconnectCounts: number[] = [];
    orchestrator.subscribe((event) => {
      if (event.type === 'transport' && event.event.type === 'metrics') {
        metricReconnectCounts.push(event.event.metrics.reconnectCount);
      }
    });

    await expect(orchestrator.start()).resolves.toMatchObject({
      phase: 'ready',
      reconnectAttempts: 1,
      lastFailureReason: null,
    });

    expect(jitter).toHaveBeenCalledWith({ attempt: 1, reason: 'ice_failed', baseDelayMs: 350 });
    expect(sleep).toHaveBeenCalledWith(123);
    expect(first.closeReasons).toEqual(['fallback']);
    expect(second.connectCalls).toBe(1);
    expect(fallback.start).not.toHaveBeenCalled();
    second.emit({ type: 'metrics', metrics: EMPTY_METRICS });
    expect(metricReconnectCounts).toEqual([1]);
    expect(events).toEqual([
      'primary.connect',
      'primary.close',
      'sleep:123',
      'primary.connect',
    ]);
  });

  it('épuise une reconnexion puis ferme le primaire avant le fallback legacy', async () => {
    const events: string[] = [];
    const first = rejectedPrimary('bootstrap_failed', events);
    const second = rejectedPrimary('provider_error', events);
    const primaries = [first, second];
    const fallback = fallbackHarness(events);
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primaries.shift()!,
      legacyFallback: fallback.port,
      reconnectDelayMs: () => 0,
      sleep: async () => undefined,
    });

    await expect(orchestrator.start()).resolves.toMatchObject({
      phase: 'legacy',
      reconnectAttempts: 1,
      lastFailureReason: 'provider_error',
      fallbackChannel: 'voice',
    });

    expect(fallback.start).toHaveBeenCalledOnce();
    expect(events).toEqual([
      'primary.connect',
      'primary.close',
      'primary.connect',
      'primary.close',
      'legacy.start:voice',
    ]);
  });

  it('ne reconnecte jamais après permission refusée et ouvre seulement le repli texte', async () => {
    const first = rejectedPrimary('microphone_denied');
    const fallback = fallbackHarness();
    const createPrimary = vi.fn(() => first);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary,
      legacyFallback: fallback.port,
      reconnectDelayMs: () => 0,
      sleep,
    });

    await orchestrator.start();
    await orchestrator.start();

    expect(orchestrator.state).toMatchObject({
      phase: 'legacy',
      reconnectAttempts: 0,
      fallbackChannel: 'text_only',
    });
    expect(createPrimary).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(fallback.start).toHaveBeenCalledWith({
      reason: 'microphone_denied',
      channel: 'text_only',
    });
  });

  it('annule le retry différé après background sans déclencher de fallback', async () => {
    const retryDelay = deferred<void>();
    const first = rejectedPrimary('ice_failed');
    const second = resolvedPrimary();
    const primaries = [first, second];
    const fallback = fallbackHarness();
    const sleep = vi.fn(() => retryDelay.promise);
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primaries.shift()!,
      legacyFallback: fallback.port,
      reconnectDelayMs: () => 200,
      sleep,
    });

    const starting = orchestrator.start();
    await waitUntil(() => sleep.mock.calls.length === 1);
    await orchestrator.stop('background');
    retryDelay.resolve();
    await starting;

    expect(second.connectCalls).toBe(0);
    expect(fallback.start).not.toHaveBeenCalled();
    expect(orchestrator.state).toMatchObject({ phase: 'stopped', reconnectAttempts: 0 });
  });

  it('un stop réentrant pendant l abonnement interdit connect et libère l observateur', async () => {
    const primary = resolvedPrimary();
    const fallback = fallbackHarness();
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primary,
      legacyFallback: fallback.port,
      sleep: async () => undefined,
    });
    let reentrantStop: Promise<void> | null = null;
    orchestrator.subscribe((event) => {
      if (event.type === 'transport' && reentrantStop === null) {
        reentrantStop = orchestrator.stop('background');
      }
    });

    const starting = orchestrator.start();
    await waitUntil(() => reentrantStop !== null);
    await Promise.all([starting, reentrantStop!]);

    expect(primary.connectCalls).toBe(0);
    expect(primary.closeReasons).toEqual(['background']);
    expect(primary.subscriberCount).toBe(0);
    expect(fallback.start).not.toHaveBeenCalled();
    expect(orchestrator.state.phase).toBe('stopped');
  });

  it('annule la grâce disconnected si le peer revient avant son expiration', async () => {
    const grace = deferred<void>();
    const first = resolvedPrimary();
    const second = resolvedPrimary();
    const primaries = [first, second];
    const fallback = fallbackHarness();
    const sleep = vi.fn(() => grace.promise);
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primaries.shift()!,
      legacyFallback: fallback.port,
      disconnectedGraceMs: 1_200,
      reconnectDelayMs: () => 0,
      sleep,
    });
    await orchestrator.start();

    const disconnected = orchestrator.notifyDisconnected();
    expect(orchestrator.state.phase).toBe('disconnected_grace');
    orchestrator.notifyConnected();
    grace.resolve();
    await disconnected;

    expect(orchestrator.state.phase).toBe('ready');
    expect(first.closeReasons).toEqual([]);
    expect(second.connectCalls).toBe(0);
    expect(sleep).toHaveBeenCalledWith(1_200);
  });

  it('conserve une nouvelle déconnexion après un reconnect réentrant', async () => {
    const firstGrace = deferred<void>();
    const secondGrace = deferred<void>();
    const first = resolvedPrimary();
    const second = resolvedPrimary();
    const primaries = [first, second];
    const fallback = fallbackHarness();
    const sleeps = [firstGrace.promise, secondGrace.promise, Promise.resolve()];
    const sleep = vi.fn(() => sleeps.shift() ?? Promise.resolve());
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primaries.shift()!,
      legacyFallback: fallback.port,
      disconnectedGraceMs: 800,
      reconnectDelayMs: () => 0,
      sleep,
    });
    let cancelFirstGrace = true;
    orchestrator.subscribe((event) => {
      if (
        event.type === 'state'
        && event.state.phase === 'disconnected_grace'
        && cancelFirstGrace
      ) {
        cancelFirstGrace = false;
        orchestrator.notifyConnected();
      }
    });
    await orchestrator.start();

    const cancelledDisconnect = orchestrator.notifyDisconnected();
    expect(orchestrator.state.phase).toBe('ready');
    const activeDisconnect = orchestrator.notifyDisconnected();
    expect(activeDisconnect).not.toBe(cancelledDisconnect);
    expect(orchestrator.state.phase).toBe('disconnected_grace');
    await waitUntil(() => sleep.mock.calls.length === 2);

    firstGrace.resolve();
    await cancelledDisconnect;
    expect(orchestrator.state.phase).toBe('disconnected_grace');
    secondGrace.resolve();
    await activeDisconnect;

    expect(orchestrator.state).toMatchObject({ phase: 'ready', reconnectAttempts: 1 });
    expect(first.closeReasons).toEqual(['fallback']);
    expect(second.connectCalls).toBe(1);
    expect(fallback.start).not.toHaveBeenCalled();
  });

  it('reconnecte une fois quand la grâce disconnected expire', async () => {
    const first = resolvedPrimary();
    const second = resolvedPrimary();
    const primaries = [first, second];
    const fallback = fallbackHarness();
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primaries.shift()!,
      legacyFallback: fallback.port,
      disconnectedGraceMs: 900,
      reconnectDelayMs: () => 77,
      sleep,
    });
    await orchestrator.start();

    await orchestrator.notifyDisconnected('ice_failed');

    expect(orchestrator.state).toMatchObject({ phase: 'ready', reconnectAttempts: 1 });
    expect(first.closeReasons).toEqual(['fallback']);
    expect(second.connectCalls).toBe(1);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([900, 77]);
  });

  it('raccorde les événements connectivité du transport à la grâce orchestrée', async () => {
    const first = resolvedPrimary();
    const second = resolvedPrimary();
    const primaries = [first, second];
    const fallback = fallbackHarness();
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primaries.shift()!,
      legacyFallback: fallback.port,
      disconnectedGraceMs: 700,
      reconnectDelayMs: () => 25,
      sleep,
    });
    await orchestrator.start();

    first.emit({ type: 'connectivity', state: 'disconnected' });
    await waitUntil(() => second.connectCalls === 1 && orchestrator.state.phase === 'ready');

    expect(first.closeReasons).toEqual(['fallback']);
    expect(orchestrator.state.reconnectAttempts).toBe(1);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([700, 25]);
    expect(fallback.start).not.toHaveBeenCalled();
  });

  it('ne perd pas une déconnexion publiée juste avant la fin du bootstrap', async () => {
    const first = new FakePrimaryTransport(async () => {
      first.emit({ type: 'connectivity', state: 'disconnected' });
    });
    const second = resolvedPrimary();
    const primaries = [first, second];
    const fallback = fallbackHarness();
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primaries.shift()!,
      legacyFallback: fallback.port,
      disconnectedGraceMs: 0,
      reconnectDelayMs: () => 0,
      sleep: async () => undefined,
    });

    await orchestrator.start();
    await waitUntil(() => second.connectCalls === 1 && orchestrator.state.phase === 'ready');

    expect(first.closeReasons).toEqual(['fallback']);
    expect(orchestrator.state.reconnectAttempts).toBe(1);
    expect(fallback.start).not.toHaveBeenCalled();
  });

  it('ne reste pas bloqué en grâce si le peer de reconnexion arrive déjà déconnecté', async () => {
    const first = resolvedPrimary();
    const second = new FakePrimaryTransport(async () => {
      second.emit({ type: 'connectivity', state: 'disconnected' });
    });
    const primaries = [first, second];
    const fallback = fallbackHarness();
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primaries.shift()!,
      legacyFallback: fallback.port,
      disconnectedGraceMs: 0,
      reconnectDelayMs: () => 0,
      sleep: async () => undefined,
    });
    await orchestrator.start();

    first.emit({ type: 'fallback', reason: 'provider_error' });
    await waitUntil(() => orchestrator.state.phase === 'legacy');

    expect(first.closeReasons).toEqual(['fallback']);
    expect(second.closeReasons).toEqual(['fallback']);
    expect(orchestrator.state.reconnectAttempts).toBe(1);
    expect(fallback.start).toHaveBeenCalledOnce();
  });

  it('déduplique deux signaux de dégradation post-ready', async () => {
    const reconnectGate = deferred<void>();
    const first = resolvedPrimary();
    const second = resolvedPrimary();
    const primaries = [first, second];
    const fallback = fallbackHarness();
    const sleep = vi.fn(() => reconnectGate.promise);
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primaries.shift()!,
      legacyFallback: fallback.port,
      reconnectDelayMs: () => 50,
      sleep,
    });
    await orchestrator.start();

    first.emit({ type: 'fallback', reason: 'provider_error' });
    first.emit({ type: 'fallback', reason: 'provider_error' });
    await waitUntil(() => sleep.mock.calls.length === 1);
    reconnectGate.resolve();
    await waitUntil(() => orchestrator.state.phase === 'ready');

    expect(second.connectCalls).toBe(1);
    expect(fallback.start).not.toHaveBeenCalled();
    expect(orchestrator.state.reconnectAttempts).toBe(1);
  });

  it('ne dépasse jamais une reconnexion dans la même mission', async () => {
    const first = resolvedPrimary();
    const second = resolvedPrimary();
    const primaries = [first, second];
    const fallback = fallbackHarness();
    const createPrimary = vi.fn(() => primaries.shift()!);
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary,
      legacyFallback: fallback.port,
      reconnectDelayMs: () => 0,
      sleep: async () => undefined,
    });
    await orchestrator.start();

    first.emit({ type: 'fallback', reason: 'provider_error' });
    await waitUntil(() => second.connectCalls === 1 && orchestrator.state.phase === 'ready');
    second.emit({ type: 'fallback', reason: 'ice_failed' });
    await waitUntil(() => orchestrator.state.phase === 'legacy');

    expect(createPrimary).toHaveBeenCalledTimes(2);
    expect(fallback.start).toHaveBeenCalledOnce();
    expect(fallback.start).toHaveBeenCalledWith({ reason: 'ice_failed', channel: 'voice' });
  });

  it('une récupération ancienne ne bloque jamais celle d une nouvelle mission explicite', async () => {
    const oldRetryGate = deferred<void>();
    const oldPrimary = resolvedPrimary();
    const newPrimary = resolvedPrimary();
    const newReconnect = resolvedPrimary();
    const primaries = [oldPrimary, newPrimary, newReconnect];
    let delayCall = 0;
    const sleep = vi.fn(() => {
      delayCall += 1;
      return delayCall === 1 ? oldRetryGate.promise : Promise.resolve();
    });
    const fallback = fallbackHarness();
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => primaries.shift()!,
      legacyFallback: fallback.port,
      reconnectDelayMs: () => 10,
      sleep,
    });
    await orchestrator.start();
    oldPrimary.emit({ type: 'fallback', reason: 'provider_error' });
    await waitUntil(() => sleep.mock.calls.length === 1);

    await orchestrator.stop('background');
    await orchestrator.start();
    newPrimary.emit({ type: 'fallback', reason: 'provider_error' });
    await waitUntil(() => newReconnect.connectCalls === 1);

    oldRetryGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await waitUntil(() => orchestrator.state.phase === 'ready');
    expect(orchestrator.state.reconnectAttempts).toBe(1);
    expect(fallback.start).not.toHaveBeenCalled();
    expect(primaries).toEqual([]);
  });

  it('ferme une activation legacy tardive après stop sans chevaucher une nouvelle mission', async () => {
    const activation = deferred<LegacyVoiceFallbackSession>();
    const fallbackClose = vi.fn(async () => undefined);
    const fallback: LegacyVoiceFallbackPort = {
      start: vi.fn(() => activation.promise),
    };
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => rejectedPrimary('microphone_denied'),
      legacyFallback: fallback,
      sleep: async () => undefined,
    });

    const starting = orchestrator.start();
    await waitUntil(() => vi.mocked(fallback.start).mock.calls.length === 1);
    const stopping = orchestrator.stop('background');
    activation.resolve({ close: fallbackClose });
    await Promise.all([starting, stopping]);

    expect(fallbackClose).toHaveBeenCalledOnce();
    expect(fallbackClose).toHaveBeenCalledWith('aborted');
    expect(orchestrator.state.phase).toBe('stopped');
  });

  it('rend visible l activation legacy avant un stop réentrant du port', async () => {
    const fallbackClose = vi.fn(async () => undefined);
    let reentrantStop: Promise<void> | null = null;
    const lifecycle: { current: RealtimeResilienceOrchestrator | null } = { current: null };
    const fallback: LegacyVoiceFallbackPort = {
      start: vi.fn(async () => {
        if (!lifecycle.current) throw new Error('orchestrateur non initialisé');
        reentrantStop = lifecycle.current.stop('background');
        return { close: fallbackClose };
      }),
    };
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary: () => rejectedPrimary('microphone_denied'),
      legacyFallback: fallback,
      sleep: async () => undefined,
    });
    lifecycle.current = orchestrator;

    const starting = orchestrator.start();
    await waitUntil(() => reentrantStop !== null);
    await Promise.all([starting, reentrantStop!]);

    expect(fallbackClose).toHaveBeenCalledOnce();
    expect(fallbackClose).toHaveBeenCalledWith('aborted');
    expect(orchestrator.state.phase).toBe('stopped');
  });

  it('échoue fermé si le primaire ne confirme pas sa fermeture', async () => {
    const closeFailure = new FakePrimaryTransport(
      async () => { throw new RealtimeTransportError('provider_error'); },
      undefined,
      async () => { throw new Error('close failed'); },
    );
    const fallback = fallbackHarness();
    const createPrimary = vi.fn(() => closeFailure);
    const orchestrator = new RealtimeResilienceOrchestrator({
      createPrimary,
      legacyFallback: fallback.port,
      reconnectDelayMs: () => 0,
      sleep: async () => undefined,
    });

    await orchestrator.start();
    expect(orchestrator.state).toMatchObject({
      phase: 'failed',
      reconnectAttempts: 0,
      lastFailureReason: 'provider_error',
    });
    await orchestrator.start();

    expect(createPrimary).toHaveBeenCalledOnce();
    expect(fallback.start).not.toHaveBeenCalled();
  });
});
