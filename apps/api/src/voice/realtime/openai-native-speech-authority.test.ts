import { describe, expect, it } from 'vitest';
import {
  OPENAI_NATIVE_ELIGIBLE_SPEECH_V1,
  type OpenAiNativeSpeechPurpose,
  type OpenAiNativeSpeechSource,
} from './openai-native-speech-risk';
import {
  OpenAiNativeSpeechAuthority,
  type OpenAiNativeSpeechAuthorityBinding,
  type OpenAiNativeSpeechAuthorityEntropy,
  type OpenAiNativeSpeechTurnPreparationInput,
} from './openai-native-speech-authority';
import type {
  OpenAiNativeSpeechDeliveryCompareAndSwapInput,
  OpenAiNativeSpeechDeliveryCompareAndSwapResult,
  OpenAiNativeSpeechDeliveryKey,
  OpenAiNativeSpeechDeliveryPrepareResult,
  OpenAiNativeSpeechDeliveryReadResult,
  OpenAiNativeSpeechDeliveryRepositoryPort,
  OpenAiNativeSpeechDeliveryState,
} from './openai-native-speech-delivery';

const DELIVERY = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';
const CLAIM = '44444444-4444-4444-8444-444444444444';
const ACK = '55555555-5555-4555-8555-555555555555';
const CANCEL = '66666666-6666-4666-8666-666666666666';
const FAILURE = '77777777-7777-4777-8777-777777777777';
const OTHER = '88888888-8888-4888-8888-888888888888';
const SUBJECT = '1'.repeat(64);
const CONTEXT = '2'.repeat(64);
const OWNER = '3'.repeat(64);
const SECRET = 'openai-native-authority-proof-secret-v4-0000000000000';
const REQUEST_NONCE = 'request_nonce_1234567890_1234567890';
const RESPONSE_ID = 'resp_123';
const LOCAL_OBSERVATION = Object.freeze({
  formatVersion: 1 as const,
  kind: 'webrtc_remote_rtp_observed_provider_drained_v1' as const,
});

class MemoryRepository implements OpenAiNativeSpeechDeliveryRepositoryPort {
  state: OpenAiNativeSpeechDeliveryState | null = null;
  prepareCalls = 0;
  readCalls = 0;
  casCalls = 0;
  forceCasConflict = false;
  unavailablePrepareCalls = 0;
  unavailableReadCalls = 0;
  throwPrepareAfterApply = false;
  ambiguousAlreadyApplied = false;
  throwAfterApply = false;
  corruptAppliedProjection = false;

  async prepare(
    state: OpenAiNativeSpeechDeliveryState,
  ): Promise<OpenAiNativeSpeechDeliveryPrepareResult> {
    this.prepareCalls += 1;
    if (this.unavailablePrepareCalls > 0) {
      this.unavailablePrepareCalls -= 1;
      return { status: 'unavailable' };
    }
    if (this.state === null) {
      this.state = state;
      if (this.throwPrepareAfterApply) {
        this.throwPrepareAfterApply = false;
        throw new Error('prepare_response_lost_after_commit');
      }
      return { status: 'created', state };
    }
    return JSON.stringify(this.state) === JSON.stringify(state)
      ? { status: 'already_prepared', state: this.state }
      : { status: 'conflict' };
  }

  async read(key: OpenAiNativeSpeechDeliveryKey): Promise<OpenAiNativeSpeechDeliveryReadResult> {
    this.readCalls += 1;
    if (this.unavailableReadCalls > 0) {
      this.unavailableReadCalls -= 1;
      return { status: 'unavailable' };
    }
    return this.state?.companyId === key.companyId && this.state.deliveryId === key.deliveryId
      ? { status: 'found', state: this.state }
      : { status: 'not_found' };
  }

  async compareAndSwap(
    input: OpenAiNativeSpeechDeliveryCompareAndSwapInput,
  ): Promise<OpenAiNativeSpeechDeliveryCompareAndSwapResult> {
    this.casCalls += 1;
    if (this.state === null) return { status: 'not_found' };
    if (this.forceCasConflict) return { status: 'conflict' };
    if (this.state.revision !== input.expectedRevision) {
      return JSON.stringify(this.state) === JSON.stringify(input.next)
        ? { status: 'already_applied', state: this.state }
        : { status: 'conflict' };
    }
    const previous = this.state;
    this.state = input.next;
    if (this.throwAfterApply) {
      this.throwAfterApply = false;
      throw new Error('response_lost_after_commit');
    }
    if (this.ambiguousAlreadyApplied) {
      this.ambiguousAlreadyApplied = false;
      return { status: 'already_applied', state: input.next };
    }
    if (this.corruptAppliedProjection) {
      this.corruptAppliedProjection = false;
      return { status: 'applied', state: previous };
    }
    return { status: 'applied', state: input.next };
  }
}

function risk(overrides: {
  readonly purpose?: OpenAiNativeSpeechPurpose;
  readonly source?: OpenAiNativeSpeechSource;
  readonly runKind?: 'answer' | 'proposed' | 'done';
  readonly hasTenantContext?: boolean;
  readonly hasControl?: boolean;
} = {}): OpenAiNativeSpeechTurnPreparationInput['risk'] {
  return {
    purpose: overrides.purpose ?? 'generic_assistance',
    source: overrides.source ?? 'card_body',
    runKind: overrides.runKind ?? 'answer',
    hasTenantContext: overrides.hasTenantContext ?? false,
    hasControl: overrides.hasControl ?? false,
  };
}

