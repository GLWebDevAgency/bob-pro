import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientOptions, RawData } from 'ws';
import type { AppLogger } from '../../observability/logger';
import { Metrics } from '../../observability/metrics';
import {
  buildOpenAiNativeRealtimeSessionConfig,
  buildOpenAiRealtimeSessionConfig,
} from './realtime-session-config';
import { OpenAiNativeSpeechAuthority } from './openai-native-speech-authority';
import {
  OPENAI_NATIVE_ELIGIBLE_SPEECH_V1,
} from './openai-native-speech-risk';
import type {
  OpenAiNativeSpeechDeliveryCompareAndSwapInput,
  OpenAiNativeSpeechDeliveryCompareAndSwapResult,
  OpenAiNativeSpeechDeliveryKey,
  OpenAiNativeSpeechDeliveryPrepareResult,
  OpenAiNativeSpeechDeliveryReadResult,
  OpenAiNativeSpeechDeliveryRepositoryPort,
  OpenAiNativeSpeechDeliveryState,
} from './openai-native-speech-delivery';
import {
  RealtimeSidebandManager,
  type RealtimeSidebandAuditedSpeechDependencies,
  type RealtimeSidebandSocketFactory,
  type RealtimeSidebandSpeechDependencies,
} from './realtime-sideband';
import type {
  RealtimeSidebandOwnerIdentity,
  RealtimeSidebandOwnerPort,
} from './realtime-sideband-owner';
import type { RealtimeSpeechPublisherInput } from './realtime-speech-publisher';
import type { RealtimeVoiceUsageWriterPort } from './realtime-voice-usage';
import type { OpenAiRealtimeCallProvider, RealtimeVoiceSettings } from './realtime.types';

const SESSION = '00000000-0000-4000-8000-000000000001';
const TURN = '00000000-0000-4000-8000-000000000010';
const ARTIFACT = '00000000-0000-4000-8000-000000000020';
const ACKNOWLEDGEMENT = '00000000-0000-4000-8000-000000000030';
const CONTEXT = 'a'.repeat(64);
const OWNER_TOKEN = 'b'.repeat(64);
const OWNER_INSTANCE = 'c'.repeat(64);
const SUBJECT = 'd'.repeat(64);
const NATIVE_DELIVERY = '00000000-0000-4000-8000-000000000040';
const NATIVE_CLAIM = '00000000-0000-4000-8000-000000000041';
const NATIVE_RESPONSE = 'resp_native_1';
const NATIVE_ITEM = 'item_native_1';
const NATIVE_PROOF_SECRET = 'native-proof-secret-with-more-than-thirty-two-characters';

