import { describe, expect, it, vi } from 'vitest';
import {
  prepareRealtimeContext,
  type PreparedRealtimeContext,
  type RealtimeAdmissionPort,
} from './realtime-admission';
import {
  realtimeAgentContextVersion,
  type RealtimeAgentTurnOutcome,
  type RealtimeAgentTurnPort,
} from './realtime-agent-turn';
import {
  MistralRealtimeAgentSink,
  MistralRealtimeAgentSinkError,
} from './mistral-realtime-agent-sink';
import type { MistralRealtimeTranscriptionSink } from './mistral-realtime-gateway';
import type {
  RealtimeSidebandOwnerIdentity,
  RealtimeSidebandOwnerPort,
} from './realtime-sideband-owner';
import type { RealtimeSpeechPublisher } from './realtime-speech-publisher';
import type { RealtimeVoiceUsageWriterPort } from './realtime-voice-usage';
import type { RealtimeDurableControlAuthority } from './realtime-control';
import type { RealtimeSpeechDeliveryRepositoryPort } from './realtime-speech-delivery.repository';

const REDEMPTION_ID = '10000000-0000-4000-8000-000000000001';
const SESSION_ID = '20000000-0000-4000-8000-000000000002';
const BRAIN_TURN_ID = '30000000-0000-4000-8000-000000000003';
const ARTIFACT_ID = '40000000-0000-4000-8000-000000000004';
const USAGE_EVENT_ID = '50000000-0000-4000-8000-000000000005';
const CANCELLATION_ID = '60000000-0000-4000-8000-000000000006';
const SUBJECT_HASH = 'a'.repeat(64);
const OCCURRED_AT = '2026-07-14T12:00:00.000Z';
const CONTEXT = {
  screen: { name: '/facture/detail', instanceId: 'invoice-1' },
  entities: [{ type: 'invoice' as const, id: 'invoice-1', label: 'Facture F-2026-014' }],
  capabilities: ['screen.read' as const, 'invoice.read' as const],
};
function preparedFixture(): PreparedRealtimeContext {
  const prepared = prepareRealtimeContext({ version: 1, revision: 7, context: CONTEXT });
  if (!prepared) throw new Error('fixture_context_invalid');
  return prepared;
}

const PREPARED = preparedFixture();
const AGENT_CONTEXT_VERSION = realtimeAgentContextVersion(PREPARED.snapshot);

type SinkInput = Parameters<MistralRealtimeTranscriptionSink['publish']>[0];
type FinalSinkInput = Extract<SinkInput, { readonly event: { readonly type: 'transcript_final' } }>;
type SpeechPublish = RealtimeSpeechPublisher['publish'];