function input(
  overrides: Partial<OpenAiNativeSpeechTurnPreparationInput> = {},
): OpenAiNativeSpeechTurnPreparationInput {
  return {
    companyId: 'company-1',
    subjectHmac: SUBJECT,
    subjectKeyVersion: 1,
    sessionId: SESSION,
    turnId: TURN,
    contextRevision: 7,
    contextDigest: CONTEXT,
    sidebandOwnerEpoch: 3,
    sidebandOwnerTokenHmac: OWNER,
    canonicalSpeech: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1,
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    risk: risk(),
    ...overrides,
  };
}

function stateBinding(state: OpenAiNativeSpeechDeliveryState): OpenAiNativeSpeechAuthorityBinding {
  return {
    companyId: state.companyId,
    subjectHmac: state.subjectHmac,
    deliveryId: state.deliveryId,
    sessionId: state.sessionId,
    turnId: state.turnId,
    contextRevision: state.contextRevision,
    contextDigest: state.contextDigest,
    sidebandOwnerEpoch: state.sidebandOwnerEpoch,
    sidebandOwnerTokenHmac: state.sidebandOwnerTokenHmac,
  };
}

function mobileAcknowledgement(
  state: OpenAiNativeSpeechDeliveryState,
  overrides: Partial<Parameters<OpenAiNativeSpeechAuthority['acknowledgeMobileDelivery']>[0]> = {},
): Parameters<OpenAiNativeSpeechAuthority['acknowledgeMobileDelivery']>[0] {
  return {
    companyId: state.companyId,
    subjectHmacCandidates: Object.freeze([Object.freeze({
      version: state.subjectKeyVersion ?? 1,
      subjectHmac: state.subjectHmac,
    })]),
    deliveryId: state.deliveryId,
    sessionId: state.sessionId,
    turnId: state.turnId,
    contextRevision: state.contextRevision,
    contextDigest: state.contextDigest,
    acknowledgementId: ACK,
    localObservation: LOCAL_OBSERVATION,
    slo: {
      speechStoppedEventToFirstInboundRtpMs: 701,
      pendingBargeIn: { status: 'complete', durationsMs: [91, 120] },
    },
    ...overrides,
  };
}

function harness(options: {
  readonly entropy?: Partial<OpenAiNativeSpeechAuthorityEntropy>;
  readonly currentVersion?: number;
} = {}) {
  const repository = new MemoryRepository();
  const secrets = new Map<number, string>([[4, SECRET]]);
  let nowMs = 1_000_000;
  const entropy: OpenAiNativeSpeechAuthorityEntropy = {
    deliveryId: options.entropy?.deliveryId ?? (() => DELIVERY),
    requestNonce: options.entropy?.requestNonce ?? (() => REQUEST_NONCE),
    dispatchClaimId: options.entropy?.dispatchClaimId ?? (() => CLAIM),
  };
  const authority = new OpenAiNativeSpeechAuthority(
    repository,
    {
      proofKeys: {
        currentVersion: options.currentVersion ?? 4,
        secret: (version) => secrets.get(version) ?? null,
      },
    },
    entropy,
    () => nowMs,
  );
  return {
    authority,
    repository,
    secrets,
    advance: (durationMs = 1) => { nowMs += durationMs; },
  };
}

async function prepare(h: ReturnType<typeof harness>, value = input()) {
  const outcome = await h.authority.prepareTurn(value);
  if (outcome.status !== 'prepared') throw new Error(`Unexpected status: ${outcome.status}`);
  return outcome;
}

async function advanceToStreaming(h: ReturnType<typeof harness>) {
  const prepared = await prepare(h);
  const binding = stateBinding(prepared.state);
  h.advance();
  const dispatch = await h.authority.claimDispatch({ ...binding, request: prepared.request });
  if (dispatch.status !== 'authorized') throw new Error('Expected an authorized dispatch.');
  h.advance();
  expect(await h.authority.markRequested({ ...binding, dispatchClaimId: dispatch.dispatchClaimId }))
    .toMatchObject({ status: 'applied', state: { phase: 'requested' } });
  h.advance();
  expect(await h.authority.acceptProviderResponse({ ...binding, providerResponseId: RESPONSE_ID }))
    .toMatchObject({ status: 'applied', state: { phase: 'accepted' } });
  h.advance();
  expect(await h.authority.startStreaming({ ...binding, providerResponseId: RESPONSE_ID }))
    .toMatchObject({ status: 'applied', state: { phase: 'streaming' } });
  return { prepared, binding, dispatch };
}

async function advanceToCompleted(h: ReturnType<typeof harness>) {
  const streaming = await advanceToStreaming(h);
  h.advance();
  expect(await h.authority.responseDone({
    ...streaming.binding,
    providerResponseId: RESPONSE_ID,
    providerTranscript: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1,
  })).toMatchObject({ status: 'applied', state: { phase: 'draining' } });
  h.advance();
  expect(await h.authority.outputStopped({
    ...streaming.binding,
    providerResponseId: RESPONSE_ID,
  })).toMatchObject({ status: 'applied', state: { phase: 'completed' } });
  return streaming;
}