const SETTINGS: RealtimeVoiceSettings = {
  enabled: true,
  provider: 'openai',
  speechDelivery: 'audited-signed-url-v1',
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

const NATIVE_SETTINGS: RealtimeVoiceSettings = {
  ...SETTINGS,
  speechDelivery: 'openai-native-webrtc-v1',
};

const OWNER: RealtimeSidebandOwnerIdentity = {
  companyId: 'company-1',
  subjectHash: SUBJECT,
  sessionId: SESSION,
  ownerInstanceHash: OWNER_INSTANCE,
  ownerTokenHash: OWNER_TOKEN,
  ownerEpoch: 3,
};

class NativeMemoryRepository implements OpenAiNativeSpeechDeliveryRepositoryPort {
  readonly states = new Map<string, OpenAiNativeSpeechDeliveryState>();

  async prepare(
    state: OpenAiNativeSpeechDeliveryState,
  ): Promise<OpenAiNativeSpeechDeliveryPrepareResult> {
    const existing = this.states.get(state.deliveryId);
    if (!existing) {
      this.states.set(state.deliveryId, state);
      return { status: 'created', state };
    }
    return JSON.stringify(existing) === JSON.stringify(state)
      ? { status: 'already_prepared', state: existing }
      : { status: 'conflict' };
  }

  async read(key: OpenAiNativeSpeechDeliveryKey): Promise<OpenAiNativeSpeechDeliveryReadResult> {
    const state = this.states.get(key.deliveryId);
    return state?.companyId === key.companyId
      ? { status: 'found', state }
      : { status: 'not_found' };
  }

  async compareAndSwap(
    input: OpenAiNativeSpeechDeliveryCompareAndSwapInput,
  ): Promise<OpenAiNativeSpeechDeliveryCompareAndSwapResult> {
    const current = this.states.get(input.key.deliveryId);
    if (!current || current.companyId !== input.key.companyId) return { status: 'not_found' };
    if (current.revision !== input.expectedRevision) {
      return JSON.stringify(current) === JSON.stringify(input.next)
        ? { status: 'already_applied', state: current }
        : { status: 'conflict' };
    }
    this.states.set(input.key.deliveryId, input.next);
    return { status: 'applied', state: input.next };
  }
}

function nativeAuthority(repository: NativeMemoryRepository): OpenAiNativeSpeechAuthority {
  return new OpenAiNativeSpeechAuthority(
    repository,
    {
      proofKeys: {
        currentVersion: 1,
        secret: (version) => version === 1 ? NATIVE_PROOF_SECRET : null,
      },
    },
    {
      deliveryId: () => NATIVE_DELIVERY,
      requestNonce: () => 'native-request-nonce-with-more-than-thirty-two-characters',
      dispatchClaimId: () => NATIVE_CLAIM,
    },
    () => Date.parse('2026-07-22T12:00:00.000Z'),
  );
}

class FakeSocket extends EventEmitter {
  readyState = 0;
  readonly sent: string[] = [];
  closeReason: string | null = null;
  terminated = false;

  constructor(
    private readonly effectiveSession: ReturnType<typeof buildOpenAiRealtimeSessionConfig>
      | ReturnType<typeof buildOpenAiNativeRealtimeSessionConfig> = buildOpenAiRealtimeSessionConfig(SETTINGS),
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
  readonly settings: RealtimeVoiceSettings;
  readonly nativeRepository: NativeMemoryRepository | null;
  readonly nativeAuthority: OpenAiNativeSpeechAuthority | null;
  readonly nativeUsageBatch: ReturnType<typeof vi.fn<NonNullable<
  RealtimeVoiceUsageWriterPort['recordBatch']
  >>> | null;
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
  ownerApplyContext?: RealtimeSidebandOwnerPort['applyContext'];
  cancel?: RealtimeSidebandAuditedSpeechDependencies['cancellation']['cancel'];
  contextCurrent?: boolean;
  issueControl?: RealtimeSidebandAuditedSpeechDependencies['controls']['issue'];
  nativeUsageBatch?: NonNullable<RealtimeVoiceUsageWriterPort['recordBatch']>;
  nativeAtomicUsage?: boolean;
  nativeRepository?: NativeMemoryRepository;
} = {}): Harness {
  const settings = options.settings ?? SETTINGS;
  const isNative = settings.speechDelivery === 'openai-native-webrtc-v1';
  const sockets: Harness['sockets'] = [];
  const factory = ((url: string, clientOptions: ClientOptions) => {
    const socket = new FakeSocket(
      isNative
        ? buildOpenAiNativeRealtimeSessionConfig(settings)
        : buildOpenAiRealtimeSessionConfig(settings),
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
    applyContext: vi.fn(options.ownerApplyContext ?? (async () => ({ status: 'applied' as const }))),
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
  const cancel = vi.fn(options.cancel ?? (async () => ({
    status: 'cancelled' as const,
    idempotent: false,
  })));
  const issueControl = vi.fn(options.issueControl ?? (async () => ({
    status: 'issued' as const,
    grantId: '00000000-0000-4000-8000-000000000098',
  })));
  const nativeRepository = isNative ? options.nativeRepository ?? new NativeMemoryRepository() : null;
  const nativeAuthorityPort = nativeRepository ? nativeAuthority(nativeRepository) : null;
  const nativeUsageBatch = isNative
    ? vi.fn<NonNullable<RealtimeVoiceUsageWriterPort['recordBatch']>>().mockImplementation(
        options.nativeUsageBatch ?? (async () => ({
          status: 'recorded' as const,
          eventIds: [
            '00000000-0000-4000-8000-000000000042',
            '00000000-0000-4000-8000-000000000043',
            '00000000-0000-4000-8000-000000000044',
            '00000000-0000-4000-8000-000000000045',
            '00000000-0000-4000-8000-000000000046',
            '00000000-0000-4000-8000-000000000047',
            '00000000-0000-4000-8000-000000000048',
            '00000000-0000-4000-8000-000000000049',
          ],
        })),
      )
    : null;
  const speech: RealtimeSidebandSpeechDependencies = {
    owner: owner as unknown as RealtimeSidebandOwnerPort,
    ...(isNative
      ? {
          native: {
            authority: nativeAuthorityPort!,
            usage: {
              record: vi.fn(async () => ({ status: 'unavailable' as const })),
              ...(options.nativeAtomicUsage === false ? {} : { recordBatch: nativeUsageBatch! }),
            },
          },
        }
      : {
          audited: {
            publisher: { publish: publish as unknown as RealtimeSidebandAuditedSpeechDependencies['publisher']['publish'] },
            cancellation: { cancel: cancel as unknown as RealtimeSidebandAuditedSpeechDependencies['cancellation']['cancel'] },
            controls: {
              issue: issueControl as unknown as RealtimeSidebandAuditedSpeechDependencies['controls']['issue'],
            },
          },
        }),
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
      settings,
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
    settings,
    nativeRepository,
    nativeAuthority: nativeAuthorityPort,
    nativeUsageBatch,
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
    speechDelivery: value.settings.speechDelivery,
    plan: 'pro',
    subjectKeyVersion: 1,
    session: value.settings.speechDelivery === 'openai-native-webrtc-v1'
      ? buildOpenAiNativeRealtimeSessionConfig(value.settings)
      : buildOpenAiRealtimeSessionConfig(value.settings),
    lifecycle: {
      activate: vi.fn(async () => undefined),
      fenceAfterDurableTerminationClaim: vi.fn(),
      terminate: value.terminate,
    },
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
    speechPurpose: 'business_answer' as const,
    speechSource: 'card_body' as const,
    hasTenantContext: true,
    contextVersion: { version: 1 as const, revision: 1, digest: CONTEXT },
    ...overrides,
  };
}

function nativeReadyOutcome() {
  return readyOutcome({
    canonicalSpeech: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1,
    speechPurpose: 'generic_assistance',
    speechSource: 'card_body',
    hasTenantContext: false,
  });
}

function nativeResponseCreate(socket: FakeSocket): Record<string, unknown> {
  const wire = socket.sent
    .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    .find((entry) => entry.type === 'response.create');
  if (!wire) throw new Error('response.create missing');
  return wire;
}

function nativeMetadata(socket: FakeSocket): Record<string, unknown> {
  const response = nativeResponseCreate(socket).response as Record<string, unknown>;
  return response.metadata as Record<string, unknown>;
}

function emitNativeSuccessfulResponse(socket: FakeSocket, stoppedFirst = false): void {
  const metadata = nativeMetadata(socket);
  socket.providerEvent({
    type: 'response.created',
    response: {
      id: NATIVE_RESPONSE,
      status: 'in_progress',
      conversation_id: null,
      output_modalities: ['audio'],
      output: [],
      metadata,
    },
  });
  socket.providerEvent({
    type: 'response.output_audio.delta',
    response_id: NATIVE_RESPONSE,
    item_id: NATIVE_ITEM,
    output_index: 0,
    content_index: 0,
    delta: 'AQIDBA==',
  });
  socket.providerEvent({
    type: 'response.output_audio.done',
    response_id: NATIVE_RESPONSE,
    item_id: NATIVE_ITEM,
    output_index: 0,
    content_index: 0,
  });
  socket.providerEvent({
    type: 'response.output_audio_transcript.done',
    response_id: NATIVE_RESPONSE,
    item_id: NATIVE_ITEM,
    output_index: 0,
    content_index: 0,
    transcript: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1,
  });
  const stopped = {
    type: 'output_audio_buffer.stopped',
    response_id: NATIVE_RESPONSE,
  };
  const done = {
    type: 'response.done',
    response: {
      id: NATIVE_RESPONSE,
      status: 'completed',
      output_modalities: ['audio'],
      metadata,
      output: [{
        id: NATIVE_ITEM,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{
          type: 'output_audio',
          transcript: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1,
        }],
      }],
      usage: {
        total_tokens: 20,
        input_tokens: 12,
        output_tokens: 8,
        input_token_details: {
          cached_tokens: 0,
          text_tokens: 12,
          audio_tokens: 0,
          image_tokens: 0,
          cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
        },
        output_token_details: { text_tokens: 0, audio_tokens: 8 },
      },
    },
  };
  if (stoppedFirst) {
    socket.providerEvent(stopped);
    socket.providerEvent(done);
  } else {
    socket.providerEvent(done);
    socket.providerEvent(stopped);
  }
}

function acknowledgeNativeSpeech(
  value: Harness,
  overrides: Partial<Parameters<RealtimeSidebandManager['nativeSpeechDelivered']>[0]> = {},
): void {
  value.manager.nativeSpeechDelivered({
    userId: 'user-1',
    companyId: 'company-1',
    sessionHandle: SESSION,
    turnId: TURN,
    deliveryId: NATIVE_DELIVERY,
    acknowledgementId: ACKNOWLEDGEMENT,
    contextRevision: 1,
    contextDigest: CONTEXT,
    ...overrides,
  });
}

async function persistNativeAcknowledgement(
  value: Harness,
  overrides: Partial<Parameters<OpenAiNativeSpeechAuthority['acknowledgeMobileDelivery']>[0]> = {},
): Promise<void> {
  const outcome = await value.nativeAuthority!.acknowledgeMobileDelivery({
    companyId: 'company-1',
    subjectHmacCandidates: [{ version: 1, subjectHmac: SUBJECT }],
    deliveryId: NATIVE_DELIVERY,
    sessionId: SESSION,
    turnId: TURN,
    contextRevision: 1,
    contextDigest: CONTEXT,
    acknowledgementId: ACKNOWLEDGEMENT,
    localObservation: {
      formatVersion: 1,
      kind: 'webrtc_remote_rtp_observed_provider_drained_v1',
    },
    slo: null,
    ...overrides,
  });
  expect(outcome).toMatchObject({ status: 'applied', state: { phase: 'delivered' } });
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

  it('ferme immédiatement l’ancien contexte pendant son application durable', async () => {
    let resolveContext!: () => void;
    let contextApplied = false;
    const contextPending = new Promise<void>((resolve) => { resolveContext = resolve; });
    const turn = vi.fn(async () => readyOutcome());
    const value = harness({
      ownerApplyContext: async (_owner, context) => {
        if (context.revision === 1) return { status: 'applied' as const };
        await contextPending;
        contextApplied = true;
        return { status: 'applied' as const };
      },
    });
    await attach(value, { turn });

    value.manager.contextChanged({
      userId: 'user-1', companyId: 'company-1', sessionHandle: SESSION,
      revision: 2, digest: 'e'.repeat(64),
    });
    await vi.waitFor(() => expect(value.owner.applyContext).toHaveBeenCalledTimes(2));
    finalTranscript(value.sockets[0]!.socket, 'item_during_context_transition');
    await Promise.resolve();
    expect(turn).not.toHaveBeenCalled();

    resolveContext();
    await vi.waitFor(() => expect(contextApplied).toBe(true));
    finalTranscript(value.sockets[0]!.socket, 'item_after_context_transition');
    await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
    await value.manager.onApplicationShutdown();
  });

  it('ne lance que le dernier cerveau lorsque deux transcripts arrivent dans le même tick', async () => {
    const turn = vi.fn(async () => readyOutcome());
    const value = harness();
    await attach(value, { turn });
    const socket = value.sockets[0]!.socket;

    finalTranscript(socket, 'item_concurrent_a', 'Première demande.');
    finalTranscript(socket, 'item_concurrent_b', 'Deuxième demande.');

    await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
    expect(turn).toHaveBeenCalledWith(expect.objectContaining({ transcript: 'Deuxième demande.' }));
    await value.manager.onApplicationShutdown();
  });

  it('borne une annulation auditée indisponible avant le hangup', async () => {
    const value = harness({
      settings: { ...SETTINGS, sidebandTimeoutMs: 25 },
      cancel: async () => new Promise<never>(() => undefined),
    });
    await attach(value, { turn: async () => readyOutcome() });
    finalTranscript(value.sockets[0]!.socket, 'item_cancel_timeout');
    await vi.waitFor(() => expect(value.publish).toHaveBeenCalledOnce());

    await expect(value.manager.closeSession({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: SESSION,
    })).resolves.toBe('confirmed');
    expect(value.cancel).toHaveBeenCalledOnce();
    expect(value.terminate).toHaveBeenCalledWith('user');
  });

  it('détache localement sous claim durable sans terminer provider ni lease', async () => {
    const value = harness();
    await attach(value);

    expect(value.manager.fenceAndDetachSession({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: SESSION,
    })).toBe('detached');

    expect(value.terminate).not.toHaveBeenCalled();
    expect(value.provider.hangupCall).not.toHaveBeenCalled();
    expect(value.sockets[0]?.socket.terminated).toBe(true);
    await vi.waitFor(() => expect(value.owner.release).toHaveBeenCalledWith(OWNER));
    expect(value.manager.fenceAndDetachSession({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: SESSION,
    })).toBe('not_found');
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
      speechDelivery: 'audited-signed-url-v1',
      plan: 'pro',
      subjectKeyVersion: 1,
      session: buildOpenAiRealtimeSessionConfig(SETTINGS),
    })).rejects.toThrow('sideband_speech_not_configured');
  });
});