function finalInput(overrides: Partial<FinalSinkInput> = {}): FinalSinkInput {
  return {
    redemptionId: REDEMPTION_ID,
    companyId: 'company-1',
    userId: 'user-1',
    subjectHash: SUBJECT_HASH,
    subjectKeyVersion: 3,
    plan: 'pro',
    sessionId: SESSION_ID,
    contextRevision: 7,
    contextDigest: PREPARED.digest,
    event: {
      type: 'transcript_final',
      text: '  Résume\n cette facture.  ',
      language: 'fr',
      usage: { inputAudioSeconds: 2, totalTokens: 9 },
    },
    occurredAt: OCCURRED_AT,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function nonFinalInput(
  event: Exclude<SinkInput['event'], { readonly type: 'transcript_final' }>,
): SinkInput {
  const { event: _event, occurredAt: _occurredAt, ...identity } = finalInput();
  return { ...identity, event };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition_not_reached');
}

function readyOutcome(): RealtimeAgentTurnOutcome {
  return {
    status: 'ready',
    turnId: BRAIN_TURN_ID,
    canonicalSpeech: 'Cette facture reste à encaisser.',
    kind: 'answer',
    contextVersion: AGENT_CONTEXT_VERSION,
  };
}

function harness(overrides: {
  readonly snapshot?: typeof PREPARED.snapshot;
  readonly currentContexts?: Array<{ revision: number; digest: string }>;
  readonly run?: RealtimeAgentTurnPort['run'];
  readonly publish?: SpeechPublish;
  readonly usage?: RealtimeVoiceUsageWriterPort['record'];
  readonly issueControl?: RealtimeDurableControlAuthority['issue'];
  readonly cancel?: RealtimeSpeechDeliveryRepositoryPort['cancel'];
} = {}) {
  let owner: RealtimeSidebandOwnerIdentity | null = null;
  const contexts = [...(overrides.currentContexts ?? [{ revision: 7, digest: PREPARED.digest }])];
  const latestContext = (): { revision: number; digest: string } => (
    contexts.length > 1 ? contexts.shift()! : contexts[0]!
  );
  const acquire = vi.fn<RealtimeSidebandOwnerPort['acquire']>().mockImplementation(async (request) => {
    owner = {
      companyId: request.companyId,
      subjectHash: SUBJECT_HASH,
      sessionId: request.sessionId,
      ownerInstanceHash: request.ownerInstanceHash,
      ownerTokenHash: request.candidateOwnerTokenHash,
      ownerEpoch: 1,
    };
    return {
      status: 'acquired',
      owner,
      currentContext: latestContext(),
      leaseExpiresAt: '2026-07-14T13:00:00.000Z',
    };
  });
  const applyContext = vi.fn<RealtimeSidebandOwnerPort['applyContext']>()
    .mockResolvedValue({ status: 'applied' });
  const readCurrentContext = vi.fn<RealtimeSidebandOwnerPort['readCurrentContext']>()
    .mockImplementation(async () => ({ status: 'current', context: latestContext() }));
  const release = vi.fn<RealtimeSidebandOwnerPort['release']>()
    .mockResolvedValue({ status: 'released' });
  const owners: RealtimeSidebandOwnerPort = {
    acquire,
    applyContext,
    readCurrentContext,
    release,
    renew: vi.fn<RealtimeSidebandOwnerPort['renew']>().mockResolvedValue({ status: 'renewed' }),
  };
  const readContext = vi.fn<RealtimeAdmissionPort['readContext']>().mockResolvedValue({
    ok: true,
    snapshot: overrides.snapshot ?? PREPARED.snapshot,
  });
  const run = vi.fn<RealtimeAgentTurnPort['run']>().mockImplementation(
    overrides.run ?? (async () => readyOutcome()),
  );
  const publish = vi.fn<SpeechPublish>().mockImplementation(
    overrides.publish ?? (async () => ({ status: 'ready', artifactId: ARTIFACT_ID, sequence: 1 })),
  );
  const recordUsage = vi.fn<RealtimeVoiceUsageWriterPort['record']>().mockImplementation(
    overrides.usage ?? (async () => ({ status: 'recorded', eventId: USAGE_EVENT_ID })),
  );
  const issueControl = vi.fn<RealtimeDurableControlAuthority['issue']>().mockImplementation(
    overrides.issueControl ?? (async () => ({ status: 'not_required' })),
  );
  const cancel = vi.fn<RealtimeSpeechDeliveryRepositoryPort['cancel']>().mockImplementation(
    overrides.cancel ?? (async () => ({ status: 'cancelled', idempotent: false })),
  );
  const sink = new MistralRealtimeAgentSink({
    admission: { readContext },
    owners,
    agentTurns: { run },
    speech: { publish },
    usage: { record: recordUsage },
    controls: { issue: issueControl },
    cancellation: { cancel },
    entropy: {
      ownerInstanceToken: () => 'instance-token-with-at-least-thirty-two-characters',
      ownerToken: () => 'redemption-owner-token-with-at-least-thirty-two-characters',
      cancellationId: () => CANCELLATION_ID,
    },
  });
  return {
    sink,
    owners,
    acquire,
    applyContext,
    readCurrentContext,
    readContext,
    run,
    publish,
    recordUsage,
    issueControl,
    cancel,
    release,
    get owner(): RealtimeSidebandOwnerIdentity {
      if (!owner) throw new Error('owner_not_acquired');
      return owner;
    },
  };
}

describe('Bob Live Mistral — coordinateur transcript final vers parole auditée', () => {
  it('ignore strictement les deltas et segments, sans lire identité, contexte ni cerveau', async () => {
    const h = harness();
    await h.sink.publish(nonFinalInput({ type: 'transcript_delta', text: 'Rés' }));
    await h.sink.publish(nonFinalInput({
      type: 'transcript_segment',
      text: 'Résume cette facture',
      startSeconds: 0,
      endSeconds: 1,
      speakerId: null,
    }));

    expect(h.recordUsage).not.toHaveBeenCalled();
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.readContext).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('relaie l’identité serveur exacte, clôt les deux digests et conserve l’owner après ready', async () => {
    const h = harness();
    await h.sink.publish(finalInput());

    expect(h.recordUsage).toHaveBeenNthCalledWith(1, {
      companyId: 'company-1',
      subjectHash: SUBJECT_HASH,
      subjectKeyVersion: 3,
      sessionId: SESSION_ID,
      turnId: REDEMPTION_ID,
      plan: 'pro',
      kind: 'stt_seconds',
      source: 'mistral.voxtral.realtime.stt',
      amount: 2,
      dedupeScope: `mistral-transcript-final:${REDEMPTION_ID}`,
      occurredAt: OCCURRED_AT,
    });
    expect(h.recordUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'realtime_tokens_in',
      amount: 9,
      occurredAt: OCCURRED_AT,
    }));
    expect(JSON.stringify(h.recordUsage.mock.calls)).not.toContain('Résume');
    expect(h.recordUsage.mock.invocationCallOrder[1]).toBeLessThan(h.acquire.mock.invocationCallOrder[0]!);
    expect(h.acquire).toHaveBeenCalledWith({
      companyId: 'company-1',
      sessionId: SESSION_ID,
      ownerInstanceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      candidateOwnerTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      leaseSeconds: 300,
    });
    expect(h.applyContext).toHaveBeenCalledWith(h.owner, {
      revision: 7,
      digest: PREPARED.digest,
    });
    expect(h.readContext).toHaveBeenCalledWith({
      companyId: 'company-1',
      subjectHash: SUBJECT_HASH,
      sessionId: SESSION_ID,
    });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      companyId: 'company-1',
      transcript: 'Résume cette facture.',
      history: [],
      context: CONTEXT,
      signal: expect.any(AbortSignal),
      contextFence: expect.objectContaining({ expected: AGENT_CONTEXT_VERSION }),
    }));
    const turn = h.run.mock.calls[0]?.[0];
    if (!turn) throw new Error('turn_not_observed');
    await expect(turn.contextFence.revalidate(turn.signal)).resolves.toEqual(AGENT_CONTEXT_VERSION);

    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      subjectHash: SUBJECT_HASH,
      sessionId: SESSION_ID,
      // Le turn aléatoire du cerveau ne devient jamais l’idempotency key acoustique.
      turnId: REDEMPTION_ID,
      segmentIndex: 0,
      canonicalSpeech: 'Cette facture reste à encaisser.',
      contextRevision: 7,
      contextDigest: PREPARED.digest,
      sidebandOwnerTokenHash: h.owner.ownerTokenHash,
      abortReason: 'session_end',
    }));
    const speech = h.publish.mock.calls[0]?.[0];
    if (!speech) throw new Error('speech_not_observed');
    await expect(speech.revalidateContext(speech.signal)).resolves.toEqual({
      contextRevision: 7,
      contextDigest: PREPARED.digest,
    });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.issueControl).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      sessionId: SESSION_ID,
      turnId: REDEMPTION_ID,
      artifactId: ARTIFACT_ID,
      sidebandOwnerEpoch: 1,
      sidebandOwnerTokenHash: h.owner.ownerTokenHash,
    }));
  });

  it('rejette un snapshot durable stale avant le cerveau et libère uniquement cet owner sans artefact', async () => {
    const stale = prepareRealtimeContext({
      version: 1,
      revision: 8,
      context: { ...CONTEXT, screen: { name: '/devis/new', instanceId: 'quote-new-1' } },
    });
    if (!stale) throw new Error('stale_fixture_invalid');
    const h = harness({ snapshot: stale.snapshot });

    await expect(h.sink.publish(finalInput())).rejects.toMatchObject({ code: 'context_drift' });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('coalesce les transcript_final concurrents et garde le succès idempotent par redemptionId', async () => {
    const pending = deferred<RealtimeAgentTurnOutcome>();
    const h = harness({ run: async () => pending.promise });
    const first = h.sink.publish(finalInput());
    await waitFor(() => h.run.mock.calls.length === 1);
    const duplicate = h.sink.publish(finalInput());
    expect(duplicate).toBe(first);
    pending.resolve(readyOutcome());
    await Promise.all([first, duplicate]);
    await h.sink.publish(finalInput());

    expect(h.acquire).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.recordUsage).toHaveBeenCalledTimes(2);
    expect(h.release).not.toHaveBeenCalled();

    await expect(h.sink.publish(finalInput({
      event: {
        type: 'transcript_final',
        text: 'Une autre demande',
        language: 'fr',
        usage: { inputAudioSeconds: 2, totalTokens: 9 },
      },
    }))).rejects.toMatchObject({ code: 'identity_drift' });
    expect(h.run).toHaveBeenCalledOnce();
  });

  it('n’invente aucun stt_seconds lorsque Mistral ne fournit pas la durée audio', async () => {
    const h = harness();
    await h.sink.publish(finalInput({
      event: {
        type: 'transcript_final',
        text: 'Résume cette facture',
        language: 'fr',
        usage: { inputAudioSeconds: null, totalTokens: 9 },
      },
    }));

    expect(h.recordUsage).toHaveBeenCalledOnce();
    expect(h.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'realtime_tokens_in',
      amount: 9,
    }));
    expect(h.recordUsage.mock.calls.flat().some((value) => (
      typeof value === 'object'
      && value !== null
      && 'kind' in value
      && value.kind === 'stt_seconds'
    ))).toBe(false);
  });

  it('accepte les doublons durables exacts mais échoue fermé avant le cerveau sur toute autre réponse', async () => {
    const duplicate = harness({ usage: async () => ({ status: 'duplicate', eventId: USAGE_EVENT_ID }) });
    await duplicate.sink.publish(finalInput());
    expect(duplicate.run).toHaveBeenCalledOnce();

    for (const status of ['rejected', 'conflict', 'unavailable'] as const) {
      const rejected = harness({ usage: async () => ({ status }) });
      await expect(rejected.sink.publish(finalInput())).rejects.toMatchObject({
        code: 'usage_unavailable',
        message: 'usage_unavailable',
      });
      expect(rejected.acquire).not.toHaveBeenCalled();
      expect(rejected.run).not.toHaveBeenCalled();
      expect(rejected.publish).not.toHaveBeenCalled();
    }
  });

  it('réutilise le même occurredAt lors du retry après une écriture partielle', async () => {
    const statuses = [
      { status: 'recorded' as const, eventId: USAGE_EVENT_ID },
      { status: 'unavailable' as const },
      { status: 'duplicate' as const, eventId: USAGE_EVENT_ID },
      { status: 'recorded' as const, eventId: USAGE_EVENT_ID },
    ];
    const h = harness({ usage: async () => statuses.shift() ?? { status: 'unavailable' as const } });
    const input = finalInput();
    await expect(h.sink.publish(input)).rejects.toMatchObject({ code: 'usage_unavailable' });
    await h.sink.publish(input);

    expect(h.recordUsage).toHaveBeenCalledTimes(4);
    expect(h.recordUsage.mock.calls.map(([usage]) => usage.occurredAt))
      .toEqual([OCCURRED_AT, OCCURRED_AT, OCCURRED_AT, OCCURRED_AT]);
    expect(h.run).toHaveBeenCalledOnce();
    await expect(h.sink.publish(finalInput({ occurredAt: '2026-07-14T12:00:00.001Z' })))
      .rejects.toMatchObject({ code: 'identity_drift' });
  });

  it('refuse une horloge non canonique et une construction sans writer durable', async () => {
    const h = harness();
    await expect(h.sink.publish(finalInput({ occurredAt: '2026-07-14T12:00:00Z' })))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(h.recordUsage).not.toHaveBeenCalled();

    expect(() => new MistralRealtimeAgentSink({
      admission: { readContext: h.readContext },
      owners: h.owners,
      agentTurns: { run: h.run },
      speech: { publish: h.publish },
    } as unknown as ConstructorParameters<typeof MistralRealtimeAgentSink>[0]))
      .toThrow('Mistral realtime usage writer is required.');
  });

  it('échoue fermé sur abort avant acquisition ou pendant le cerveau', async () => {
    const before = new AbortController();
    before.abort();
    const untouched = harness();
    await expect(untouched.sink.publish(finalInput({ signal: before.signal })))
      .rejects.toMatchObject({ code: 'aborted' });
    expect(untouched.acquire).not.toHaveBeenCalled();

    const during = new AbortController();
    const interrupted = harness({
      run: async () => {
        during.abort();
        return { status: 'aborted' };
      },
    });
    await expect(interrupted.sink.publish(finalInput({ signal: during.signal })))
      .rejects.toMatchObject({ code: 'aborted' });
    expect(interrupted.publish).not.toHaveBeenCalled();
    expect(interrupted.release).toHaveBeenCalledOnce();
  });

  it('normalise toute panne publisher sans fuite et ne conserve pas un owner sans artefact ready', async () => {
    const h = harness({
      publish: async () => { throw new Error('provider-secret-response-body'); },
    });
    let failure: unknown;
    try {
      await h.sink.publish(finalInput());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MistralRealtimeAgentSinkError);
    expect(failure).toMatchObject({ code: 'speech_unavailable', message: 'speech_unavailable' });
    expect(JSON.stringify(failure)).not.toContain('provider-secret-response-body');
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('scelle un contrôle sur redemptionId et annule l’artefact si le registre durable échoue', async () => {
    const proposalId = '70000000-0000-4000-8000-000000000007';
    const proposalExpiresAt = '2026-07-14T12:00:30.000Z';
    const h = harness({
      run: async () => ({
        ...readyOutcome(),
        kind: 'proposed',
        navigate: '/devis/new',
        proposalId,
        proposalExpiresAt,
      }),
      issueControl: async () => ({ status: 'unavailable' }),
    });
    await expect(h.sink.publish(finalInput())).rejects.toMatchObject({ code: 'control_unavailable' });
    expect(h.issueControl).toHaveBeenCalledWith(expect.objectContaining({
      turnId: REDEMPTION_ID,
      artifactId: ARTIFACT_ID,
      kind: 'proposed',
      navigate: '/devis/new',
      proposalId,
      proposalExpiresAt,
    }));
    expect(h.cancel).toHaveBeenCalledWith({
      companyId: 'company-1',
      subjectHash: SUBJECT_HASH,
      sessionId: SESSION_ID,
      turnId: REDEMPTION_ID,
      artifactId: ARTIFACT_ID,
      cancellationId: CANCELLATION_ID,
      reason: 'session_end',
    });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('fence un drift survenu après le cerveau avant le publisher', async () => {
    const h = harness({
      currentContexts: [
        { revision: 7, digest: PREPARED.digest },
        { revision: 7, digest: PREPARED.digest },
        { revision: 8, digest: 'b'.repeat(64) },
      ],
    });
    await expect(h.sink.publish(finalInput())).rejects.toMatchObject({ code: 'context_drift' });
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });
});
