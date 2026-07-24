import { describe, expect, it, vi } from 'vitest';
import { OPENAI_NATIVE_ELIGIBLE_SPEECH_V1 } from './openai-native-speech-risk';
import {
  createOpenAiNativeSpeechDelivery,
  transitionOpenAiNativeSpeechDelivery,
  type OpenAiNativeSpeechDeliveryState,
} from './openai-native-speech-delivery';
import type {
  OpenAiNativeSpeechAuthority,
  OpenAiNativeSpeechAuthorityBinding,
} from './openai-native-speech-authority';
import {
  OPENAI_NATIVE_MAX_PENDING_EVENTS,
  OPENAI_NATIVE_MAX_PRE_REQUEST_EVENTS,
  OpenAiNativeResponseDispatcher,
  type OpenAiNativePreparedResponseTurn,
  type OpenAiNativeResponseDispatcherTiming,
  type OpenAiNativeResponseSessionFencePort,
  type OpenAiNativeResponseSocket,
  type OpenAiNativeResponseUsagePort,
} from './openai-native-response-dispatcher';
import {
  OPENAI_NATIVE_RESPONSE_LIMITS,
  OPENAI_NATIVE_RESPONSE_PROTOCOL,
} from './openai-native-response-protocol';

const COMPANY = 'company-1';
const SUBJECT = 'a'.repeat(64);
const SESSION = '10000000-0000-4000-8000-000000000001';
const TURN = '20000000-0000-4000-8000-000000000002';
const DELIVERY = '30000000-0000-4000-8000-000000000003';
const CLAIM = '40000000-0000-4000-8000-000000000004';
const CANCELLATION = '50000000-0000-4000-8000-000000000005';
const FAILURE = '60000000-0000-4000-8000-000000000006';
const DIGEST = 'b'.repeat(64);
const OWNER = 'c'.repeat(64);
const REQUEST_NONCE = 'request_nonce_1234567890_ABCDEFGHIJK';
const RESPONSE = 'resp_bob_1';
const OTHER_RESPONSE = 'resp_rogue_2';
const ITEM = 'item_bob_1';
const SPEECH = OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1;

const BINDING: OpenAiNativeSpeechAuthorityBinding = {
  companyId: COMPANY,
  subjectHmac: SUBJECT,
  deliveryId: DELIVERY,
  sessionId: SESSION,
  turnId: TURN,
  contextRevision: 7,
  contextDigest: DIGEST,
  sidebandOwnerEpoch: 2,
  sidebandOwnerTokenHmac: OWNER,
};

const REQUEST = {
  deliveryId: DELIVERY,
  turnId: TURN,
  contextRevision: 7,
  contextDigest: DIGEST,
  requestNonce: REQUEST_NONCE,
  canonicalSpeech: SPEECH,
};

const METADATA = {
  bob_protocol: OPENAI_NATIVE_RESPONSE_PROTOCOL,
  bob_delivery_id: DELIVERY,
  bob_turn_id: TURN,
  bob_context_revision: '7',
  bob_context_digest: DIGEST,
  bob_request_nonce: REQUEST_NONCE,
};

function preparedState(): OpenAiNativeSpeechDeliveryState {
  return createOpenAiNativeSpeechDelivery({
    ...BINDING,
    subjectKeyVersion: 1,
    speechPolicyVersion: 1,
    speechScenarioId: 'generic_help_v1',
    proofFormatVersion: 2,
    proofKeyVersion: 4,
    canonicalSpeechHmac: 'd'.repeat(64),
    factsHmac: 'e'.repeat(64),
    requestNonceHmac: 'f'.repeat(64),
    provider: 'openai',
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    createdAtMs: 1_000,
    expiresAtMs: 121_000,
  });
}

function prepared(): OpenAiNativePreparedResponseTurn {
  return {
    status: 'prepared',
    persistence: 'created',
    state: preparedState(),
    request: REQUEST,
  };
}

function claimedState(state: OpenAiNativeSpeechDeliveryState): OpenAiNativeSpeechDeliveryState {
  return transitionOpenAiNativeSpeechDelivery(state, {
    type: 'CLAIM_DISPATCH',
    dispatchClaimId: CLAIM,
    atMs: 1_001,
  }).state;
}

function applied() {
  return { status: 'applied' as const, state: preparedState() };
}

type AuthorityDouble = {
  [K in
  | 'claimDispatch'
  | 'markRequested'
  | 'acceptProviderResponse'
  | 'startStreaming'
  | 'responseDone'
  | 'outputStopped'
  | 'cancel'
  | 'fail']: ReturnType<typeof vi.fn>;
};

function authority(overrides: Partial<AuthorityDouble> = {}): AuthorityDouble {
  const base: AuthorityDouble = {
    claimDispatch: vi.fn(async (input: { readonly request?: typeof REQUEST }) => (
      input.request?.canonicalSpeech === REQUEST.canonicalSpeech
      && input.request.requestNonce === REQUEST.requestNonce
        ? {
          status: 'authorized' as const,
          dispatchClaimId: CLAIM,
          state: claimedState(preparedState()),
          request: Object.freeze({ ...input.request }),
        }
        : { status: 'not_authorized' as const }
    )),
    markRequested: vi.fn(async () => applied()),
    acceptProviderResponse: vi.fn(async () => applied()),
    startStreaming: vi.fn(async () => applied()),
    responseDone: vi.fn(async () => applied()),
    outputStopped: vi.fn(async () => applied()),
    cancel: vi.fn(async () => applied()),
    fail: vi.fn(async () => applied()),
  };
  return { ...base, ...overrides };
}

class ControlledSocket implements OpenAiNativeResponseSocket {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly callbacks: Array<(error?: Error) => void> = [];

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    this.callbacks.push(callback);
  }

  flush(error?: Error): void {
    this.callbacks.shift()?.(error);
  }
}

class ManualTiming implements OpenAiNativeResponseDispatcherTiming {
  readonly responseSendTimeoutMs = 10;
  readonly serverInterruptTimeoutMs = 10;
  private sequence = 0;
  private readonly pending = new Map<number, () => void>();

  setTimeout(callback: () => void, _delayMs: number): unknown {
    this.sequence += 1;
    this.pending.set(this.sequence, callback);
    return this.sequence;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.pending.delete(handle);
  }

  fireAll(): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const callback of pending) callback();
  }
}

function usage(result: 'recorded' | 'duplicate' | 'unavailable' = 'recorded') {
  const record = vi.fn(async () => result === 'unavailable'
    ? { status: 'unavailable' as const }
    : { status: result });
  return { port: { record } satisfies OpenAiNativeResponseUsagePort, record };
}

type FenceBehavior = 'applied' | 'already_closed' | 'failed' | 'throw';