describe('RealtimeSidebandManager — sortie OpenAI native sous autorité durable', () => {
  it('refuse le runtime natif avant ouverture si la métrologie atomique manque', async () => {
    const value = harness({ settings: NATIVE_SETTINGS, nativeAtomicUsage: false });
    await expect(attach(value)).rejects.toThrow('sideband_speech_not_configured');
    expect(value.sockets).toHaveLength(0);
  });

  it.each([false, true])(
    'émet une seule réponse OOB, persiste l’usage et converge avec stoppedFirst=%s',
    async (stoppedFirst) => {
      const value = harness({ settings: NATIVE_SETTINGS });
      await attach(value, { turn: async () => nativeReadyOutcome() });
      const socket = value.sockets[0]!.socket;

      finalTranscript(socket, 'native-input-1', 'Aide-moi.');
      await vi.waitFor(() => expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual([
        'session.update',
        'response.create',
      ]));
      expect(value.publish).not.toHaveBeenCalled();

      emitNativeSuccessfulResponse(socket, stoppedFirst);
      await vi.waitFor(() => expect(value.nativeUsageBatch).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(value.nativeRepository?.states.get(NATIVE_DELIVERY)?.phase)
        .toBe('completed'));
      expect(value.nativeUsageBatch?.mock.calls[0]?.[0].map((measure) => measure.kind)).toEqual([
        'realtime_uncached_text_tokens_in',
        'realtime_uncached_audio_tokens_in',
        'realtime_uncached_image_tokens_in',
        'realtime_cached_text_tokens_in',
        'realtime_cached_audio_tokens_in',
        'realtime_cached_image_tokens_in',
        'realtime_text_tokens_out',
        'realtime_audio_tokens_out',
      ]);
      expect(value.terminate).not.toHaveBeenCalled();
    },
  );

  it('refuse sans response.create une parole métier qui exige le chemin audité v5', async () => {
    const value = harness({ settings: NATIVE_SETTINGS });
    await attach(value, { turn: async () => readyOutcome() });
    const socket = value.sockets[0]!.socket;

    finalTranscript(socket, 'native-input-sensitive', 'Résume ma facture.');
    await vi.waitFor(() => expect(value.terminate).toHaveBeenCalledWith('kill_switch'));
    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['session.update']);
    expect(value.nativeUsageBatch).not.toHaveBeenCalled();
    expect(value.publish).not.toHaveBeenCalled();
  });

  it('annule sans dispatch une preuve préparée devenue obsolète pendant le changement de contexte', async () => {
    const value = harness({ settings: NATIVE_SETTINGS });
    const repository = value.nativeRepository!;
    const originalPrepare = repository.prepare.bind(repository);
    let releasePrepare!: () => void;
    const prepare = vi.spyOn(repository, 'prepare').mockImplementation((state) => (
      new Promise((resolve) => {
        releasePrepare = () => { void originalPrepare(state).then(resolve); };
      })
    ));
    await attach(value, { turn: async () => nativeReadyOutcome() });
    const socket = value.sockets[0]!.socket;

    finalTranscript(socket, 'native-input-stale', 'Aide-moi.');
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    value.manager.contextChanged({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: SESSION,
      revision: 2,
      digest: 'e'.repeat(64),
    });
    releasePrepare();

    await vi.waitFor(() => expect(repository.states.get(NATIVE_DELIVERY)?.phase).toBe('cancelled'));
    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['session.update']);
    expect(value.terminate).not.toHaveBeenCalled();
  });

  it('traite le barge-in comme une interruption mobile sans doubler cancel et clear côté serveur', async () => {
    const value = harness({ settings: NATIVE_SETTINGS });
    await attach(value, { turn: async () => nativeReadyOutcome() });
    const socket = value.sockets[0]!.socket;
    finalTranscript(socket, 'native-input-barge', 'Aide-moi.');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));

    socket.providerEvent({ type: 'input_audio_buffer.speech_started' });
    await vi.waitFor(() => expect(value.nativeRepository?.states.get(NATIVE_DELIVERY)?.phase)
      .toBe('cancelled'));
    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual([
      'session.update',
      'response.create',
    ]);
  });

  it('annule et purge exactement une fois côté serveur lors d’un changement de contexte', async () => {
    const value = harness({ settings: NATIVE_SETTINGS });
    await attach(value, { turn: async () => nativeReadyOutcome() });
    const socket = value.sockets[0]!.socket;
    finalTranscript(socket, 'native-input-context', 'Aide-moi.');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const metadata = nativeMetadata(socket);
    socket.providerEvent({
      type: 'response.created',
      response: {
        id: NATIVE_RESPONSE,
        status: 'in_progress',
        conversation_id: null,
        output_modalities: ['audio'],
        output: [],
        metadata,
      },
    });
    await vi.waitFor(() => expect(value.nativeRepository?.states.get(NATIVE_DELIVERY)?.phase)
      .toBe('accepted'));

    value.manager.contextChanged({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle: SESSION,
      revision: 2,
      digest: 'e'.repeat(64),
    });

    await vi.waitFor(() => expect(value.nativeRepository?.states.get(NATIVE_DELIVERY)?.phase)
      .toBe('cancelled'));
    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual([
      'session.update',
      'response.create',
      'response.cancel',
      'output_audio_buffer.clear',
    ]);
    expect(value.terminate).not.toHaveBeenCalled();
  });

  it('ne publie le tour Bob dans l’historique qu’après l’ACK natif durable exact', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(nativeReadyOutcome())
      .mockResolvedValueOnce({ status: 'aborted' as const });
    const value = harness({ settings: NATIVE_SETTINGS });
    await attach(value, { turn: run });
    const socket = value.sockets[0]!.socket;

    finalTranscript(socket, 'native-input-ack-1', 'Aide-moi.');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    emitNativeSuccessfulResponse(socket);
    await vi.waitFor(() => expect(value.nativeRepository?.states.get(NATIVE_DELIVERY)?.phase)
      .toBe('completed'));

    finalTranscript(socket, 'native-input-ack-2', 'Explique encore.');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).toHaveBeenCalledOnce();
    expect(value.nativeRepository?.states.get(NATIVE_DELIVERY)?.phase).toBe('completed');

    acknowledgeNativeSpeech(value, { contextDigest: 'f'.repeat(64) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).toHaveBeenCalledOnce();

    await persistNativeAcknowledgement(value);
    acknowledgeNativeSpeech(value);
    acknowledgeNativeSpeech(value);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]?.[0].history).toEqual([
      { role: 'user', text: 'Aide-moi.' },
      { role: 'bob', text: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1 },
    ]);
    expect(value.terminate).not.toHaveBeenCalled();
  });

  it('réconcilie sur PostgreSQL un ACK écrit par une autre réplique sans notification locale', async () => {
    const repository = new NativeMemoryRepository();
    const ownerReplica = harness({ settings: NATIVE_SETTINGS, nativeRepository: repository });
    const acknowledgementReplica = harness({ settings: NATIVE_SETTINGS, nativeRepository: repository });
    const run = vi.fn()
      .mockResolvedValueOnce(nativeReadyOutcome())
      .mockResolvedValueOnce({ status: 'aborted' as const });
    await attach(ownerReplica, { turn: run });
    const socket = ownerReplica.sockets[0]!.socket;

    finalTranscript(socket, 'native-input-cross-replica-1', 'Aide-moi.');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    emitNativeSuccessfulResponse(socket);
    await vi.waitFor(() => expect(repository.states.get(NATIVE_DELIVERY)?.phase).toBe('completed'));

    await persistNativeAcknowledgement(acknowledgementReplica);
    // La notification process-local part sur la mauvaise réplique et doit rester un simple fast-path.
    acknowledgeNativeSpeech(acknowledgementReplica);
    await new Promise((resolve) => setTimeout(resolve, 150));
    finalTranscript(socket, 'native-input-cross-replica-2', 'Continue.');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]?.[0].history).toEqual([
      { role: 'user', text: 'Aide-moi.' },
      { role: 'bob', text: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1 },
    ]);
    expect(ownerReplica.terminate).not.toHaveBeenCalled();
  });

  it('révoque encore une réponse completed si l’utilisateur reprend la parole avant l’ACK', async () => {
    const value = harness({ settings: NATIVE_SETTINGS });
    await attach(value, { turn: async () => nativeReadyOutcome() });
    const socket = value.sockets[0]!.socket;

    finalTranscript(socket, 'native-input-completed-barge', 'Aide-moi.');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    emitNativeSuccessfulResponse(socket);
    await vi.waitFor(() => expect(value.nativeRepository?.states.get(NATIVE_DELIVERY)?.phase)
      .toBe('completed'));

    socket.providerEvent({ type: 'input_audio_buffer.speech_started' });

    await vi.waitFor(() => expect(value.nativeRepository?.states.get(NATIVE_DELIVERY)?.phase)
      .toBe('cancelled'));
    await expect(value.nativeAuthority!.acknowledgeMobileDelivery({
      companyId: 'company-1',
      subjectHmacCandidates: [{ version: 1, subjectHmac: SUBJECT }],
      deliveryId: NATIVE_DELIVERY,
      sessionId: SESSION,
      turnId: TURN,
      contextRevision: 1,
      contextDigest: CONTEXT,
      acknowledgementId: ACKNOWLEDGEMENT,
      localObservation: {
        formatVersion: 1,
        kind: 'webrtc_remote_rtp_observed_provider_drained_v1',
      },
      slo: null,
    })).resolves.toEqual({ status: 'conflict' });
  });

  it('ferme sans lancer un nouveau cerveau si l’ACK natif durable reste absent', async () => {
    const run = vi.fn(async () => nativeReadyOutcome());
    const value = harness({ settings: NATIVE_SETTINGS });
    await attach(value, { turn: run });
    const socket = value.sockets[0]!.socket;

    finalTranscript(socket, 'native-input-timeout-1', 'Aide-moi.');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    emitNativeSuccessfulResponse(socket);
    await vi.waitFor(() => expect(value.nativeRepository?.states.get(NATIVE_DELIVERY)?.phase)
      .toBe('completed'));

    finalTranscript(socket, 'native-input-timeout-2', 'Continue.');
    await vi.waitFor(() => expect(value.terminate).toHaveBeenCalledWith('kill_switch'));
    expect(run).toHaveBeenCalledOnce();
    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual([
      'session.update',
      'response.create',
    ]);
  });

  it('hard-fence une réponse fournisseur qui ne correspond à aucune livraison préparée', async () => {
    const value = harness({ settings: NATIVE_SETTINGS });
    await attach(value);
    const socket = value.sockets[0]!.socket;
    socket.providerEvent({
      type: 'response.created',
      response: {
        id: 'resp_rogue',
        status: 'in_progress',
        conversation_id: null,
        output_modalities: ['audio'],
        output: [],
        metadata: {
          bob_delivery_id: '00000000-0000-4000-8000-000000000099',
        },
      },
    });
    expect(socket.terminated).toBe(true);
    await vi.waitFor(() => expect(value.terminate).toHaveBeenCalledWith('kill_switch'));
    expect(socket.terminated || socket.closeReason === 'bob_kill_switch').toBe(true);
  });
});
