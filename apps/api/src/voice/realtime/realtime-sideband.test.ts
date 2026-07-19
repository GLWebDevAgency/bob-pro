import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientOptions, RawData } from 'ws';
import type { AppLogger } from '../../observability/logger';
import { Metrics } from '../../observability/metrics';
import { buildOpenAiRealtimeSessionConfig } from './realtime-session-config';
import {
  RealtimeSidebandManager,
  type RealtimeSidebandSocketFactory,
  type RealtimeSidebandSpeechDependencies,
} from './realtime-sideband';
import type {
  RealtimeSidebandOwnerIdentity,
  RealtimeSidebandOwnerPort,
} from './realtime-sideband-owner';
import type { RealtimeSpeechPublisherInput } from './realtime-speech-publisher';
import type { OpenAiRealtimeCallProvider, RealtimeVoiceSettings } from './realtime.types';

const SESSION = '00000000-0000-4000-8000-000000000001';
const TURN = '00000000-0000-4000-8000-000000000010';
const ARTIFACT = '00000000-0000-4000-8000-000000000020';
const ACKNOWLEDGEMENT = '00000000-0000-4000-8000-000000000030';
const CONTEXT = 'a'.repeat(64);
const OWNER_TOKEN = 'b'.repeat(64);
const OWNER_INSTANCE = 'c'.repeat(64);
const SUBJECT = 'd'.repeat(64);

const SETTINGS: RealtimeVoiceSettings = {
  enabled: true,
  provider: 'openai',
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'server-key-never-returned',
  safetySecret: 'safety-secret-at-least-thirty-two-characters',
  subjectKeyVersion: 1,
  providerTimeoutMs: 5_000,
  sidebandTimeoutMs: 100,
  maxSessionSeconds: 900,
  heartbeatSeconds: 10,
  maxCallsPerMinute: 3,
  auditProvider: 'openai',
  localAuditBaseUrl: null,
  localAuditToken: null,
  mistralTargetDelayMs: 240,
  mistralWebsocketUrl: 'ws://127.0.0.1:3000/v1/voice/realtime/mistral',
  mistralV2InitialBootstrapEnabled: false,
};

const OWNER: RealtimeSidebandOwnerIdentity = {
  companyId: 'company-1',
  subjectHash: SUBJECT,
  sessionId: SESSION,
  ownerInstanceHash: OWNER_INSTANCE,
  ownerTokenHash: OWNER_TOKEN,
  ownerEpoch: 3,
};

class FakeSocket extends EventEmitter {
  readyState = 0;
  readonly sent: string[] = [];
  closeReason: string | null = null;
  terminated = false;

  constructor(
    private readonly effectiveSession = buildOpenAiRealtimeSessionConfig(SETTINGS),
    private readonly autoSessionUpdated = true,
  ) {
    super();
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  providerEvent(value: unknown, isBinary = false): void {
    this.emit('message', Buffer.from(JSON.stringify(value)) as RawData, isBinary);
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
    const event = JSON.parse(data) as { type?: string; session?: Record<string, unknown> };
    if (event.type === 'session.update' && this.autoSessionUpdated) {
      const fullSession = { ...this.effectiveSession, ...event.session };
      queueMicrotask(() => this.providerEvent({ type: 'session.updated', session: fullSession }));
    }
  }

  close(_code?: number, reason?: string): void {
    this.closeReason = reason ?? null;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from(reason ?? ''));
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close', 1006, Buffer.alloc(0));
  }
}

interface Harness {
  readonly manager: RealtimeSidebandManager;
  readonly sockets: Array<{ url: string; options: ClientOptions; socket: FakeSocket }>;
  readonly owner: {
    [K in keyof RealtimeSidebandOwnerPort]: ReturnType<typeof vi.fn>;
  };
  readonly publish: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly issueControl: ReturnType<typeof vi.fn>;
  readonly provider: OpenAiRealtimeCallProvider;
  readonly terminate: ReturnType<typeof vi.fn>;
}

function loggerStub(): AppLogger {
  return { audit: vi.fn(), warn: vi.fn() } as unknown as AppLogger;
}