function sessionFence(
  result: FenceBehavior = 'applied',
  emergencyResult: FenceBehavior = 'applied',
) {
  let closed = false;
  const fenceAndClose = vi.fn(() => {
    if (result === 'throw') throw new Error('primary fence failed');
    if (result === 'applied' || result === 'already_closed') closed = true;
    return { status: result };
  });
  const emergencyRevokeAndTerminate = vi.fn(() => {
    if (emergencyResult === 'throw') throw new Error('emergency fence failed');
    if (emergencyResult === 'applied' || emergencyResult === 'already_closed') closed = true;
    return { status: emergencyResult };
  });
  return {
    port: {
      fenceAndClose,
      emergencyRevokeAndTerminate,
    } satisfies OpenAiNativeResponseSessionFencePort,
    fenceAndClose,
    emergencyRevokeAndTerminate,
    isClosed: () => closed,
  };
}

function harness(input: {
  readonly authority?: AuthorityDouble;
  readonly usage?: {
    readonly port: OpenAiNativeResponseUsagePort;
    readonly record: ReturnType<typeof vi.fn>;
  };
  readonly fence?: ReturnType<typeof sessionFence>;
  readonly callbacks?: Partial<ConstructorParameters<typeof OpenAiNativeResponseDispatcher>[5]>;
  readonly entropy?: ConstructorParameters<typeof OpenAiNativeResponseDispatcher>[6];
} = {}) {
  const socket = new ControlledSocket();
  const durable = input.authority ?? authority();
  const metering = input.usage ?? usage();
  const fence = input.fence ?? sessionFence();
  const timing = new ManualTiming();
  const onFatal = input.callbacks?.onFatal ?? vi.fn();
  const dispatcher = new OpenAiNativeResponseDispatcher(
    durable as unknown as OpenAiNativeSpeechAuthority,
    socket,
    1,
    metering.port,
    fence.port,
    { ...input.callbacks, onFatal },
    input.entropy ?? { cancellationId: () => CANCELLATION, failureId: () => FAILURE },
    timing,
  );
  return { dispatcher, socket, durable, metering, fence, timing, onFatal };
}

async function start(h: ReturnType<typeof harness>): Promise<void> {
  const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
  await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));
  h.socket.flush();
  await expect(starting).resolves.toEqual({ status: 'started', deliveryId: DELIVERY });
}

function created(input: {
  readonly responseId?: string;
  readonly metadata?: typeof METADATA;
} = {}): string {
  return JSON.stringify({
    type: 'response.created',
    response: {
      id: input.responseId ?? RESPONSE,
      status: 'in_progress',
      conversation_id: null,
      output_modalities: ['audio'],
      output: [],
      metadata: input.metadata ?? METADATA,
    },
  });
}

function audio(
  type: 'response.output_audio.delta' | 'response.output_audio.done',
  responseId = RESPONSE,
): string {
  return JSON.stringify({
    type,
    response_id: responseId,
    item_id: ITEM,
    output_index: 0,
    content_index: 0,
    ...(type.endsWith('.delta') ? { delta: 'AQIDBA==' } : {}),
  });
}

function transcript(
  type: 'response.output_audio_transcript.delta' | 'response.output_audio_transcript.done',
  value = SPEECH,
): string {
  return JSON.stringify({
    type,
    response_id: RESPONSE,
    item_id: ITEM,
    output_index: 0,
    content_index: 0,
    ...(type.endsWith('.delta') ? { delta: value } : { transcript: value }),
  });
}

function providerUsage() {
  return {
    total_tokens: 20,
    input_tokens: 12,
    output_tokens: 8,
    input_token_details: {
      cached_tokens: 4,
      text_tokens: 4,
      audio_tokens: 6,
      image_tokens: 2,
      cached_tokens_details: { text_tokens: 1, audio_tokens: 2, image_tokens: 1 },
    },
    output_token_details: { text_tokens: 2, audio_tokens: 6 },
  };
}

function done(input: {
  readonly status?: 'completed' | 'cancelled' | 'failed' | 'incomplete';
  readonly responseId?: string;
  readonly transcript?: string;
  readonly includeUsage?: boolean;
  readonly usage?: unknown;
  readonly metadata?: typeof METADATA;
} = {}): string {
  const status = input.status ?? 'completed';
  return JSON.stringify({
    type: 'response.done',
    response: {
      id: input.responseId ?? RESPONSE,
      status,
      output_modalities: ['audio'],
      metadata: input.metadata ?? METADATA,
      output: status === 'completed'
        ? [{
            id: ITEM,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_audio', transcript: input.transcript ?? SPEECH }],
          }]
        : [],
      ...(input.includeUsage === false ? {} : { usage: input.usage ?? providerUsage() }),
    },
  });
}

function stopped(responseId = RESPONSE): string {
  return JSON.stringify({ type: 'output_audio_buffer.stopped', response_id: responseId });
}

function successfulEvents(dispatcher: OpenAiNativeResponseDispatcher, order: 'done_first' | 'stopped_first') {
  dispatcher.handleWireEvent(created());
  dispatcher.handleWireEvent(audio('response.output_audio.delta'));
  dispatcher.handleWireEvent(audio('response.output_audio.done'));
  dispatcher.handleWireEvent(transcript('response.output_audio_transcript.done'));
  if (order === 'done_first') {
    dispatcher.handleWireEvent(done());
    dispatcher.handleWireEvent(stopped());
  } else {
    dispatcher.handleWireEvent(stopped());
    dispatcher.handleWireEvent(done());
  }
}