describe('OpenAiNativeSpeechAuthority — configuration et risque', () => {
  it('refuse une configuration sans cle courante forte ou un TTL hors bornes', () => {
    const repository = new MemoryRepository();
    const entropy: OpenAiNativeSpeechAuthorityEntropy = {
      deliveryId: () => DELIVERY,
      requestNonce: () => REQUEST_NONCE,
      dispatchClaimId: () => CLAIM,
    };
    expect(() => new OpenAiNativeSpeechAuthority(repository, {
      proofKeys: { currentVersion: 4, secret: () => null },
    }, entropy)).toThrow(/authority configuration/);
    expect(() => new OpenAiNativeSpeechAuthority(repository, {
      proofKeys: { currentVersion: 4, secret: () => SECRET },
      ttlMs: 9_999,
    }, entropy)).toThrow(/authority configuration/);
  });

  it.each(Object.entries(OPENAI_NATIVE_ELIGIBLE_SPEECH_V1))(
    'prepare uniquement le scenario exact %s avec policy, format et cle courante',
    async (scenarioId, canonicalSpeech) => {
      const h = harness();
      const outcome = await prepare(h, input({ canonicalSpeech }));

      expect(outcome).toMatchObject({
        status: 'prepared',
        persistence: 'created',
        state: {
          phase: 'prepared',
          speechPolicyVersion: 1,
          speechScenarioId: scenarioId,
          proofFormatVersion: 2,
          proofKeyVersion: 4,
        },
        request: {
          deliveryId: DELIVERY,
          canonicalSpeech,
          requestNonce: REQUEST_NONCE,
        },
      });
      expect(h.repository.prepareCalls).toBe(1);
      const persisted = JSON.stringify(h.repository.state);
      expect(persisted).not.toContain(canonicalSpeech);
      expect(persisted).not.toContain(REQUEST_NONCE);
    },
  );

  it.each([
    {
      name: 'fait metier',
      value: input({ canonicalSpeech: 'Il reste 1 320 euros à encaisser.' }),
      reason: 'business_fact',
    },
    {
      name: 'controle',
      value: input({ risk: risk({ hasControl: true }) }),
      reason: 'action_or_control',
    },
    {
      name: 'contexte tenant',
      value: input({ risk: risk({ hasTenantContext: true }) }),
      reason: 'tenant_context',
    },
    {
      name: 'action',
      value: input({ risk: risk({ purpose: 'action_proposal' }) }),
      reason: 'action_or_control',
    },
    {
      name: 'variation editoriale',
      value: input({
        canonicalSpeech: `${OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1} `,
      }),
      reason: 'unknown_semantics',
    },
  ])('redirige $name vers le chemin audite sans rien persister', async ({ value, reason }) => {
    const h = harness();
    await expect(h.authority.prepareTurn(value)).resolves.toEqual({
      status: 'audited_required',
      risk: { version: 1, mode: 'audited_exact', reasons: [reason] },
    });
    expect(h.repository.prepareCalls).toBe(0);
    expect(h.repository.state).toBeNull();
  });

  it.each([
    ['hasTenantContext', undefined],
    ['hasTenantContext', 0],
    ['hasTenantContext', ''],
    ['hasControl', undefined],
    ['hasControl', 0],
    ['hasControl', ''],
  ] as const)('ferme le natif si %s porte la valeur runtime invalide %j', async (field, value) => {
    const h = harness();
    const malformed = {
      ...risk(),
      [field]: value,
    } as unknown as OpenAiNativeSpeechTurnPreparationInput['risk'];
    await expect(h.authority.prepareTurn(input({ risk: malformed }))).resolves.toEqual({
      status: 'audited_required',
      risk: { version: 1, mode: 'audited_exact', reasons: ['invalid_envelope'] },
    });
    expect(h.repository.prepareCalls).toBe(0);
  });

  it('refuse une propriete risk inconnue et ne laisse jamais remplacer l’enveloppe autoritative', async () => {
    const h = harness();
    const forged = {
      ...risk(),
      envelope: {
        version: 1,
        text: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1,
        canonicalText: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1,
        classification: 'dynamic_sensitive',
        facts: [],
      },
    } as unknown as OpenAiNativeSpeechTurnPreparationInput['risk'];
    await expect(h.authority.prepareTurn(input({ risk: forged }))).resolves.toEqual({
      status: 'audited_required',
      risk: { version: 1, mode: 'audited_exact', reasons: ['invalid_envelope'] },
    });
    expect(h.repository.prepareCalls).toBe(0);
  });

  it('rend le rejeu du meme materiel de preparation idempotent et refuse sa divergence', async () => {
    const h = harness();
    const first = await prepare(h);
    const replay = await prepare(h);
    expect(first.persistence).toBe('created');
    expect(replay.persistence).toBe('already_prepared');

    const conflicting = await h.authority.prepareTurn(input({
      voice: 'cedar',
    }));
    expect(conflicting).toEqual({ status: 'conflict' });
  });

  it.each(['unavailable_before_commit', 'response_lost_after_commit'] as const)(
    'rejoue en interne le meme state apres %s',
    async (failureMode) => {
      const h = harness();
      if (failureMode === 'unavailable_before_commit') h.repository.unavailablePrepareCalls = 1;
      else h.repository.throwPrepareAfterApply = true;

      const outcome = await prepare(h);
      expect(outcome.persistence).toBe(
        failureMode === 'unavailable_before_commit' ? 'created' : 'already_prepared',
      );
      expect(h.repository.prepareCalls).toBe(2);
      expect(h.repository.state).toEqual(outcome.state);
    },
  );

  it('reste fail-safe apres crash: une nouvelle entropie entre en conflit sans doublon', async () => {
    let deliveryIndex = 0;
    let nonceIndex = 0;
    const h = harness({
      entropy: {
        deliveryId: () => [DELIVERY, OTHER][deliveryIndex++] ?? OTHER,
        requestNonce: () => [
          REQUEST_NONCE,
          'second_request_nonce_1234567890_1234567890',
        ][nonceIndex++] ?? 'second_request_nonce_1234567890_1234567890',
      },
    });
    const first = await prepare(h);
    h.advance();
    await expect(h.authority.prepareTurn(input())).resolves.toEqual({ status: 'conflict' });
    expect(h.repository.state).toEqual(first.state);
    expect(h.repository.prepareCalls).toBe(2);
  });
});