function harness(options: {
  settings?: RealtimeVoiceSettings;
  autoSessionUpdated?: boolean;
  publish?: (input: RealtimeSpeechPublisherInput) => Promise<unknown>;
  ownerAcquire?: () => Promise<unknown>;
  ownerRenew?: () => Promise<unknown>;
  contextCurrent?: boolean;
  issueControl?: RealtimeSidebandSpeechDependencies['controls']['issue'];
} = {}): Harness {
  const sockets: Harness['sockets'] = [];
  const factory = ((url: string, clientOptions: ClientOptions) => {
    const socket = new FakeSocket(
      buildOpenAiRealtimeSessionConfig(options.settings ?? SETTINGS),
      options.autoSessionUpdated ?? true,
    );
    sockets.push({ url, options: clientOptions, socket });
    queueMicrotask(() => socket.open());
    return socket;
  }) as unknown as RealtimeSidebandSocketFactory;
  const owner = {
    acquire: vi.fn(options.ownerAcquire ?? (async () => ({
      status: 'acquired' as const,
      owner: OWNER,
      currentContext: { revision: 1, digest: CONTEXT },
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    }))),
    renew: vi.fn(options.ownerRenew ?? (async () => ({ status: 'renewed' as const }))),
    applyContext: vi.fn(async () => ({ status: 'applied' as const })),
    readCurrentContext: vi.fn(async () => ({
      status: 'current' as const,
      context: { revision: 1, digest: CONTEXT },
    })),
    release: vi.fn(async () => ({ status: 'released' as const })),
  };
  const publish = vi.fn(options.publish ?? (async () => ({
    status: 'ready' as const,
    artifactId: ARTIFACT,
    sequence: 1,
  })));
  const cancel = vi.fn(async () => ({ status: 'cancelled' as const, idempotent: false }));
  const issueControl = vi.fn(options.issueControl ?? (async () => ({
    status: 'issued' as const,
    grantId: '00000000-0000-4000-8000-000000000098',
  })));
  const speech: RealtimeSidebandSpeechDependencies = {
    owner: owner as unknown as RealtimeSidebandOwnerPort,
    publisher: { publish: publish as unknown as RealtimeSidebandSpeechDependencies['publisher']['publish'] },
    cancellation: { cancel: cancel as unknown as RealtimeSidebandSpeechDependencies['cancellation']['cancel'] },
    controls: {
      issue: issueControl as unknown as RealtimeSidebandSpeechDependencies['controls']['issue'],
    },
    entropy: {
      ownerToken: () => 'owner-token-with-more-than-thirty-two-random-characters',
      cancellationId: () => '00000000-0000-4000-8000-000000000099',
    },
  };
  const provider: OpenAiRealtimeCallProvider = {
    createCall: vi.fn(),
    hangupCall: vi.fn(async () => undefined),
  };
  const terminate = vi.fn(async () => 'confirmed' as const);
  return {
    manager: new RealtimeSidebandManager(
      options.settings ?? SETTINGS,
      provider,
      new Metrics(),
      loggerStub(),
      factory,
      speech,
    ),
    sockets,
    owner,
    publish,
    cancel,
    issueControl,
    provider,
    terminate,
  };
}

async function attach(
  value: Harness,
  options: {
    callId?: string;
    turn?: (input: { transcript: string; history: readonly unknown[]; signal: AbortSignal }) => Promise<unknown>;
    contextCurrent?: boolean;
  } = {},
): Promise<void> {
  await value.manager.attach({
    callId: options.callId ?? 'rtc_test',
    userId: 'user-1',
    companyId: 'company-1',
    sessionHandle: SESSION,
    session: buildOpenAiRealtimeSessionConfig(SETTINGS),
    lifecycle: { activate: vi.fn(async () => undefined), terminate: value.terminate },
    turn: options.turn ? { run: options.turn as never } : undefined,
    controlContext: {
      isCurrent: vi.fn(async () => options.contextCurrent ?? true),
    },
  });
}

function finalTranscript(socket: FakeSocket, itemId: string, transcript = 'Explique cet écran.'): void {
  socket.providerEvent({ type: 'input_audio_buffer.committed', item_id: itemId });
  socket.providerEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  });
}