describe('OpenAiNativeResponseDispatcher', () => {
  it.each(['done_first', 'stopped_first'] as const)(
    'converge en ordre %s, mesure avant RESPONSE_DONE et envoie exactement une réponse OOB',
    async (order) => {
      const completed = vi.fn();
      const h = harness({ callbacks: { onCompleted: completed } });
      const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
      await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));

      successfulEvents(h.dispatcher, order);
      expect(h.durable.acceptProviderResponse).not.toHaveBeenCalled();
      h.socket.flush();
      await expect(starting).resolves.toEqual({ status: 'started', deliveryId: DELIVERY });
      await expect(h.dispatcher.settled()).resolves.toEqual({ status: 'completed' });

      expect(h.socket.sent).toHaveLength(1);
      expect(h.socket.sent[0]).toMatchObject({
        type: 'response.create',
        response: {
          conversation: 'none',
          output_modalities: ['audio'],
          tools: [],
          tool_choice: 'none',
        },
      });
      expect(h.durable.markRequested).toHaveBeenCalledWith({
        ...BINDING,
        dispatchClaimId: CLAIM,
      });
      expect(h.durable.acceptProviderResponse).toHaveBeenCalledWith({
        ...BINDING,
        providerResponseId: RESPONSE,
      });
      expect(h.metering.record).toHaveBeenCalledWith({
        provider: 'openai',
        companyId: COMPANY,
        deliveryId: DELIVERY,
        sessionId: SESSION,
        turnId: TURN,
        usage: {
          status: 'available',
          totalTokens: 20,
          inputTokens: 12,
          outputTokens: 8,
          inputTokenDetails: {
            cachedTokens: 4,
            textTokens: 4,
            audioTokens: 6,
            imageTokens: 2,
            cachedTextTokens: 1,
            cachedAudioTokens: 2,
            cachedImageTokens: 1,
          },
          outputTokenDetails: { textTokens: 2, audioTokens: 6 },
        },
      });
      expect(h.metering.record.mock.invocationCallOrder[0])
        .toBeLessThan(h.durable.responseDone.mock.invocationCallOrder[0]!);
      expect(h.durable.responseDone).toHaveBeenCalledWith({
        ...BINDING,
        providerResponseId: RESPONSE,
        providerTranscript: SPEECH,
      });
      expect(completed).toHaveBeenCalledTimes(1);
      expect(h.onFatal).not.toHaveBeenCalled();
    },
  );

  it('n’expose jamais ses états ni compteurs internes aux callbacks/adapters mutateurs', async () => {
    let completedState: Parameters<NonNullable<
    ConstructorParameters<typeof OpenAiNativeResponseDispatcher>[5]['onCompleted']
    >>[0]['state'] | null = null;
    const record = vi.fn(async (input: Parameters<OpenAiNativeResponseUsagePort['record']>[0]) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.usage)).toBe(true);
      expect(Object.isFrozen(input.usage.inputTokenDetails)).toBe(true);
      try {
        (input.usage as unknown as { totalTokens: number }).totalTokens = 999;
      } catch {
        // A hostile adapter cannot mutate the detached, frozen accounting evidence.
      }
      try {
        (input.usage.inputTokenDetails as { audioTokens: number }).audioTokens = 999;
      } catch {
        // Nested counters are frozen as well.
      }
      return { status: 'recorded' as const };
    });
    const metering = {
      port: { record } satisfies OpenAiNativeResponseUsagePort,
      record,
    };
    const completed = vi.fn((input: { readonly state: NonNullable<typeof completedState> }) => {
      completedState = input.state;
      expect(Object.isFrozen(input.state)).toBe(true);
      expect(Object.isFrozen(input.state.expected)).toBe(true);
      expect(Object.isFrozen(input.state.usage)).toBe(true);
      try {
        (input.state as unknown as { phase: string }).phase = 'streaming';
      } catch {
        // A UI callback never owns the reducer projection.
      }
      try {
        (input.state.expected as { canonicalSpeech: string }).canonicalSpeech = 'forgée';
      } catch {
        // The request proof exposed to callbacks is immutable too.
      }
    });
    const h = harness({ usage: metering, callbacks: { onCompleted: completed } });
    await start(h);
    successfulEvents(h.dispatcher, 'done_first');
    await expect(h.dispatcher.settled()).resolves.toEqual({ status: 'completed' });

    expect(completedState).toMatchObject({
      phase: 'completed',
      expected: { canonicalSpeech: SPEECH },
      usage: { status: 'available', totalTokens: 20 },
    });
    expect(record.mock.calls[0]?.[0].usage.totalTokens).toBe(20);
    expect(h.dispatcher.handleWireEvent(audio('response.output_audio.delta'))).toEqual({
      status: 'handled',
    });
    await expect(h.dispatcher.settled()).resolves.toMatchObject({
      status: 'fatal', reason: 'protocol_violation', closeRequired: true,
    });
  });

  it('ne rejoue jamais un send ambigu, même après callback tardif ou second start', async () => {
    const h = harness();
    const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));
    h.socket.flush(new Error('ambiguous'));

    await expect(starting).resolves.toEqual({
      status: 'fatal', reason: 'socket_send_ambiguous', closeRequired: true,
    });
    h.socket.flush();
    await expect(h.dispatcher.start({ prepared: prepared(), binding: BINDING })).resolves.toEqual({
      status: 'not_started', reason: 'already_started', closeRequired: false,
    });
    expect(h.socket.sent).toHaveLength(1);
    expect(h.fence.isClosed()).toBe(true);
    expect(h.fence.fenceAndClose).toHaveBeenCalledTimes(1);
    expect(h.fence.fenceAndClose.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(h.onFatal).mock.invocationCallOrder[0]!);
    expect(h.durable.fail).toHaveBeenCalledWith({
      ...BINDING,
      failureId: FAILURE,
      reason: 'internal_error',
    });
  });

  it('borne un socket qui ne rappelle jamais et le classe ambigu sans retry', async () => {
    const h = harness();
    const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));
    h.timing.fireAll();
    await expect(starting).resolves.toMatchObject({
      status: 'fatal', reason: 'socket_send_ambiguous', closeRequired: true,
    });
    expect(h.socket.sent).toHaveLength(1);
  });

  it('settled attend le start en vol puis redraine les événements précoces', async () => {
    const h = harness();
    const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));
    expect(h.dispatcher.handleWireEvent(created())).toEqual({ status: 'queued' });
    let didSettle = false;
    const settling = h.dispatcher.settled().then((outcome) => {
      didSettle = true;
      return outcome;
    });
    await Promise.resolve();
    expect(didSettle).toBe(false);

    h.socket.flush();
    await expect(starting).resolves.toEqual({ status: 'started', deliveryId: DELIVERY });
    await expect(settling).resolves.toEqual({ status: 'active' });
    expect(h.durable.acceptProviderResponse).toHaveBeenCalledTimes(1);
  });

  it('n’envoie rien sans le CAS authorized courant ou avec un prepared/binding divergent', async () => {
    const noClaim = harness({
      authority: authority({
        claimDispatch: vi.fn(async () => ({ status: 'not_authorized' as const })),
      }),
    });
    await expect(noClaim.dispatcher.start({ prepared: prepared(), binding: BINDING })).resolves
      .toEqual({
        status: 'not_started', reason: 'dispatch_not_authorized', closeRequired: false,
      });
    expect(noClaim.socket.sent).toHaveLength(0);
    expect(noClaim.dispatcher.handleWireEvent(created())).toEqual({ status: 'ignored' });
    await expect(noClaim.dispatcher.markMobileInterruption('tap')).resolves.toEqual({
      status: 'not_active',
    });
    expect(noClaim.durable.cancel).not.toHaveBeenCalled();
    expect(noClaim.durable.fail).not.toHaveBeenCalled();

    const mismatched = harness();
    await expect(mismatched.dispatcher.start({
      prepared: prepared(),
      binding: { ...BINDING, contextRevision: 8 },
    })).resolves.toEqual({
      status: 'not_started', reason: 'invalid_prepared_request', closeRequired: false,
    });
    expect(mismatched.durable.claimDispatch).not.toHaveBeenCalled();

    for (const request of [
      { ...REQUEST, canonicalSpeech: 'Une phrase forgée.' },
      { ...REQUEST, requestNonce: 'forged_request_nonce_1234567890_1234567890' },
    ]) {
      const forged = harness();
      await expect(forged.dispatcher.start({
        prepared: { ...prepared(), request },
        binding: BINDING,
      })).resolves.toEqual({
        status: 'not_started', reason: 'dispatch_not_authorized', closeRequired: false,
      });
      expect(forged.socket.sent).toHaveLength(0);
    }
  });

  it('hard-fence un claim ambigu avant tout octet et terminalise avec le même binding', async () => {
    let releaseClaim!: (outcome: {
      readonly status: 'authorized';
      readonly dispatchClaimId: string;
      readonly state: OpenAiNativeSpeechDeliveryState;
      readonly request: Readonly<typeof REQUEST>;
    }) => void;
    const claimDispatch = vi.fn(() => new Promise<Parameters<typeof releaseClaim>[0]>((resolve) => {
      releaseClaim = resolve;
    }));
    const h = harness({ authority: authority({ claimDispatch }) });
    const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(claimDispatch).toHaveBeenCalledTimes(1));

    h.timing.fireAll();
    await expect(starting).resolves.toEqual({
      status: 'fatal', reason: 'durable_transition_failed', closeRequired: true,
    });
    expect(h.socket.sent).toHaveLength(0);
    expect(h.fence.isClosed()).toBe(true);
    expect(h.durable.fail).toHaveBeenCalledWith({
      ...BINDING,
      failureId: FAILURE,
      reason: 'internal_error',
    });

    releaseClaim({
      status: 'authorized',
      dispatchClaimId: CLAIM,
      state: claimedState(preparedState()),
      request: Object.freeze({ ...REQUEST }),
    });
    await Promise.resolve();
    expect(h.socket.sent).toHaveLength(0);
  });

  it('refuse un capability claim non figé ou divergent avant tout octet provider', async () => {
    for (const claimRequest of [
      { ...REQUEST },
      Object.freeze({ ...REQUEST, canonicalSpeech: 'Une phrase forgée.' }),
    ]) {
      const claimed = harness({
        authority: authority({
          claimDispatch: vi.fn(async () => ({
            status: 'authorized' as const,
            dispatchClaimId: CLAIM,
            state: claimedState(preparedState()),
            request: claimRequest,
          })),
        }),
      });
      await expect(claimed.dispatcher.start({ prepared: prepared(), binding: BINDING })).resolves
        .toEqual({
          status: 'fatal', reason: 'durable_transition_failed', closeRequired: true,
        });
      expect(claimed.socket.sent).toHaveLength(0);
      expect(claimed.fence.isClosed()).toBe(true);
    }
  });

  it('ferme si MARK_REQUESTED ne devient pas durable et ne réduit aucun événement précoce', async () => {
    const h = harness({
      authority: authority({ markRequested: vi.fn(async () => ({ status: 'unavailable' })) }),
    });
    const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));
    expect(h.dispatcher.handleWireEvent(created())).toEqual({ status: 'queued' });
    h.socket.flush();
    await expect(starting).resolves.toEqual({
      status: 'fatal', reason: 'request_commit_failed', closeRequired: true,
    });
    await h.dispatcher.settled();
    expect(h.durable.acceptProviderResponse).not.toHaveBeenCalled();
    expect(h.fence.isClosed()).toBe(true);
  });

  it.each([
    {
      label: 'metadata',
      event: () => created({ metadata: { ...METADATA, bob_context_digest: '9'.repeat(64) } }),
    },
    {
      label: 'outil',
      event: () => JSON.stringify({
        type: 'response.function_call_arguments.delta', response_id: RESPONSE, delta: '{}',
      }),
    },
    {
      label: 'texte',
      event: () => JSON.stringify({
        type: 'response.output_text.delta', response_id: RESPONSE, delta: 'secret',
      }),
    },
  ])('rend $label fatal et exige la fermeture', async ({ event }) => {
    const h = harness();
    await start(h);
    expect(h.dispatcher.handleWireEvent(event())).toMatchObject({
      status: 'fatal', reason: 'protocol_violation', closeRequired: true,
    });
    await h.dispatcher.settled();
    expect(h.onFatal).toHaveBeenCalledTimes(1);
  });

  it('refuse une seconde réponse, un RTP rogue et un transcript non concordant', async () => {
    const overlap = harness();
    await start(overlap);
    expect(overlap.dispatcher.handleWireEvent(created())).toEqual({ status: 'handled' });
    expect(overlap.dispatcher.handleWireEvent(created({ responseId: OTHER_RESPONSE })))
      .toMatchObject({ status: 'fatal', reason: 'protocol_violation' });

    const rogue = harness();
    await start(rogue);
    rogue.dispatcher.handleWireEvent(created());
    expect(rogue.dispatcher.handleWireEvent(audio('response.output_audio.delta', OTHER_RESPONSE)))
      .toMatchObject({ status: 'fatal', reason: 'protocol_violation' });

    const mismatch = harness();
    await start(mismatch);
    mismatch.dispatcher.handleWireEvent(created());
    mismatch.dispatcher.handleWireEvent(audio('response.output_audio.delta'));
    mismatch.dispatcher.handleWireEvent(audio('response.output_audio.done'));
    mismatch.dispatcher.handleWireEvent(transcript(
      'response.output_audio_transcript.done',
      'Une réponse différente.',
    ));
    await mismatch.dispatcher.settled();
    expect(mismatch.onFatal).toHaveBeenCalledWith({
      status: 'fatal', reason: 'speech_mismatch', closeRequired: true,
    });
    expect(mismatch.durable.responseDone).not.toHaveBeenCalled();
  });

  it('persiste l’usage avant de fermer si le provider échoue, et bloque RESPONSE_DONE si usage manque', async () => {
    const providerFailed = harness();
    await start(providerFailed);
    providerFailed.dispatcher.handleWireEvent(created());
    providerFailed.dispatcher.handleWireEvent(done({ status: 'incomplete' }));
    await providerFailed.dispatcher.settled();
    expect(providerFailed.metering.record).toHaveBeenCalledTimes(1);
    expect(providerFailed.metering.record.mock.invocationCallOrder[0])
      .toBeLessThan(providerFailed.durable.fail.mock.invocationCallOrder[0]!);
    expect(providerFailed.onFatal).toHaveBeenCalledWith({
      status: 'fatal', reason: 'provider_failed', closeRequired: true,
    });

    const noUsage = harness({ usage: usage('unavailable') });
    await start(noUsage);
    noUsage.dispatcher.handleWireEvent(created());
    noUsage.dispatcher.handleWireEvent(audio('response.output_audio.delta'));
    noUsage.dispatcher.handleWireEvent(audio('response.output_audio.done'));
    noUsage.dispatcher.handleWireEvent(transcript('response.output_audio_transcript.done'));
    noUsage.dispatcher.handleWireEvent(done());
    await noUsage.dispatcher.settled();
    expect(noUsage.durable.responseDone).not.toHaveBeenCalled();
    expect(noUsage.onFatal).toHaveBeenCalledWith({
      status: 'fatal', reason: 'usage_unavailable', closeRequired: true,
    });
  });

  it('latch la première evidence response.done et refuse une duplicate à usage divergent', async () => {
    const completed = vi.fn();
    const h = harness({ callbacks: { onCompleted: completed } });
    await start(h);
    h.dispatcher.handleWireEvent(created());
    h.dispatcher.handleWireEvent(audio('response.output_audio.delta'));
    h.dispatcher.handleWireEvent(audio('response.output_audio.done'));
    h.dispatcher.handleWireEvent(transcript('response.output_audio_transcript.done'));
    h.dispatcher.handleWireEvent(done());
    await expect(h.dispatcher.settled()).resolves.toEqual({ status: 'active' });

    const divergentUsage = {
      ...providerUsage(),
      total_tokens: 21,
      output_tokens: 9,
      output_token_details: { text_tokens: 0, audio_tokens: 9 },
    };
    expect(h.dispatcher.handleWireEvent(done({ usage: divergentUsage }))).toMatchObject({
      status: 'fatal', reason: 'protocol_violation', closeRequired: true,
    });
    expect(h.dispatcher.handleWireEvent(stopped())).toMatchObject({ status: 'fatal' });
    await h.dispatcher.settled();
    expect(h.metering.record).toHaveBeenCalledTimes(1);
    expect(h.durable.responseDone).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    expect(h.fence.isClosed()).toBe(true);
  });

  it('ne perd pas l’usage si une interruption retire un response.done déjà admis mais non réduit', async () => {
    const h = harness();
    await start(h);
    h.dispatcher.handleWireEvent(created());
    h.dispatcher.handleWireEvent(audio('response.output_audio.delta'));
    h.dispatcher.handleWireEvent(audio('response.output_audio.done'));
    h.dispatcher.handleWireEvent(transcript('response.output_audio_transcript.done'));
    h.dispatcher.handleWireEvent(done());
    const interruption = h.dispatcher.markMobileInterruption('tap');

    await expect(interruption).resolves.toEqual({ status: 'cancelled', source: 'tap' });
    await expect(h.dispatcher.settled()).resolves.toEqual({ status: 'cancelled' });
    expect(h.metering.record).toHaveBeenCalledTimes(1);
    expect(h.durable.responseDone).not.toHaveBeenCalled();
  });

  it('mesure la première preuve done même si une duplicate divergente devient fatale avant réduction', async () => {
    const h = harness();
    await start(h);
    h.dispatcher.handleWireEvent(created());
    h.dispatcher.handleWireEvent(audio('response.output_audio.delta'));
    h.dispatcher.handleWireEvent(audio('response.output_audio.done'));
    h.dispatcher.handleWireEvent(transcript('response.output_audio_transcript.done'));
    h.dispatcher.handleWireEvent(done());
    const divergentUsage = {
      ...providerUsage(),
      total_tokens: 21,
      output_tokens: 9,
      output_token_details: { text_tokens: 0, audio_tokens: 9 },
    };
    expect(h.dispatcher.handleWireEvent(done({ usage: divergentUsage }))).toMatchObject({
      status: 'fatal', reason: 'protocol_violation', closeRequired: true,
    });

    await expect(h.dispatcher.settled()).resolves.toMatchObject({
      status: 'fatal', reason: 'protocol_violation', closeRequired: true,
    });
    expect(h.metering.record).toHaveBeenCalledTimes(1);
    expect(h.durable.responseDone).not.toHaveBeenCalled();
  });

  it('borne les essais usage malgré une rafale de response.done pendant une panne', async () => {
    const record = vi.fn(async () => ({ status: 'unavailable' as const }));
    const metering = {
      port: { record } satisfies OpenAiNativeResponseUsagePort,
      record,
    };
    const h = harness({ usage: metering });
    await start(h);
    h.dispatcher.handleWireEvent(created());
    h.dispatcher.handleWireEvent(audio('response.output_audio.delta'));
    h.dispatcher.handleWireEvent(audio('response.output_audio.done'));
    h.dispatcher.handleWireEvent(transcript('response.output_audio_transcript.done'));
    for (let index = 0; index < 100; index += 1) {
      expect(h.dispatcher.handleWireEvent(done())).toEqual({ status: 'handled' });
    }

    await expect(h.dispatcher.settled()).resolves.toMatchObject({
      status: 'fatal', reason: 'usage_unavailable', closeRequired: true,
    });
    // Une tentative initiale + une réconciliation explicite, jamais une tentative par duplicate.
    expect(record).toHaveBeenCalledTimes(2);
    await h.dispatcher.settled();
    expect(record).toHaveBeenCalledTimes(3);
    await h.dispatcher.settled();
    await h.dispatcher.settled();
    expect(record).toHaveBeenCalledTimes(4);
  });

  it('n’amplifie pas non plus les batches FAIL quand usage et autorité sont indisponibles', async () => {
    const record = vi.fn(async () => ({ status: 'unavailable' as const }));
    const fail = vi.fn(async () => ({ status: 'unavailable' as const }));
    const h = harness({
      authority: authority({ fail }),
      usage: {
        port: { record } satisfies OpenAiNativeResponseUsagePort,
        record,
      },
    });
    await start(h);
    h.dispatcher.handleWireEvent(created());
    h.dispatcher.handleWireEvent(audio('response.output_audio.delta'));
    h.dispatcher.handleWireEvent(audio('response.output_audio.done'));
    h.dispatcher.handleWireEvent(transcript('response.output_audio_transcript.done'));
    for (let index = 0; index < 100; index += 1) {
      expect(h.dispatcher.handleWireEvent(done())).toEqual({ status: 'handled' });
    }

    await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    expect(fail).toHaveBeenCalledTimes(3);
    await expect(h.dispatcher.settled()).resolves.toMatchObject({
      status: 'fatal', reason: 'usage_unavailable', closeRequired: true,
    });
    // Un seul nouveau batch explicite de trois lors de la réconciliation.
    expect(fail).toHaveBeenCalledTimes(6);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('borne strictement la file avant MARK_REQUESTED', async () => {
    const h = harness();
    const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));
    for (let index = 0; index < OPENAI_NATIVE_MAX_PRE_REQUEST_EVENTS; index += 1) {
      expect(h.dispatcher.handleWireEvent(created())).toEqual({ status: 'queued' });
    }
    expect(h.dispatcher.handleWireEvent(created())).toMatchObject({
      status: 'fatal', reason: 'event_queue_overflow', closeRequired: true,
    });
    h.socket.flush();
    await expect(starting).resolves.toMatchObject({
      status: 'fatal', reason: 'event_queue_overflow', closeRequired: true,
    });
    expect(h.socket.sent).toHaveLength(1);
  });

  it('borne aussi la file active quand une transition durable ne répond plus', async () => {
    let releaseAccept!: (outcome: ReturnType<typeof applied>) => void;
    const acceptProviderResponse = vi.fn(() => new Promise<ReturnType<typeof applied>>((resolve) => {
      releaseAccept = resolve;
    }));
    const h = harness({ authority: authority({ acceptProviderResponse }) });
    await start(h);
    expect(h.dispatcher.handleWireEvent(created())).toEqual({ status: 'handled' });
    await vi.waitFor(() => expect(acceptProviderResponse).toHaveBeenCalledTimes(1));

    for (let index = 1; index < OPENAI_NATIVE_MAX_PENDING_EVENTS; index += 1) {
      expect(h.dispatcher.handleWireEvent(stopped())).toEqual({ status: 'handled' });
    }
    expect(h.dispatcher.handleWireEvent(stopped())).toEqual({
      status: 'fatal', reason: 'event_queue_overflow', closeRequired: true,
    });
    expect(h.fence.isClosed()).toBe(true);

    releaseAccept(applied());
    await expect(h.dispatcher.settled()).resolves.toEqual({
      status: 'fatal', reason: 'event_queue_overflow', closeRequired: true,
    });
  });

  it('réessaie une preuve fatale avec le même id après indisponibilité ou réponse perdue', async () => {
    const failureId = vi.fn(() => FAILURE);
    const fail = vi.fn()
      .mockResolvedValueOnce({ status: 'unavailable' as const })
      .mockRejectedValueOnce(new Error('response_lost_after_commit'))
      .mockResolvedValueOnce({ status: 'idempotent' as const, state: preparedState() });
    const h = harness({
      authority: authority({ fail }),
      entropy: { cancellationId: () => CANCELLATION, failureId },
    });
    const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));
    h.socket.flush(new Error('ambiguous'));

    await expect(starting).resolves.toEqual({
      status: 'fatal', reason: 'socket_send_ambiguous', closeRequired: true,
    });
    expect(failureId).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledTimes(3);
    expect(fail.mock.calls.map(([input]) => input.failureId)).toEqual([
      FAILURE,
      FAILURE,
      FAILURE,
    ]);
    expect(h.fence.isClosed()).toBe(true);
  });

  it('borne à trois les retries fatals indisponibles sans masquer la fermeture requise', async () => {
    const failureId = vi.fn(() => FAILURE);
    const fail = vi.fn(async (_input: { readonly failureId: string }) => ({
      status: 'unavailable' as const,
    }));
    const h = harness({
      authority: authority({ fail }),
      entropy: { cancellationId: () => CANCELLATION, failureId },
    });
    const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));
    h.socket.flush(new Error('ambiguous'));

    await expect(starting).resolves.toEqual({
      status: 'fatal', reason: 'socket_send_ambiguous', closeRequired: true,
    });
    expect(failureId).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledTimes(3);
    expect(new Set(fail.mock.calls.map(([input]) => input.failureId))).toEqual(new Set([FAILURE]));
    expect(h.fence.isClosed()).toBe(true);
    expect(h.onFatal).toHaveBeenCalledTimes(1);
  });

  it('réconcilie via settled une preuve fatale après le premier lot de retries épuisé', async () => {
    const failureId = vi.fn(() => FAILURE);
    const fail = vi.fn()
      .mockResolvedValueOnce({ status: 'unavailable' as const })
      .mockResolvedValueOnce({ status: 'unavailable' as const })
      .mockResolvedValueOnce({ status: 'unavailable' as const })
      .mockResolvedValueOnce({ status: 'applied' as const, state: preparedState() });
    const h = harness({
      authority: authority({ fail }),
      entropy: { cancellationId: () => CANCELLATION, failureId },
    });
    const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));
    h.socket.flush(new Error('ambiguous'));
    await expect(starting).resolves.toMatchObject({
      status: 'fatal', reason: 'socket_send_ambiguous', closeRequired: true,
    });
    expect(fail).toHaveBeenCalledTimes(3);

    await expect(h.dispatcher.settled()).resolves.toMatchObject({
      status: 'fatal', reason: 'socket_send_ambiguous', closeRequired: true,
    });
    expect(fail).toHaveBeenCalledTimes(4);
    expect(new Set(fail.mock.calls.map(([input]) => input.failureId))).toEqual(new Set([FAILURE]));
    expect(failureId).toHaveBeenCalledTimes(1);
  });

  it('laisse le mobile seul envoyer cancel+clear et rend les barge-in répétés durables une fois', async () => {
    const cancelled = vi.fn();
    const h = harness({ callbacks: { onCancelled: cancelled } });
    await start(h);
    h.dispatcher.handleWireEvent(created());
    await h.dispatcher.settled();
    const first = h.dispatcher.markMobileInterruption('user_speech');
    const repeated = h.dispatcher.markMobileInterruption('user_speech');
    expect(repeated).toBe(first);
    await expect(first).resolves.toEqual({ status: 'cancelled', source: 'user_speech' });

    expect(h.socket.sent).toHaveLength(1);
    expect(h.durable.cancel).toHaveBeenCalledTimes(1);
    expect(h.durable.cancel).toHaveBeenCalledWith({
      ...BINDING,
      cancellationId: CANCELLATION,
      reason: 'barge_in',
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('laisse révoquer completed tant que l’ACK acoustique séparé n’a pas livré la parole', async () => {
    const h = harness();
    await start(h);
    successfulEvents(h.dispatcher, 'done_first');
    await expect(h.dispatcher.settled()).resolves.toEqual({ status: 'completed' });

    await expect(h.dispatcher.markMobileInterruption('navigation')).resolves.toEqual({
      status: 'cancelled', source: 'navigation',
    });
    expect(h.durable.cancel).toHaveBeenCalledWith({
      ...BINDING,
      cancellationId: CANCELLATION,
      reason: 'user_cancel',
    });
    await expect(h.dispatcher.settled()).resolves.toEqual({ status: 'cancelled' });
  });

  it('converge en FAIL si un événement rogue gagne pendant un CANCEL encore suspendu', async () => {
    let releaseCancel!: (outcome: { readonly status: 'unavailable' }) => void;
    const cancel = vi.fn(() => new Promise<{ readonly status: 'unavailable' }>((resolve) => {
      releaseCancel = resolve;
    }));
    const h = harness({ authority: authority({ cancel }) });
    await start(h);
    h.dispatcher.handleWireEvent(created());
    await h.dispatcher.settled();

    const cancellation = h.dispatcher.markMobileInterruption('tap');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(h.dispatcher.handleWireEvent(audio('response.output_audio.delta'))).toMatchObject({
      status: 'fatal', reason: 'protocol_violation', closeRequired: true,
    });
    await vi.waitFor(() => expect(h.durable.fail).toHaveBeenCalledTimes(1));
    releaseCancel({ status: 'unavailable' });

    await expect(cancellation).resolves.toMatchObject({
      status: 'fatal', reason: 'protocol_violation', closeRequired: true,
    });
    await expect(h.dispatcher.settled()).resolves.toMatchObject({
      status: 'fatal', reason: 'protocol_violation', closeRequired: true,
    });
    expect(h.fence.isClosed()).toBe(true);
  });

  it('terminalise en FAIL quand CANCEL seul reste indisponible', async () => {
    const h = harness({
      authority: authority({ cancel: vi.fn(async () => ({ status: 'unavailable' as const })) }),
    });
    await start(h);
    await expect(h.dispatcher.markMobileInterruption('navigation')).resolves.toEqual({
      status: 'fatal', reason: 'cancellation_failed', closeRequired: true,
    });
    expect(h.durable.fail).toHaveBeenCalledWith({
      ...BINDING,
      failureId: FAILURE,
      reason: 'internal_error',
    });
  });

  it('met en quarantaine transcript/terminaux tardifs, mais ferme sur audio tardif ou réponse rogue', async () => {
    const h = harness();
    await start(h);
    h.dispatcher.handleWireEvent(created());
    await h.dispatcher.settled();
    await h.dispatcher.markMobileInterruption('tap');

    expect(h.dispatcher.handleWireEvent(transcript(
      'response.output_audio_transcript.delta',
      'fragment interrompu',
    ))).toEqual({ status: 'handled' });
    expect(h.dispatcher.handleWireEvent(transcript(
      'response.output_audio_transcript.done',
      'fragment interrompu',
    ))).toEqual({ status: 'handled' });
    expect(h.dispatcher.handleWireEvent(stopped())).toEqual({ status: 'handled' });
    expect(h.dispatcher.handleWireEvent(done({ status: 'cancelled' }))).toEqual({ status: 'handled' });
    await h.dispatcher.settled();
    expect(h.metering.record).toHaveBeenCalledTimes(1);

    expect(h.dispatcher.handleWireEvent(audio('response.output_audio.delta'))).toMatchObject({
      status: 'fatal', reason: 'protocol_violation', closeRequired: true,
    });

    const rogue = harness();
    await start(rogue);
    rogue.dispatcher.handleWireEvent(created());
    await rogue.dispatcher.settled();
    await rogue.dispatcher.markMobileInterruption('navigation');
    expect(rogue.dispatcher.handleWireEvent(done({
      status: 'cancelled', responseId: OTHER_RESPONSE,
    }))).toMatchObject({ status: 'fatal', reason: 'protocol_violation' });
  });

  it('borne la quarantaine et conserve l’identité exacte item/index/content', async () => {
    const rogueItem = harness();
    await start(rogueItem);
    rogueItem.dispatcher.handleWireEvent(created());
    rogueItem.dispatcher.handleWireEvent(audio('response.output_audio.delta'));
    await rogueItem.dispatcher.settled();
    await rogueItem.dispatcher.markMobileInterruption('tap');
    expect(rogueItem.dispatcher.handleWireEvent(JSON.stringify({
      type: 'response.output_audio_transcript.done',
      response_id: RESPONSE,
      item_id: 'item_rogue_2',
      output_index: 0,
      content_index: 0,
      transcript: SPEECH,
    }))).toMatchObject({ status: 'fatal', reason: 'protocol_violation' });

    const rogueIndex = harness();
    await start(rogueIndex);
    rogueIndex.dispatcher.handleWireEvent(created());
    await rogueIndex.dispatcher.settled();
    await rogueIndex.dispatcher.markMobileInterruption('tap');
    expect(rogueIndex.dispatcher.handleWireEvent(JSON.stringify({
      type: 'response.output_audio_transcript.done',
      response_id: RESPONSE,
      item_id: ITEM,
      output_index: 1,
      content_index: 0,
      transcript: SPEECH,
    }))).toMatchObject({ status: 'fatal', reason: 'protocol_violation' });

    const overflow = harness();
    await start(overflow);
    overflow.dispatcher.handleWireEvent(created());
    await overflow.dispatcher.settled();
    await overflow.dispatcher.markMobileInterruption('tap');
    for (let index = 0; index < OPENAI_NATIVE_RESPONSE_LIMITS.maxEventsPerResponse - 1; index += 1) {
      expect(overflow.dispatcher.handleWireEvent(stopped())).toEqual({ status: 'handled' });
    }
    expect(overflow.dispatcher.handleWireEvent(stopped())).toMatchObject({
      status: 'fatal', reason: 'protocol_violation', closeRequired: true,
    });
  });

  it('persiste l’usage d’un completed tardif avant de fermer pour speech mismatch', async () => {
    const h = harness();
    await start(h);
    h.dispatcher.handleWireEvent(created());
    await h.dispatcher.settled();
    await h.dispatcher.markMobileInterruption('tap');

    expect(h.dispatcher.handleWireEvent(done({
      transcript: 'Une phrase différente.',
    }))).toEqual({ status: 'handled' });
    await expect(h.dispatcher.settled()).resolves.toEqual({
      status: 'fatal', reason: 'speech_mismatch', closeRequired: true,
    });
    expect(h.metering.record).toHaveBeenCalledTimes(1);
    expect(h.metering.record.mock.invocationCallOrder[0])
      .toBeLessThan(h.fence.fenceAndClose.mock.invocationCallOrder[0]!);
  });

  it('délègue cancel+clear au caller serveur et ferme sur résultat ambigu ou timeout', async () => {
    const h = harness();
    await start(h);
    h.dispatcher.handleWireEvent(created());
    await h.dispatcher.settled();
    const send = vi.fn(async () => ({ status: 'sent' as const }));
    await expect(h.dispatcher.interruptForServerOrigin('context_changed', send)).resolves.toEqual({
      status: 'cancelled', source: 'context_changed',
    });
    expect(send).toHaveBeenCalledWith({
      responseId: RESPONSE,
      events: [
        { type: 'response.cancel', response_id: RESPONSE },
        { type: 'output_audio_buffer.clear' },
      ],
      closeIfAmbiguous: true,
    });
    expect(h.socket.sent).toHaveLength(1);

    const timeout = harness();
    await start(timeout);
    timeout.dispatcher.handleWireEvent(created());
    await timeout.dispatcher.settled();
    const pending = timeout.dispatcher.interruptForServerOrigin(
      'session_end',
      () => new Promise(() => undefined),
    );
    await vi.waitFor(() => expect(timeout.durable.cancel).not.toHaveBeenCalled());
    timeout.timing.fireAll();
    await expect(pending).resolves.toEqual({
      status: 'fatal', reason: 'server_interrupt_ambiguous', closeRequired: true,
    });
    expect(timeout.durable.cancel).toHaveBeenCalledTimes(1);

    const invalid = harness();
    await start(invalid);
    invalid.dispatcher.handleWireEvent(created());
    await invalid.dispatcher.settled();
    await expect(invalid.dispatcher.interruptForServerOrigin(
      'session_end',
      vi.fn(async () => ({ status: 'unexpected' } as never)),
    )).resolves.toEqual({
      status: 'fatal', reason: 'server_interrupt_ambiguous', closeRequired: true,
    });
    expect(invalid.fence.isClosed()).toBe(true);
  });

  it('ferme sans prétendre annuler si response.create est parti mais responseId reste inconnu', async () => {
    const h = harness();
    await start(h);
    const send = vi.fn(async () => ({ status: 'sent' as const }));

    await expect(h.dispatcher.interruptForServerOrigin('superseded', send)).resolves.toEqual({
      status: 'fatal', reason: 'server_interrupt_ambiguous', closeRequired: true,
    });
    expect(send).not.toHaveBeenCalled();
    expect(h.durable.cancel).toHaveBeenCalledTimes(1);
    expect(h.fence.isClosed()).toBe(true);
  });

  it('garde tous les callbacks sous garde et converge en fatal explicite', async () => {
    const fatalThrow = harness({ callbacks: { onFatal: () => { throw new Error('ui gone'); } } });
    const startFatal = fatalThrow.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(fatalThrow.socket.sent).toHaveLength(1));
    fatalThrow.socket.flush(new Error('ambiguous'));
    await expect(startFatal).resolves.toEqual({
      status: 'fatal', reason: 'socket_send_ambiguous', closeRequired: true,
    });
    expect(fatalThrow.fence.isClosed()).toBe(true);

    const completedThrow = harness({
      callbacks: { onCompleted: () => { throw new Error('ui gone'); } },
    });
    await start(completedThrow);
    successfulEvents(completedThrow.dispatcher, 'done_first');
    await expect(completedThrow.dispatcher.settled()).resolves.toEqual({
      status: 'fatal', reason: 'internal_error', closeRequired: true,
    });

    const cancelledThrow = harness({
      callbacks: { onCancelled: () => { throw new Error('ui gone'); } },
    });
    await start(cancelledThrow);
    await expect(cancelledThrow.dispatcher.markMobileInterruption('tap')).resolves.toEqual({
      status: 'fatal', reason: 'internal_error', closeRequired: true,
    });

    const streamingThrow = harness({
      callbacks: { onStreaming: () => { throw new Error('ui gone'); } },
    });
    await start(streamingThrow);
    streamingThrow.dispatcher.handleWireEvent(created());
    streamingThrow.dispatcher.handleWireEvent(audio('response.output_audio.delta'));
    await expect(streamingThrow.dispatcher.settled()).resolves.toEqual({
      status: 'fatal', reason: 'internal_error', closeRequired: true,
    });

    const entropyThrow = harness({
      entropy: {
        cancellationId: () => { throw new Error('entropy unavailable'); },
        failureId: () => FAILURE,
      },
    });
    await start(entropyThrow);
    await expect(entropyThrow.dispatcher.markMobileInterruption('tap')).resolves.toEqual({
      status: 'fatal', reason: 'internal_error', closeRequired: true,
    });
  });

  it.each([
    ['failed', 'applied'],
    ['throw', 'already_closed'],
  ] as const)('escalade un fence primaire %s via la terminaison indépendante %s', async (
    primary,
    emergency,
  ) => {
    const fence = sessionFence(primary, emergency);
    const h = harness({ fence });
    const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));
    h.socket.flush(new Error('ambiguous'));
    await expect(starting).resolves.toEqual({
      status: 'fatal', reason: 'socket_send_ambiguous', closeRequired: true,
    });
    expect(fence.fenceAndClose).toHaveBeenCalledTimes(1);
    expect(fence.emergencyRevokeAndTerminate).toHaveBeenCalledTimes(1);
    expect(fence.isClosed()).toBe(true);
  });

  it.each([
    ['failed', 'failed'],
    ['throw', 'throw'],
  ] as const)('expose explicitement l’échec total des fences %s/%s', async (
    primary,
    emergency,
  ) => {
    const fence = sessionFence(primary, emergency);
    const h = harness({ fence });
    const starting = h.dispatcher.start({ prepared: prepared(), binding: BINDING });
    await vi.waitFor(() => expect(h.socket.sent).toHaveLength(1));
    h.socket.flush(new Error('ambiguous'));
    await expect(starting).resolves.toEqual({
      status: 'fatal',
      reason: 'session_fence_failed',
      cause: 'socket_send_ambiguous',
      closeRequired: true,
    });
    expect(fence.isClosed()).toBe(false);
  });

  it('une interruption gagnant pendant une transition empêche streaming et callbacks tardifs', async () => {
    const acceptGate: { resolve: (() => void) | null } = { resolve: null };
    const acceptProviderResponse = vi.fn(() => new Promise<ReturnType<typeof applied>>((resolve) => {
      acceptGate.resolve = () => resolve(applied());
    }));
    const streaming = vi.fn();
    const h = harness({
      authority: authority({ acceptProviderResponse }),
      callbacks: { onStreaming: streaming },
    });
    await start(h);
    h.dispatcher.handleWireEvent(created());
    await vi.waitFor(() => expect(acceptProviderResponse).toHaveBeenCalledTimes(1));

    const cancellation = h.dispatcher.markMobileInterruption('user_speech');
    expect(acceptGate.resolve).not.toBeNull();
    acceptGate.resolve?.();
    await expect(cancellation).resolves.toEqual({ status: 'cancelled', source: 'user_speech' });
    await h.dispatcher.settled();
    expect(h.durable.startStreaming).not.toHaveBeenCalled();
    expect(streaming).not.toHaveBeenCalled();
  });

  it('settled attend une annulation démarrée par un callback pendant son drain final', async () => {
    const runtime: {
      dispatcher: OpenAiNativeResponseDispatcher | null;
      cancellation: Promise<unknown> | null;
    } = { dispatcher: null, cancellation: null };
    const completed = vi.fn(() => {
      runtime.cancellation = runtime.dispatcher?.markMobileInterruption('navigation') ?? null;
    });
    const h = harness({ callbacks: { onCompleted: completed } });
    runtime.dispatcher = h.dispatcher;
    await start(h);
    successfulEvents(h.dispatcher, 'done_first');

    await expect(h.dispatcher.settled()).resolves.toEqual({ status: 'cancelled' });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(runtime.cancellation).not.toBeNull();
    await expect(runtime.cancellation).resolves.toEqual({
      status: 'cancelled', source: 'navigation',
    });
    expect(h.durable.cancel).toHaveBeenCalledTimes(1);
  });
});