describe('OpenAiNativeSpeechAuthority — dispatch CAS at-most-once', () => {
  it.each([
    ['parole canonique', { canonicalSpeech: 'Prononce une phrase forgée.' }],
    ['nonce', { requestNonce: 'forged_request_nonce_1234567890_1234567890' }],
  ] as const)('refuse avant CAS une mutation de %s après prepareTurn', async (_label, override) => {
    const h = harness();
    const prepared = await prepare(h);
    const binding = stateBinding(prepared.state);
    h.advance();

    await expect(h.authority.claimDispatch({
      ...binding,
      request: { ...prepared.request, ...override },
    })).resolves.toEqual({ status: 'not_authorized' });
    expect(h.repository.casCalls).toBe(0);
    expect(h.repository.state).toEqual(prepared.state);
  });

  it('autorise et retourne uniquement le snapshot figé authentique pris avant une lecture suspendue', async () => {
    const h = harness();
    const prepared = await prepare(h);
    const mutableClaim = {
      ...stateBinding(prepared.state),
      request: { ...prepared.request },
    };
    const originalRead = h.repository.read.bind(h.repository);
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    h.repository.read = async (key) => {
      signalRead();
      await readGate;
      return originalRead(key);
    };

    const claiming = h.authority.claimDispatch(mutableClaim);
    await readStarted;
    mutableClaim.contextDigest = '9'.repeat(64);
    mutableClaim.request.canonicalSpeech = 'Prononce une phrase forgée.';
    mutableClaim.request.requestNonce = 'forged_request_nonce_1234567890_1234567890';
    releaseRead();

    const outcome = await claiming;
    expect(outcome).toMatchObject({ status: 'authorized', dispatchClaimId: CLAIM });
    if (outcome.status !== 'authorized') throw new Error('Expected an authorized dispatch.');
    expect(outcome.request).toEqual(prepared.request);
    expect(outcome.request).not.toBe(mutableClaim.request);
    expect(Object.isFrozen(outcome.request)).toBe(true);
    expect(outcome.request.canonicalSpeech).toBe(
      OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1,
    );
  });

  it('ne transforme jamais un snapshot forgé en droit réseau par mutation pendant le read', async () => {
    const h = harness();
    const prepared = await prepare(h);
    const mutableClaim = {
      ...stateBinding(prepared.state),
      contextDigest: '9'.repeat(64),
      request: {
        ...prepared.request,
        requestNonce: 'forged_request_nonce_1234567890_1234567890',
      },
    };
    const originalRead = h.repository.read.bind(h.repository);
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    h.repository.read = async (key) => {
      signalRead();
      await readGate;
      return originalRead(key);
    };

    const claiming = h.authority.claimDispatch(mutableClaim);
    await readStarted;
    mutableClaim.contextDigest = prepared.request.contextDigest;
    mutableClaim.request.requestNonce = prepared.request.requestNonce;
    releaseRead();

    await expect(claiming).resolves.toEqual({ status: 'not_authorized' });
    expect(h.repository.casCalls).toBe(0);
    expect(h.repository.state).toEqual(prepared.state);
  });

  it('autorise exactement un seul des claims concurrents', async () => {
    let claimIndex = 0;
    const h = harness({
      entropy: {
        dispatchClaimId: () => [CLAIM, OTHER][claimIndex++] ?? OTHER,
      },
    });
    const prepared = await prepare(h);
    const binding = stateBinding(prepared.state);
    h.advance();

    const results = await Promise.all([
      h.authority.claimDispatch({ ...binding, request: prepared.request }),
      h.authority.claimDispatch({ ...binding, request: prepared.request }),
    ]);
    expect(results.filter((result) => result.status === 'authorized')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'not_authorized')).toHaveLength(1);
    expect(h.repository.state).toMatchObject({ phase: 'dispatching', revision: 2 });
  });

  it.each(['already_applied', 'throw_after_apply'] as const)(
    'ne donne aucun droit reseau apres un resultat CAS ambigu: %s',
    async (mode) => {
      const h = harness();
      const prepared = await prepare(h);
      if (mode === 'already_applied') h.repository.ambiguousAlreadyApplied = true;
      else h.repository.throwAfterApply = true;
      h.advance();
      await expect(h.authority.claimDispatch({
        ...stateBinding(prepared.state),
        request: prepared.request,
      }))
        .resolves.toEqual({ status: mode === 'already_applied' ? 'not_authorized' : 'unavailable' });
      expect(h.repository.state).toMatchObject({ phase: 'dispatching', revision: 2 });
    },
  );

  it('borne les retries de conflit CAS et refuse une projection appliquee mensongere', async () => {
    const conflicts = harness();
    const prepared = await prepare(conflicts);
    conflicts.repository.forceCasConflict = true;
    conflicts.advance();
    await expect(conflicts.authority.claimDispatch({
      ...stateBinding(prepared.state),
      request: prepared.request,
    }))
      .resolves.toEqual({ status: 'not_authorized' });
    expect(conflicts.repository.casCalls).toBe(5);

    const corrupt = harness();
    const corruptPrepared = await prepare(corrupt);
    corrupt.repository.corruptAppliedProjection = true;
    corrupt.advance();
    await expect(corrupt.authority.claimDispatch({
      ...stateBinding(corruptPrepared.state),
      request: corruptPrepared.request,
    }))
      .resolves.toEqual({ status: 'unavailable' });
  });
});