function readyOutcome(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ready' as const,
    turnId: TURN,
    canonicalSpeech: 'Voici le résumé vérifié.',
    kind: 'answer' as const,
    contextVersion: { version: 1 as const, revision: 1, digest: CONTEXT },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeSidebandManager — cutover sortie auditée', () => {
  it('configure OpenAI en entrée seule et n’émet que session.update', async () => {
    const value = harness();
    await attach(value);

    const config = buildOpenAiRealtimeSessionConfig(SETTINGS);
    expect(config).toMatchObject({
      output_modalities: ['text'],
      max_output_tokens: 1,
      tools: [],
      tool_choice: 'none',
      audio: { input: { turn_detection: { create_response: false } } },
    });
    expect(value.sockets[0]?.url).toBe('wss://api.openai.com/v1/realtime?call_id=rtc_test');
    expect(value.sockets[0]?.options.headers).toEqual({ Authorization: 'Bearer server-key-never-returned' });
    expect(value.sockets[0]?.socket.sent.map((raw) => JSON.parse(raw).type)).toEqual(['session.update']);
    await value.manager.onApplicationShutdown();
  });

  it('acquiert l’owner après activation, applique le contexte et publie le canonique sans response.create', async () => {
    const value = harness();
    const run = vi.fn(async () => readyOutcome());
    await attach(value, { turn: run });
    finalTranscript(value.sockets[0]!.socket, 'item_1');

    await vi.waitFor(() => expect(value.publish).toHaveBeenCalledOnce());
    expect(value.owner.acquire).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      sessionId: SESSION,
      leaseSeconds: 30,
      candidateOwnerTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(value.owner.applyContext).toHaveBeenCalledWith(OWNER, { revision: 1, digest: CONTEXT });
    expect(value.publish).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      subjectHash: SUBJECT,
      sessionId: SESSION,
      turnId: TURN,
      segmentIndex: 0,
      canonicalSpeech: 'Voici le résumé vérifié.',
      contextRevision: 1,
      contextDigest: CONTEXT,
      sidebandOwnerTokenHash: OWNER_TOKEN,
      signal: expect.any(AbortSignal),
    }));
    expect(value.sockets[0]?.socket.sent.map((raw) => JSON.parse(raw).type)).toEqual(['session.update']);
    await value.manager.onApplicationShutdown();
  });

  it('attend la transcription finale, déduplique added/done et ignore le commit VAD comme autorité', async () => {
    const value = harness();
    const run = vi.fn(async () => readyOutcome());
    await attach(value, { turn: run });
    const socket = value.sockets[0]!.socket;
    socket.providerEvent({ type: 'input_audio_buffer.committed', item_id: 'item_2' });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    const item = {
      id: 'item_text',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Résume.' }],
    };
    socket.providerEvent({ type: 'conversation.item.added', item });
    socket.providerEvent({ type: 'conversation.item.done', item });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await value.manager.onApplicationShutdown();
  });

  it.each([
    { type: 'response.created', response: { id: 'rogue' } },
    { type: 'response.output_text.delta', delta: 'attaque' },
    { type: 'response.output_audio.delta', delta: 'AAAA' },
    { type: 'output_audio_buffer.started' },
  ])('raccroche sur toute sortie provider injectée %#', async (event) => {
    const value = harness();
    await attach(value);
    value.sockets[0]!.socket.providerEvent(event);
    await vi.waitFor(() => expect(value.terminate).toHaveBeenCalledWith('kill_switch'));
    expect(value.publish).not.toHaveBeenCalled();
    expect(value.sockets[0]?.socket.sent.map((raw) => JSON.parse(raw).type)).not.toContain('response.create');
  });

  it('scelle le contrôle avant livraison sans jamais créer d’autorité locale après l’ACK', async () => {
    const value = harness();
    await attach(value, {
      turn: async () => readyOutcome({ navigate: '/devis/new' }),
      contextCurrent: true,
    });
    finalTranscript(value.sockets[0]!.socket, 'item_control');
    await vi.waitFor(() => expect(value.publish).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(value.issueControl).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      subjectHash: SUBJECT,
      sessionId: SESSION,
      turnId: TURN,
      artifactId: ARTIFACT,
      sidebandOwnerEpoch: OWNER.ownerEpoch,
      sidebandOwnerTokenHash: OWNER_TOKEN,
      navigate: '/devis/new',
    })));

    const waiting = value.manager.consumeAgentControl({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: SESSION,
      turnId: TURN,
      contextRevision: 1,
      contextDigest: CONTEXT,
    });
    await Promise.resolve();
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    value.manager.speechDelivered({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: SESSION,
      turnId: TURN,
      artifactId: ARTIFACT,
      acknowledgementId: ACKNOWLEDGEMENT,
      contextRevision: 1,
      contextDigest: CONTEXT,
    });
    await expect(waiting).resolves.toEqual({ status: 'not_found' });
    await expect(value.manager.consumeAgentControl({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: SESSION,
      turnId: TURN,
      contextRevision: 1,
      contextDigest: CONTEXT,
    })).resolves.toEqual({ status: 'not_found' });
    await value.manager.onApplicationShutdown();
  });

  it('ignore un faux ACK de livraison et ne publie aucun contrôle', async () => {
    vi.useFakeTimers();
    const value = harness();
    await attach(value, { turn: async () => readyOutcome({ navigate: '/devis/new' }) });
    finalTranscript(value.sockets[0]!.socket, 'item_false_ack');
    await vi.waitFor(() => expect(value.publish).toHaveBeenCalledOnce());
    value.manager.speechDelivered({
      userId: 'user-1', companyId: 'company-1', sessionHandle: SESSION,
      turnId: TURN, artifactId: '00000000-0000-4000-8000-000000000021',
      acknowledgementId: ACKNOWLEDGEMENT,
      contextRevision: 1, contextDigest: CONTEXT,
    });
    const consumed = value.manager.consumeAgentControl({
      userId: 'user-1', companyId: 'company-1', sessionHandle: SESSION,
      turnId: TURN, contextRevision: 1, contextDigest: CONTEXT,
    });
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(consumed).resolves.toEqual({ status: 'not_found' });
    await value.manager.onApplicationShutdown();
  });

  it('barge-in annule l’artefact privé sans aucun message de contrôle provider', async () => {
    const value = harness();
    await attach(value, { turn: async () => readyOutcome() });
    finalTranscript(value.sockets[0]!.socket, 'item_barge');
    await vi.waitFor(() => expect(value.publish).toHaveBeenCalledOnce());
    value.sockets[0]!.socket.providerEvent({ type: 'input_audio_buffer.speech_started' });
    await vi.waitFor(() => expect(value.cancel).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      subjectHash: SUBJECT,
      sessionId: SESSION,
      turnId: TURN,
      artifactId: ARTIFACT,
      reason: 'barge_in',
    })));
    const sentTypes = value.sockets[0]!.socket.sent.map((raw) => JSON.parse(raw).type);
    expect(sentTypes).toEqual(['session.update']);
    await value.manager.onApplicationShutdown();
  });

  it('annule et ferme si un contrôle actionnable ne peut pas être scellé durablement', async () => {
    const value = harness({ issueControl: async () => ({ status: 'unavailable' }) });
    await attach(value, { turn: async () => readyOutcome({ navigate: '/devis/new' }) });
    finalTranscript(value.sockets[0]!.socket, 'item_control_seal_failure');
    await vi.waitFor(() => expect(value.cancel).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: ARTIFACT,
      reason: 'session_end',
    })));
    await vi.waitFor(() => expect(value.terminate).toHaveBeenCalledWith('kill_switch'));
    expect(value.issueControl).toHaveBeenCalledOnce();
  });

  it('fence aussi un résultat publisher tardif après barge-in', async () => {
    let resolvePublish!: (value: unknown) => void;
    let capturedSignal: AbortSignal | undefined;
    const value = harness({
      publish: (input) => {
        capturedSignal = input.signal;
        return new Promise((resolve) => { resolvePublish = resolve; });
      },
    });
    await attach(value, { turn: async () => readyOutcome() });
    finalTranscript(value.sockets[0]!.socket, 'item_late');
    await vi.waitFor(() => expect(value.publish).toHaveBeenCalledOnce());
    value.sockets[0]!.socket.providerEvent({ type: 'input_audio_buffer.speech_started' });
    expect(capturedSignal?.aborted).toBe(true);
    resolvePublish({ status: 'ready', artifactId: ARTIFACT, sequence: 1 });
    await vi.waitFor(() => expect(value.cancel).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: ARTIFACT,
      reason: 'barge_in',
    })));
    await value.manager.onApplicationShutdown();
  });

  it('applique durablement un nouveau contexte, annule l’ancien artefact et refuse son ACK tardif', async () => {
    vi.useFakeTimers();
    const value = harness();
    await attach(value, { turn: async () => readyOutcome({ navigate: '/devis/new' }) });
    finalTranscript(value.sockets[0]!.socket, 'item_context');
    await vi.waitFor(() => expect(value.publish).toHaveBeenCalledOnce());
    value.manager.contextChanged({
      userId: 'user-1', companyId: 'company-1', sessionHandle: SESSION,
      revision: 2, digest: 'e'.repeat(64),
    });
    await vi.waitFor(() => expect(value.owner.applyContext).toHaveBeenLastCalledWith(
      OWNER,
      { revision: 2, digest: 'e'.repeat(64) },
    ));
    await vi.waitFor(() => expect(value.cancel).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: ARTIFACT,
      reason: 'context_changed',
    })));
    value.manager.speechDelivered({
      userId: 'user-1', companyId: 'company-1', sessionHandle: SESSION,
      turnId: TURN, artifactId: ARTIFACT, acknowledgementId: ACKNOWLEDGEMENT,
      contextRevision: 1, contextDigest: CONTEXT,
    });
    const consumed = value.manager.consumeAgentControl({
      userId: 'user-1', companyId: 'company-1', sessionHandle: SESSION,
      turnId: TURN, contextRevision: 1, contextDigest: CONTEXT,
    });
    await expect(consumed).resolves.toEqual({ status: 'not_found' });
    await value.manager.onApplicationShutdown();
  });

  it('échoue fermé si l’owner durable est occupé ou absent', async () => {
    const value = harness({ ownerAcquire: async () => ({ status: 'busy' as const }) });
    await expect(attach(value)).rejects.toThrow('sideband_owner_busy');
    expect(value.terminate).toHaveBeenCalledWith('kill_switch');
    expect(value.publish).not.toHaveBeenCalled();
  });

  it('perd le droit de parler dès qu’un renouvellement owner échoue', async () => {
    vi.useFakeTimers();
    const value = harness({ ownerRenew: async () => ({ status: 'lost' as const }) });
    await attach(value);
    await vi.advanceTimersByTimeAsync(10_001);
    await vi.waitFor(() => expect(value.terminate).toHaveBeenCalledWith('kill_switch'));
    expect(value.owner.release).toHaveBeenCalledWith(OWNER);
  });

  it('rejette la dérive de politique et les items assistant/outils injectés', async () => {
    const value = harness();
    await attach(value);
    value.sockets[0]!.socket.providerEvent({
      type: 'conversation.item.added',
      item: { id: 'rogue', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'attaque' }] },
    });
    await vi.waitFor(() => expect(value.terminate).toHaveBeenCalledWith('kill_switch'));

    const drift = harness();
    await attach(drift);
    drift.sockets[0]!.socket.providerEvent({
      type: 'session.updated',
      session: { ...buildOpenAiRealtimeSessionConfig(SETTINGS), tools: [{ type: 'function', name: 'payer' }] },
    });
    await vi.waitFor(() => expect(drift.terminate).toHaveBeenCalledWith('kill_switch'));
  });

  it('ferme aussi une session déjà active sur erreur réseau sideband', async () => {
    const value = harness();
    await attach(value);
    value.sockets[0]!.socket.emit('error', new Error('transport dropped'));
    await vi.waitFor(() => expect(value.terminate).toHaveBeenCalledWith('kill_switch'));
  });

  it('libère l’owner avant le hangup et borne le shutdown', async () => {
    const events: string[] = [];
    const value = harness();
    value.owner.release.mockImplementation(async () => {
      events.push('owner.release');
      return { status: 'released' };
    });
    value.terminate.mockImplementation(async () => {
      events.push('provider.hangup');
      return 'confirmed';
    });
    await attach(value);
    await value.manager.onApplicationShutdown();
    expect(events).toEqual(['owner.release', 'provider.hangup']);
    expect(value.sockets[0]?.socket.closeReason).toBe('bob_shutdown');
  });

  it('refuse de démarrer sans publisher/owner/cancellation durables', async () => {
    const manager = new RealtimeSidebandManager(
      SETTINGS,
      { createCall: vi.fn(), hangupCall: vi.fn(async () => undefined) },
      new Metrics(),
      loggerStub(),
    );
    await expect(manager.attach({
      callId: 'rtc_missing_speech',
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: SESSION,
      session: buildOpenAiRealtimeSessionConfig(SETTINGS),
    })).rejects.toThrow('sideband_speech_not_configured');
  });
});