describe('OpenAiNativeSpeechAuthority — fences et evenements provider', () => {
  it.each([
    ['subject', { subjectHmac: '9'.repeat(64) }],
    ['session', { sessionId: OTHER }],
    ['turn', { turnId: OTHER }],
    ['context revision', { contextRevision: 8 }],
    ['context digest', { contextDigest: '9'.repeat(64) }],
    ['owner epoch', { sidebandOwnerEpoch: 4 }],
    ['owner token', { sidebandOwnerTokenHmac: '9'.repeat(64) }],
  ] as const)('refuse un mismatch de %s avant toute mutation', async (_name, override) => {
    const h = harness();
    const prepared = await prepare(h);
    h.advance();
    await expect(h.authority.markRequested({
      ...stateBinding(prepared.state),
      ...override,
      dispatchClaimId: CLAIM,
    })).resolves.toEqual({ status: 'rejected' });
    expect(h.repository.casCalls).toBe(0);
    expect(h.repository.state?.phase).toBe('prepared');
  });

  it('ne transforme pas un autre tenant en oracle d’existence', async () => {
    const h = harness();
    const prepared = await prepare(h);
    h.advance();
    await expect(h.authority.claimDispatch({
      ...stateBinding(prepared.state),
      companyId: 'company-2',
      request: prepared.request,
    })).resolves.toEqual({ status: 'not_found' });
    expect(h.repository.casCalls).toBe(0);
  });

  it('rend les evenements provider exacts idempotents et ne persiste ni id ni transcript', async () => {
    const h = harness();
    const prepared = await prepare(h);
    const binding = stateBinding(prepared.state);
    h.advance();
    const dispatch = await h.authority.claimDispatch({ ...binding, request: prepared.request });
    if (dispatch.status !== 'authorized') throw new Error('Expected dispatch.');
    h.advance();
    const requested = { ...binding, dispatchClaimId: dispatch.dispatchClaimId };
    expect(await h.authority.markRequested(requested)).toMatchObject({ status: 'applied' });
    h.advance();
    expect(await h.authority.markRequested(requested)).toMatchObject({ status: 'idempotent' });

    const provider = { ...binding, providerResponseId: RESPONSE_ID };
    h.advance();
    expect(await h.authority.acceptProviderResponse(provider)).toMatchObject({ status: 'applied' });
    h.advance();
    expect(await h.authority.acceptProviderResponse(provider)).toMatchObject({ status: 'idempotent' });
    h.advance();
    expect(await h.authority.startStreaming(provider)).toMatchObject({ status: 'applied' });
    h.advance();
    expect(await h.authority.startStreaming(provider)).toMatchObject({ status: 'idempotent' });
    h.advance();
    const done = {
      ...provider,
      providerTranscript: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1,
    };
    expect(await h.authority.responseDone(done)).toMatchObject({ status: 'applied' });
    h.advance();
    expect(await h.authority.responseDone(done)).toMatchObject({ status: 'idempotent' });
    h.advance();
    expect(await h.authority.outputStopped(provider)).toMatchObject({ status: 'applied' });
    h.advance();
    expect(await h.authority.outputStopped(provider)).toMatchObject({ status: 'idempotent' });

    const persisted = JSON.stringify(h.repository.state);
    expect(persisted).not.toContain(RESPONSE_ID);
    expect(persisted).not.toContain(OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1);
  });

  it('refuse un response id divergent, un transcript divergent et une cle historique absente', async () => {
    const wrongResponse = harness();
    const streaming = await advanceToStreaming(wrongResponse);
    wrongResponse.advance();
    await expect(wrongResponse.authority.outputStopped({
      ...streaming.binding,
      providerResponseId: 'resp_other',
    })).resolves.toEqual({ status: 'rejected' });
    expect(wrongResponse.repository.state?.phase).toBe('streaming');

    wrongResponse.advance();
    await expect(wrongResponse.authority.responseDone({
      ...streaming.binding,
      providerResponseId: RESPONSE_ID,
      providerTranscript: 'Une autre phrase.',
    })).resolves.toEqual({ status: 'rejected' });
    expect(wrongResponse.repository.state?.phase).toBe('streaming');

    wrongResponse.secrets.delete(4);
    wrongResponse.advance();
    await expect(wrongResponse.authority.outputStopped({
      ...streaming.binding,
      providerResponseId: RESPONSE_ID,
    })).resolves.toEqual({ status: 'unavailable' });
  });
});

describe('OpenAiNativeSpeechAuthority — ACK et terminaux immuables', () => {
  it('lie l’ACK au tenant, sujet, session, tour, contexte et owner puis le rejoue exactement', async () => {
    const h = harness();
    const completed = await advanceToCompleted(h);
    const acknowledgement = {
      ...completed.binding,
      acknowledgementId: ACK,
      localObservation: LOCAL_OBSERVATION,
      slo: {
        speechStoppedEventToFirstInboundRtpMs: 701,
        pendingBargeIn: { status: 'complete', durationsMs: [91, 120] },
      },
    } as const;

    h.advance();
    await expect(h.authority.acknowledgeDelivery({
      ...acknowledgement,
      sidebandOwnerTokenHmac: '9'.repeat(64),
    })).resolves.toEqual({ status: 'rejected' });
    expect(h.repository.state?.phase).toBe('completed');

    h.advance();
    expect(await h.authority.acknowledgeDelivery(acknowledgement)).toMatchObject({
      status: 'applied',
      state: {
        phase: 'delivered',
        acknowledgementId: ACK,
        speechStoppedEventToFirstInboundRtpMs: 701,
        bargeInDurationsMs: [91, 120],
      },
    });
    h.advance();
    expect(await h.authority.acknowledgeDelivery(acknowledgement)).toMatchObject({
      status: 'idempotent',
      state: { phase: 'delivered' },
    });
    h.advance();
    await expect(h.authority.acknowledgeDelivery({
      ...acknowledgement,
      acknowledgementId: OTHER,
    })).resolves.toEqual({ status: 'rejected' });
  });

  it('acquitte le reçu mobile sans accepter l’owner secret depuis le wire', async () => {
    const h = harness();
    await advanceToCompleted(h);
    const completed = h.repository.state!;
    h.advance();

    const delivered = await h.authority.acknowledgeMobileDelivery(
      mobileAcknowledgement(completed),
    );

    expect(delivered).toMatchObject({
      status: 'applied',
      state: {
        phase: 'delivered',
        acknowledgementId: ACK,
        speechStoppedEventToFirstInboundRtpMs: 701,
        bargeInDurationsMs: [91, 120],
      },
    });
    h.advance();
    await expect(h.authority.acknowledgeMobileDelivery(mobileAcknowledgement(completed)))
      .resolves.toMatchObject({ status: 'idempotent', state: { phase: 'delivered' } });
  });

  it('compare une keyring sujet entière après une seule lecture durable et un seul CAS', async () => {
    const h = harness();
    await advanceToCompleted(h);
    const completed = h.repository.state!;
    const reads = h.repository.readCalls;
    const swaps = h.repository.casCalls;

    await expect(h.authority.acknowledgeMobileDelivery(mobileAcknowledgement(completed, {
      subjectHmacCandidates: Object.freeze([
        Object.freeze({ version: 2, subjectHmac: '9'.repeat(64) }),
        Object.freeze({ version: 1, subjectHmac: completed.subjectHmac }),
      ]),
    }))).resolves.toMatchObject({ status: 'applied', state: { phase: 'delivered' } });
    expect(h.repository.readCalls - reads).toBe(1);
    expect(h.repository.casCalls - swaps).toBe(1);
  });

  it('lie un reçu versionné à sa version exacte mais conserve le scan constant des lignes N-1 NULL', async () => {
    const versioned = harness();
    await advanceToCompleted(versioned);
    const completed = versioned.repository.state!;
    const casCalls = versioned.repository.casCalls;

    await expect(versioned.authority.acknowledgeMobileDelivery(mobileAcknowledgement(completed, {
      subjectHmacCandidates: Object.freeze([
        Object.freeze({ version: 2, subjectHmac: completed.subjectHmac }),
      ]),
    }))).resolves.toEqual({ status: 'not_found' });
    expect(versioned.repository.casCalls).toBe(casCalls);

    const legacy = harness();
    await advanceToCompleted(legacy);
    legacy.repository.state = Object.freeze({
      ...legacy.repository.state!,
      subjectKeyVersion: null,
    });
    const legacyCompleted = legacy.repository.state;
    if (!legacyCompleted) throw new Error('Legacy delivery fixture is unavailable.');

    await expect(legacy.authority.acknowledgeMobileDelivery(mobileAcknowledgement(
      legacyCompleted,
      {
        subjectHmacCandidates: Object.freeze([
          Object.freeze({ version: 2, subjectHmac: legacyCompleted.subjectHmac }),
        ]),
      },
    ))).resolves.toMatchObject({ status: 'applied', state: { phase: 'delivered' } });
  });

  it('ne boucle pas en base après un conflit CAS concurrent', async () => {
    const h = harness();
    await advanceToCompleted(h);
    const completed = h.repository.state!;
    h.repository.forceCasConflict = true;
    const reads = h.repository.readCalls;
    const swaps = h.repository.casCalls;

    await expect(h.authority.acknowledgeMobileDelivery(mobileAcknowledgement(completed)))
      .resolves.toEqual({ status: 'unavailable' });
    expect(h.repository.readCalls - reads).toBe(1);
    expect(h.repository.casCalls - swaps).toBe(1);
    expect(h.repository.state?.phase).toBe('completed');
  });

  it('borne à une lecture les absences et indisponibilités, quelle que soit la keyring sujet', async () => {
    const missing = harness();
    const missingReads = missing.repository.readCalls;
    await expect(missing.authority.acknowledgeMobileDelivery({
      ...mobileAcknowledgement({
        ...await prepare(missing).then((outcome) => outcome.state),
        deliveryId: OTHER,
      }),
      subjectHmacCandidates: Object.freeze([
        Object.freeze({ version: 2, subjectHmac: '9'.repeat(64) }),
        Object.freeze({ version: 1, subjectHmac: SUBJECT }),
      ]),
    })).resolves.toEqual({ status: 'not_found' });
    expect(missing.repository.readCalls - missingReads).toBe(1);

    const unavailable = harness();
    const prepared = await prepare(unavailable);
    unavailable.repository.unavailableReadCalls = 1;
    const unavailableReads = unavailable.repository.readCalls;
    await expect(unavailable.authority.acknowledgeMobileDelivery({
      ...mobileAcknowledgement(prepared.state),
      subjectHmacCandidates: Object.freeze([
        Object.freeze({ version: 2, subjectHmac: '9'.repeat(64) }),
        Object.freeze({ version: 1, subjectHmac: SUBJECT }),
      ]),
    })).resolves.toEqual({ status: 'unavailable' });
    expect(unavailable.repository.readCalls - unavailableReads).toBe(1);
  });

  it.each([
    ['tenant', { companyId: 'company-2' }],
    ['sujet', { subjectHmacCandidates: [{ version: 1, subjectHmac: '9'.repeat(64) }] }],
    ['delivery', { deliveryId: OTHER }],
    ['session', { sessionId: OTHER }],
    ['tour', { turnId: OTHER }],
    ['revision de contexte', { contextRevision: 8 }],
    ['digest de contexte', { contextDigest: '9'.repeat(64) }],
  ] as const)('masque en not_found un mismatch mobile de %s', async (_label, override) => {
    const h = harness();
    await advanceToCompleted(h);
    const completed = h.repository.state!;
    const casCalls = h.repository.casCalls;
    h.advance();

    await expect(h.authority.acknowledgeMobileDelivery({
      ...mobileAcknowledgement(completed),
      ...override,
    })).resolves.toEqual({ status: 'not_found' });
    expect(h.repository.casCalls).toBe(casCalls);
    expect(h.repository.state?.phase).toBe('completed');
  });

  it('rend un ACK avant completed explicitement retryable sans mutation', async () => {
    const incomplete = harness();
    const prepared = await prepare(incomplete);
    incomplete.advance();
    await expect(incomplete.authority.acknowledgeMobileDelivery(
      mobileAcknowledgement(prepared.state),
    )).resolves.toEqual({ status: 'not_ready' });
    expect(incomplete.repository.state?.phase).toBe('prepared');
    expect(incomplete.repository.casCalls).toBe(0);

    const draining = harness();
    const streaming = await advanceToStreaming(draining);
    draining.advance();
    expect(await draining.authority.responseDone({
      ...streaming.binding,
      providerResponseId: RESPONSE_ID,
      providerTranscript: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1,
    })).toMatchObject({ status: 'applied', state: { phase: 'draining' } });
    const beforeAcknowledgement = draining.repository.state!;
    const casCalls = draining.repository.casCalls;
    await expect(draining.authority.acknowledgeMobileDelivery(
      mobileAcknowledgement(beforeAcknowledgement),
    )).resolves.toEqual({ status: 'not_ready' });
    expect(draining.repository.state).toBe(beforeAcknowledgement);
    expect(draining.repository.casCalls).toBe(casCalls);
  });

  it('conserve un replay divergent après delivered comme conflit fatal', async () => {
    const completed = harness();
    await advanceToCompleted(completed);
    const state = completed.repository.state!;
    completed.advance();
    await completed.authority.acknowledgeMobileDelivery(mobileAcknowledgement(state));
    completed.advance();
    await expect(completed.authority.acknowledgeMobileDelivery(mobileAcknowledgement(state, {
      acknowledgementId: OTHER,
    }))).resolves.toEqual({ status: 'conflict' });
  });

  it('réconcilie uniquement une preuve durable exacte et traite le legacy NULL comme non prouvé', async () => {
    const h = harness();
    const prepared = await prepare(h);
    await expect(h.authority.reconcileOwnerDelivery(stateBinding(prepared.state)))
      .resolves.toEqual({ status: 'pending' });

    await advanceToCompleted(h);
    const completed = h.repository.state!;
    await expect(h.authority.reconcileOwnerDelivery(stateBinding(completed)))
      .resolves.toEqual({ status: 'pending' });
    await h.authority.acknowledgeMobileDelivery(mobileAcknowledgement(completed));
    await expect(h.authority.reconcileOwnerDelivery(stateBinding(completed)))
      .resolves.toMatchObject({
        status: 'delivered',
        acknowledgementId: ACK,
        state: { phase: 'delivered' },
      });

    h.repository.state = {
      ...h.repository.state!,
      localObservationFormatVersion: null,
      localObservationKind: null,
    };
    await expect(h.authority.reconcileOwnerDelivery(stateBinding(completed)))
      .resolves.toEqual({ status: 'terminal_without_proof' });
  });

  it('échoue fermé pendant une rotation preuve tant que l’ancienne clé n’est plus disponible', async () => {
    const h = harness();
    await advanceToCompleted(h);
    const completed = h.repository.state!;
    const rotated = new OpenAiNativeSpeechAuthority(
      h.repository,
      {
        proofKeys: {
          currentVersion: 5,
          secret: (version) => version === 5
            ? 'openai-native-authority-proof-secret-v5-0000000000000'
            : null,
        },
      },
      {
        deliveryId: () => OTHER,
        requestNonce: () => REQUEST_NONCE,
        dispatchClaimId: () => CLAIM,
      },
      () => 1_000_100,
    );

    await expect(rotated.reconcileOwnerDelivery(stateBinding(completed)))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(rotated.acknowledgeMobileDelivery(mobileAcknowledgement(completed)))
      .resolves.toEqual({ status: 'unavailable' });
    expect(h.repository.state?.phase).toBe('completed');

    await expect(h.authority.acknowledgeMobileDelivery(mobileAcknowledgement(completed)))
      .resolves.toMatchObject({ status: 'applied', state: { phase: 'delivered' } });
    await expect(rotated.acknowledgeMobileDelivery(mobileAcknowledgement(completed)))
      .resolves.toMatchObject({ status: 'idempotent', state: { phase: 'delivered' } });
    await expect(rotated.acknowledgeMobileDelivery(mobileAcknowledgement(completed, {
      acknowledgementId: OTHER,
    }))).resolves.toEqual({ status: 'conflict' });
    await expect(rotated.reconcileOwnerDelivery(stateBinding(completed)))
      .resolves.toMatchObject({
        status: 'delivered',
        acknowledgementId: ACK,
        state: { phase: 'delivered' },
      });

    const ownerAcknowledgement = {
      ...stateBinding(completed),
      acknowledgementId: ACK,
      localObservation: LOCAL_OBSERVATION,
      slo: mobileAcknowledgement(completed).slo,
    } as const;
    await expect(rotated.acknowledgeDelivery(ownerAcknowledgement))
      .resolves.toMatchObject({ status: 'idempotent', state: { phase: 'delivered' } });
    await expect(rotated.acknowledgeDelivery({
      ...ownerAcknowledgement,
      acknowledgementId: OTHER,
    })).resolves.toEqual({ status: 'rejected' });
  });

  it('capture tout le reçu avant la première lecture suspendue', async () => {
    const h = harness();
    await advanceToCompleted(h);
    const completed = h.repository.state!;
    const mutable = {
      ...mobileAcknowledgement(completed),
      subjectHmacCandidates: [
        { version: 2, subjectHmac: '9'.repeat(64) },
        { version: 1, subjectHmac: completed.subjectHmac },
      ],
      localObservation: { ...LOCAL_OBSERVATION },
      slo: {
        speechStoppedEventToFirstInboundRtpMs: 701,
        pendingBargeIn: { status: 'complete' as const, durationsMs: [91, 120] },
      },
    };
    const originalRead = h.repository.read.bind(h.repository);
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    h.repository.read = async (key) => {
      signalRead();
      await readGate;
      return originalRead(key);
    };
    h.advance();

    const acknowledging = h.authority.acknowledgeMobileDelivery(mutable);
    await readStarted;
    mutable.acknowledgementId = OTHER;
    mutable.contextDigest = '9'.repeat(64);
    mutable.subjectHmacCandidates[1]!.subjectHmac = '8'.repeat(64);
    mutable.localObservation.kind = 'native_playout_queue_drained_v1' as never;
    mutable.slo.pendingBargeIn.durationsMs[0] = 9_999;
    releaseRead();

    await expect(acknowledging).resolves.toMatchObject({
      status: 'applied',
      state: {
        acknowledgementId: ACK,
        contextDigest: CONTEXT,
        localObservationKind: LOCAL_OBSERVATION.kind,
        bargeInDurationsMs: [91, 120],
      },
    });
  });

  it('refuse un lot enrichi avant toute lecture et échoue fermé si la clé historique manque', async () => {
    const malformed = harness();
    await advanceToCompleted(malformed);
    const completed = malformed.repository.state!;
    const reads = malformed.repository.readCalls;
    await expect(malformed.authority.acknowledgeMobileDelivery({
      ...mobileAcknowledgement(completed),
      slo: { speechStoppedEventToFirstInboundRtpMs: 1, providerSecret: true } as never,
    })).resolves.toEqual({ status: 'not_found' });
    expect(malformed.repository.readCalls).toBe(reads);

    malformed.secrets.delete(4);
    malformed.advance();
    await expect(malformed.authority.acknowledgeMobileDelivery(mobileAcknowledgement(completed)))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('refuse toute liste sujet hostile, ambiguë ou enrichie avant la lecture durable', async () => {
    const h = harness();
    await advanceToCompleted(h);
    const completed = h.repository.state!;
    const sparse = new Array<string>(1);
    const enriched = [completed.subjectHmac] as string[] & { extra?: boolean };
    enriched.extra = true;
    const candidates: readonly unknown[] = [
      [],
      Array.from({ length: 33 }, (_, index) => index.toString(16).padStart(64, '0')),
      [completed.subjectHmac, completed.subjectHmac],
      sparse,
      enriched,
      ['A'.repeat(64)],
      { 0: completed.subjectHmac, length: 1 },
    ];

    for (const subjectHmacCandidates of candidates) {
      const reads = h.repository.readCalls;
      await expect(h.authority.acknowledgeMobileDelivery({
        ...mobileAcknowledgement(completed),
        subjectHmacCandidates,
      } as never)).resolves.toEqual({ status: 'not_found' });
      expect(h.repository.readCalls).toBe(reads);
    }
  });

  it('rend cancel/fail idempotents par leur cle et tous les terminaux immuables', async () => {
    const cancelled = harness();
    const prepared = await prepare(cancelled);
    const cancellation = {
      ...stateBinding(prepared.state),
      cancellationId: CANCEL,
      reason: 'user_cancel' as const,
    };
    cancelled.advance();
    expect(await cancelled.authority.cancel(cancellation)).toMatchObject({
      status: 'applied', state: { phase: 'cancelled' },
    });
    cancelled.advance();
    expect(await cancelled.authority.cancel(cancellation)).toMatchObject({
      status: 'idempotent', state: { phase: 'cancelled' },
    });
    cancelled.advance();
    await expect(cancelled.authority.fail({
      ...stateBinding(prepared.state),
      failureId: FAILURE,
      reason: 'internal_error',
    })).resolves.toEqual({ status: 'rejected' });

    const failed = harness();
    const failedPrepared = await prepare(failed);
    const failure = {
      ...stateBinding(failedPrepared.state),
      failureId: FAILURE,
      reason: 'provider_failed' as const,
    };
    failed.advance();
    expect(await failed.authority.fail(failure)).toMatchObject({
      status: 'applied', state: { phase: 'failed' },
    });
    failed.advance();
    expect(await failed.authority.fail(failure)).toMatchObject({
      status: 'idempotent', state: { phase: 'failed' },
    });
    failed.advance();
    await expect(failed.authority.cancel({
      ...stateBinding(failedPrepared.state),
      cancellationId: CANCEL,
      reason: 'session_end',
    })).resolves.toEqual({ status: 'rejected' });
  });
});
