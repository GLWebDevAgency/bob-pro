import { describe, expect, it } from 'vitest';
import {
  DisabledOpenAiNativeSpeechDeliveryRepository,
  OPENAI_NATIVE_SPEECH_DELIVERY_MAX_TTL_MS,
  OpenAiNativeSpeechDeliveryError,
  assertOpenAiNativeSpeechDeliveryState,
  createOpenAiNativeSpeechDelivery,
  openAiNativeSpeechDeliveryKey,
  reduceOpenAiNativeSpeechDelivery,
  transitionOpenAiNativeSpeechDelivery,
  type OpenAiNativeSpeechDeliveryEvent,
  type OpenAiNativeSpeechDeliveryPreparation,
  type OpenAiNativeSpeechDeliveryState,
} from './openai-native-speech-delivery';

const DELIVERY_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const TURN_ID = '00000000-0000-4000-8000-000000000003';
const CLAIM_ID = '00000000-0000-4000-8000-000000000004';
const ACK_ID = '00000000-0000-4000-8000-000000000005';
const CANCEL_ID = '00000000-0000-4000-8000-000000000006';
const FAILURE_ID = '00000000-0000-4000-8000-000000000007';
const OTHER_ID = '00000000-0000-4000-8000-000000000008';
const SUBJECT_HMAC = '1'.repeat(64);
const OWNER_HMAC = '2'.repeat(64);
const SPEECH_HMAC = '3'.repeat(64);
const FACTS_HMAC = '4'.repeat(64);
const NONCE_HMAC = '5'.repeat(64);
const CONTEXT_HMAC = '6'.repeat(64);
const RESPONSE_HMAC = '7'.repeat(64);

function preparation(
  overrides: Partial<OpenAiNativeSpeechDeliveryPreparation> = {},
): OpenAiNativeSpeechDeliveryPreparation {
  return {
    deliveryId: DELIVERY_ID,
    companyId: 'company-1',
    subjectHmac: SUBJECT_HMAC,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    contextRevision: 9,
    contextDigest: CONTEXT_HMAC,
    sidebandOwnerEpoch: 3,
    sidebandOwnerTokenHmac: OWNER_HMAC,
    speechPolicyVersion: 1,
    speechScenarioId: 'generic_help_v1',
    proofFormatVersion: 2,
    proofKeyVersion: 4,
    canonicalSpeechHmac: SPEECH_HMAC,
    factsHmac: FACTS_HMAC,
    requestNonceHmac: NONCE_HMAC,
    provider: 'openai',
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    createdAtMs: 1_000,
    expiresAtMs: 60_000,
    ...overrides,
  };
}

function expectDeliveryError(
  operation: () => unknown,
  code: OpenAiNativeSpeechDeliveryError['code'],
): void {
  try {
    operation();
    throw new Error('expected_openai_native_speech_delivery_error');
  } catch (error) {
    expect(error).toBeInstanceOf(OpenAiNativeSpeechDeliveryError);
    expect((error as OpenAiNativeSpeechDeliveryError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}

function advanceToRequested(): OpenAiNativeSpeechDeliveryState {
  let state = createOpenAiNativeSpeechDelivery(preparation());
  state = reduceOpenAiNativeSpeechDelivery(state, {
    type: 'CLAIM_DISPATCH',
    dispatchClaimId: CLAIM_ID,
    atMs: 2_000,
  });
  return reduceOpenAiNativeSpeechDelivery(state, {
    type: 'MARK_REQUESTED',
    dispatchClaimId: CLAIM_ID,
    atMs: 3_000,
  });
}

function advanceToStreaming(): OpenAiNativeSpeechDeliveryState {
  let state = advanceToRequested();
  state = reduceOpenAiNativeSpeechDelivery(state, {
    type: 'ACCEPT_RESPONSE',
    providerResponseIdHmac: RESPONSE_HMAC,
    atMs: 4_000,
  });
  return reduceOpenAiNativeSpeechDelivery(state, {
    type: 'START_STREAMING',
    providerResponseIdHmac: RESPONSE_HMAC,
    atMs: 5_000,
  });
}

function responseDone(
  atMs = 7_000,
): Extract<OpenAiNativeSpeechDeliveryEvent, { type: 'RESPONSE_DONE' }> {
  return {
    type: 'RESPONSE_DONE',
    providerResponseIdHmac: RESPONSE_HMAC,
    outputTranscriptHmac: SPEECH_HMAC,
    atMs,
  };
}

function outputStopped(
  atMs = 6_000,
): Extract<OpenAiNativeSpeechDeliveryEvent, { type: 'OUTPUT_STOPPED' }> {
  return {
    type: 'OUTPUT_STOPPED',
    providerResponseIdHmac: RESPONSE_HMAC,
    atMs,
  };
}

function advanceToCompleted(): OpenAiNativeSpeechDeliveryState {
  let state = advanceToStreaming();
  state = reduceOpenAiNativeSpeechDelivery(state, responseDone());
  return reduceOpenAiNativeSpeechDelivery(state, outputStopped());
}

function acknowledgement(
  overrides: Partial<Extract<OpenAiNativeSpeechDeliveryEvent, { type: 'ACK_DELIVERY' }>> = {},
): Extract<OpenAiNativeSpeechDeliveryEvent, { type: 'ACK_DELIVERY' }> {
  const value = {
    type: 'ACK_DELIVERY' as const,
    acknowledgementId: ACK_ID,
    deliveryId: DELIVERY_ID,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    contextRevision: 9,
    contextDigest: CONTEXT_HMAC,
    slo: null,
    atMs: 8_000,
    ...overrides,
  };
  return { ...value, slo: overrides.slo === undefined ? null : overrides.slo };
}

describe('OpenAI native speech delivery preparation', () => {
  it('prepare uniquement des preuves opaques et ignore tout contenu brut parasite', () => {
    const untrusted = {
      ...preparation(),
      canonicalSpeech: 'Secret a ne jamais persister',
      transcript: 'Autre contenu interdit',
      audio: 'base64-interdit',
    } as OpenAiNativeSpeechDeliveryPreparation;

    const state = createOpenAiNativeSpeechDelivery(untrusted);

    expect(state).toMatchObject({
      version: 1,
      revision: 1,
      phase: 'prepared',
      provider: 'openai',
      canonicalSpeechHmac: SPEECH_HMAC,
    });
    expect(state).not.toHaveProperty('canonicalSpeech');
    expect(state).not.toHaveProperty('transcript');
    expect(state).not.toHaveProperty('audio');
    expect(JSON.stringify(state)).not.toContain('Secret');
    expect(openAiNativeSpeechDeliveryKey(state)).toEqual({
      companyId: 'company-1',
      deliveryId: DELIVERY_ID,
    });
    expect(() => assertOpenAiNativeSpeechDeliveryState(state)).not.toThrow();
  });

  it.each([
    ['UUID non canonique', { deliveryId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }],
    ['HMAC majuscule', { canonicalSpeechHmac: 'A'.repeat(64) }],
    ['HMAC trop court', { requestNonceHmac: '5'.repeat(63) }],
    ['revision contexte nulle', { contextRevision: 0 }],
    ['epoch owner hors borne', { sidebandOwnerEpoch: 2_147_483_648 }],
    ['version de policy inconnue', { speechPolicyVersion: 2 as 1 }],
    ['scenario natif inconnu', { speechScenarioId: 'business_answer' as 'generic_help_v1' }],
    ['version de format de preuve inconnue', { proofFormatVersion: 1 as 2 }],
    ['version de clé de preuve nulle', { proofKeyVersion: 0 }],
    ['modele contenant du contenu libre', { model: 'gpt realtime secret' }],
    ['expiration egale a la creation', { expiresAtMs: 1_000 }],
    [
      'TTL trop longue',
      { expiresAtMs: 1_000 + OPENAI_NATIVE_SPEECH_DELIVERY_MAX_TTL_MS + 1 },
    ],
  ])('refuse la preparation invalide : %s', (_label, overrides) => {
    expectDeliveryError(
      () => createOpenAiNativeSpeechDelivery(preparation(overrides)),
      'invalid_preparation',
    );
  });

  it('refuse une projection relue qui contient une colonne de contenu brut ou un invariant casse', () => {
    const state = createOpenAiNativeSpeechDelivery(preparation());
    const withRawContent = { ...state, transcript: 'donnee brute' } as OpenAiNativeSpeechDeliveryState;
    const invalidContext = { ...state, contextDigest: '0'.repeat(63) };
    const cancelled = reduceOpenAiNativeSpeechDelivery(state, {
      type: 'CANCEL',
      cancellationId: CANCEL_ID,
      reason: 'user_cancel',
      atMs: 2_000,
    });
    const impossibleTerminalPrefix = { ...cancelled, requestedAtMs: 1_500 };

    expectDeliveryError(
      () => assertOpenAiNativeSpeechDeliveryState(withRawContent),
      'invalid_state',
    );
    expectDeliveryError(
      () => assertOpenAiNativeSpeechDeliveryState(invalidContext),
      'invalid_state',
    );
    expectDeliveryError(
      () => assertOpenAiNativeSpeechDeliveryState(impossibleTerminalPrefix),
      'invalid_state',
    );
  });
});

describe('OpenAI native speech delivery linear lifecycle', () => {
  it('suit prepared -> dispatching -> requested -> accepted -> streaming', () => {
    let state = createOpenAiNativeSpeechDelivery(preparation());

    state = reduceOpenAiNativeSpeechDelivery(state, {
      type: 'CLAIM_DISPATCH',
      dispatchClaimId: CLAIM_ID,
      atMs: 2_000,
    });
    expect(state).toMatchObject({ phase: 'dispatching', revision: 2, dispatchClaimId: CLAIM_ID });
    state = reduceOpenAiNativeSpeechDelivery(state, {
      type: 'MARK_REQUESTED',
      dispatchClaimId: CLAIM_ID,
      atMs: 3_000,
    });
    expect(state).toMatchObject({ phase: 'requested', revision: 3 });
    state = reduceOpenAiNativeSpeechDelivery(state, {
      type: 'ACCEPT_RESPONSE',
      providerResponseIdHmac: RESPONSE_HMAC,
      atMs: 4_000,
    });
    expect(state).toMatchObject({ phase: 'accepted', revision: 4 });
    state = reduceOpenAiNativeSpeechDelivery(state, {
      type: 'START_STREAMING',
      providerResponseIdHmac: RESPONSE_HMAC,
      atMs: 5_000,
    });
    expect(state).toMatchObject({ phase: 'streaming', revision: 5 });
  });

  it('distingue un claim applique de son replay exact et refuse un second claim', () => {
    const prepared = createOpenAiNativeSpeechDelivery(preparation());
    const claim = {
      type: 'CLAIM_DISPATCH' as const,
      dispatchClaimId: CLAIM_ID,
      atMs: 2_000,
    };

    const first = transitionOpenAiNativeSpeechDelivery(prepared, claim);
    const replay = transitionOpenAiNativeSpeechDelivery(first.state, { ...claim, atMs: 2_100 });

    expect(first.status).toBe('applied');
    expect(replay).toEqual({ status: 'idempotent', state: first.state });
    expectDeliveryError(() => transitionOpenAiNativeSpeechDelivery(first.state, {
      ...claim,
      dispatchClaimId: OTHER_ID,
    }), 'event_conflict');

    const requested = reduceOpenAiNativeSpeechDelivery(first.state, {
      type: 'MARK_REQUESTED',
      dispatchClaimId: CLAIM_ID,
      atMs: 3_000,
    });
    expectDeliveryError(
      () => transitionOpenAiNativeSpeechDelivery(requested, claim),
      'invalid_state_transition',
    );
  });

  it('refuse le mauvais claim et toute reponse provider non correlee', () => {
    const requested = advanceToRequested();
    expectDeliveryError(() => reduceOpenAiNativeSpeechDelivery(requested, {
      type: 'MARK_REQUESTED',
      dispatchClaimId: OTHER_ID,
      atMs: 3_100,
    }), 'event_conflict');

    const accepted = reduceOpenAiNativeSpeechDelivery(requested, {
      type: 'ACCEPT_RESPONSE',
      providerResponseIdHmac: RESPONSE_HMAC,
      atMs: 4_000,
    });
    expectDeliveryError(() => reduceOpenAiNativeSpeechDelivery(accepted, {
      type: 'START_STREAMING',
      providerResponseIdHmac: '8'.repeat(64),
      atMs: 5_000,
    }), 'event_conflict');
  });

  it('refuse les sauts de phase et les evenements contenant des champs parasites', () => {
    const prepared = createOpenAiNativeSpeechDelivery(preparation());
    expectDeliveryError(() => reduceOpenAiNativeSpeechDelivery(prepared, {
      type: 'START_STREAMING',
      providerResponseIdHmac: RESPONSE_HMAC,
      atMs: 2_000,
    }), 'event_conflict');

    const event = {
      type: 'CLAIM_DISPATCH',
      dispatchClaimId: CLAIM_ID,
      atMs: 2_000,
      transcript: 'champ interdit',
    } as unknown as OpenAiNativeSpeechDeliveryEvent;
    expectDeliveryError(
      () => reduceOpenAiNativeSpeechDelivery(prepared, event),
      'invalid_event',
    );
    expectDeliveryError(
      () => reduceOpenAiNativeSpeechDelivery(prepared, {
        type: '__proto__',
        atMs: 2_000,
      } as unknown as OpenAiNativeSpeechDeliveryEvent),
      'invalid_event',
    );
  });
});

describe('OpenAI native provider completion latches', () => {
  it('rend response.done et output stopped strictement commutatifs', () => {
    const streaming = advanceToStreaming();

    let doneFirst = reduceOpenAiNativeSpeechDelivery(streaming, responseDone(7_000));
    expect(doneFirst).toMatchObject({
      phase: 'draining',
      responseDoneAtMs: 7_000,
      outputStoppedAtMs: null,
    });
    doneFirst = reduceOpenAiNativeSpeechDelivery(doneFirst, outputStopped(6_000));

    let stoppedFirst = reduceOpenAiNativeSpeechDelivery(streaming, outputStopped(6_000));
    expect(stoppedFirst).toMatchObject({
      phase: 'draining',
      responseDoneAtMs: null,
      outputStoppedAtMs: 6_000,
    });
    stoppedFirst = reduceOpenAiNativeSpeechDelivery(stoppedFirst, responseDone(7_000));

    expect(doneFirst).toEqual(stoppedFirst);
    expect(doneFirst).toMatchObject({
      phase: 'completed',
      revision: 7,
      responseDoneAtMs: 7_000,
      outputStoppedAtMs: 6_000,
      completedAtMs: 7_000,
    });
  });

  it('rend chaque latch exact idempotent sans incrementer la revision', () => {
    const streaming = advanceToStreaming();
    const draining = transitionOpenAiNativeSpeechDelivery(streaming, responseDone());
    const replay = transitionOpenAiNativeSpeechDelivery(draining.state, responseDone(7_500));

    expect(draining.status).toBe('applied');
    expect(replay).toEqual({ status: 'idempotent', state: draining.state });
  });

  it('exige la preuve HMAC du transcript canonique et les deux latches avant ACK', () => {
    const streaming = advanceToStreaming();
    expectDeliveryError(() => reduceOpenAiNativeSpeechDelivery(streaming, {
      ...responseDone(),
      outputTranscriptHmac: '8'.repeat(64),
    }), 'event_conflict');

    const draining = reduceOpenAiNativeSpeechDelivery(streaming, responseDone());
    expectDeliveryError(
      () => reduceOpenAiNativeSpeechDelivery(draining, acknowledgement()),
      'invalid_state_transition',
    );
  });
});

describe('OpenAI native delivery acknowledgement and terminal states', () => {
  it('acquitte exactement une completion et rend le meme ACK idempotent', () => {
    const completed = advanceToCompleted();
    const first = transitionOpenAiNativeSpeechDelivery(completed, acknowledgement());
    const replay = transitionOpenAiNativeSpeechDelivery(first.state, acknowledgement({ atMs: 50_000 }));

    expect(first).toMatchObject({
      status: 'applied',
      state: {
        phase: 'delivered',
        acknowledgementId: ACK_ID,
        deliveredAtMs: 8_000,
        sloFormatVersion: null,
        bargeInDurationsMs: [],
        terminalAtMs: 8_000,
      },
    });
    expect(replay).toEqual({ status: 'idempotent', state: first.state });
  });

  it('grave le lot SLO exact dans le terminal et refuse tout replay au corps divergent', () => {
    const event = acknowledgement({
      slo: {
        speechStoppedEventToFirstInboundRtpMs: 701,
        pendingBargeIn: { status: 'complete', durationsMs: [91, 120] },
      },
    });
    const first = transitionOpenAiNativeSpeechDelivery(advanceToCompleted(), event);

    expect(first).toMatchObject({
      status: 'applied',
      state: {
        phase: 'delivered',
        sloFormatVersion: 1,
        speechStoppedEventToFirstInboundRtpMs: 701,
        bargeInStatus: 'complete',
        bargeInDurationsMs: [91, 120],
      },
    });
    expect(transitionOpenAiNativeSpeechDelivery(first.state, {
      ...event,
      atMs: 9_000,
    })).toEqual({ status: 'idempotent', state: first.state });
    expectDeliveryError(() => transitionOpenAiNativeSpeechDelivery(first.state, acknowledgement({
      slo: {
        speechStoppedEventToFirstInboundRtpMs: 702,
        pendingBargeIn: { status: 'complete', durationsMs: [91, 120] },
      },
    })), 'acknowledgement_conflict');
    expectDeliveryError(() => transitionOpenAiNativeSpeechDelivery(first.state, acknowledgement({
      slo: { pendingBargeIn: { status: 'overflowed' } },
    })), 'acknowledgement_conflict');
    expectDeliveryError(
      () => transitionOpenAiNativeSpeechDelivery(first.state, acknowledgement()),
      'acknowledgement_conflict',
    );
  });

  it.each([
    { speechStoppedEventToFirstInboundRtpMs: -0 },
    { speechStoppedEventToFirstInboundRtpMs: 60_001 },
    { pendingBargeIn: { status: 'complete', durationsMs: [] } },
    { pendingBargeIn: { status: 'complete', durationsMs: [10_001] } },
    { pendingBargeIn: { status: 'complete', durationsMs: Array(17).fill(1) } },
    { pendingBargeIn: { status: 'overflowed', durationsMs: [1] } },
  ])('refuse un lot SLO hors bornes ou enrichi : %#', (slo) => {
    expectDeliveryError(() => transitionOpenAiNativeSpeechDelivery(
      advanceToCompleted(),
      acknowledgement({ slo: slo as never }),
    ), 'invalid_event');
  });

  it.each([
    ['autre ACK', { acknowledgementId: OTHER_ID }],
    ['autre delivery', { deliveryId: OTHER_ID }],
    ['autre session', { sessionId: OTHER_ID }],
    ['autre tour', { turnId: OTHER_ID }],
    ['autre revision', { contextRevision: 10 }],
    ['autre contexte', { contextDigest: '8'.repeat(64) }],
  ])('refuse le conflit ACK exact : %s', (_label, override) => {
    const delivered = reduceOpenAiNativeSpeechDelivery(advanceToCompleted(), acknowledgement());
    expectDeliveryError(
      () => reduceOpenAiNativeSpeechDelivery(delivered, acknowledgement(override)),
      'acknowledgement_conflict',
    );
  });

  it('autorise completed -> cancelled avant ACK puis gele definitivement le controle', () => {
    const completed = advanceToCompleted();
    const cancellation = {
      type: 'CANCEL' as const,
      cancellationId: CANCEL_ID,
      reason: 'barge_in' as const,
      atMs: 7_500,
    };
    const first = transitionOpenAiNativeSpeechDelivery(completed, cancellation);
    const replay = transitionOpenAiNativeSpeechDelivery(first.state, {
      ...cancellation,
      atMs: 9_000,
    });

    expect(first).toMatchObject({
      status: 'applied',
      state: { phase: 'cancelled', cancellationReason: 'barge_in' },
    });
    expect(replay).toEqual({ status: 'idempotent', state: first.state });
    expectDeliveryError(
      () => reduceOpenAiNativeSpeechDelivery(first.state, acknowledgement()),
      'terminal_immutable',
    );
    expectDeliveryError(() => reduceOpenAiNativeSpeechDelivery(first.state, {
      ...cancellation,
      cancellationId: OTHER_ID,
    }), 'event_conflict');
  });

  it('rend failed et expired immuables tout en acceptant leur replay exact', () => {
    const prepared = createOpenAiNativeSpeechDelivery(preparation());
    const failure = {
      type: 'FAIL' as const,
      failureId: FAILURE_ID,
      reason: 'provider_failed' as const,
      atMs: 2_000,
    };
    const failed = transitionOpenAiNativeSpeechDelivery(prepared, failure);
    expect(transitionOpenAiNativeSpeechDelivery(failed.state, failure)).toEqual({
      status: 'idempotent',
      state: failed.state,
    });
    expectDeliveryError(() => reduceOpenAiNativeSpeechDelivery(failed.state, {
      type: 'CANCEL',
      cancellationId: CANCEL_ID,
      reason: 'user_cancel',
      atMs: 3_000,
    }), 'terminal_immutable');

    const expired = transitionOpenAiNativeSpeechDelivery(prepared, {
      type: 'EXPIRE',
      atMs: 60_000,
    });
    expect(transitionOpenAiNativeSpeechDelivery(expired.state, {
      type: 'EXPIRE',
      atMs: 90_000,
    })).toEqual({ status: 'idempotent', state: expired.state });
    expectDeliveryError(
      () => reduceOpenAiNativeSpeechDelivery(expired.state, failure),
      'terminal_immutable',
    );
  });

  it('refuse toute mutation live a expiration et expire uniquement apres la borne', () => {
    const prepared = createOpenAiNativeSpeechDelivery(preparation());
    expectDeliveryError(() => reduceOpenAiNativeSpeechDelivery(prepared, {
      type: 'EXPIRE',
      atMs: 59_999,
    }), 'expiry_not_reached');
    expectDeliveryError(() => reduceOpenAiNativeSpeechDelivery(prepared, {
      type: 'CLAIM_DISPATCH',
      dispatchClaimId: CLAIM_ID,
      atMs: 60_000,
    }), 'delivery_expired');

    const expired = reduceOpenAiNativeSpeechDelivery(prepared, {
      type: 'EXPIRE',
      atMs: 60_000,
    });
    expect(expired).toMatchObject({ phase: 'expired', terminalAtMs: 60_000 });
  });

  it('refuse une revision CAS epuisee plutot que de boucler', () => {
    const prepared = createOpenAiNativeSpeechDelivery(preparation());
    const exhausted = { ...prepared, revision: 2_147_483_647 };

    expectDeliveryError(() => reduceOpenAiNativeSpeechDelivery(exhausted, {
      type: 'CLAIM_DISPATCH',
      dispatchClaimId: CLAIM_ID,
      atMs: 2_000,
    }), 'revision_exhausted');
  });
});

describe('DisabledOpenAiNativeSpeechDeliveryRepository', () => {
  it('echoue ferme sans fabriquer de livraison locale', async () => {
    const repository = new DisabledOpenAiNativeSpeechDeliveryRepository();
    const state = createOpenAiNativeSpeechDelivery(preparation());

    await expect(repository.prepare(state)).resolves.toEqual({ status: 'unavailable' });
    await expect(repository.read(openAiNativeSpeechDeliveryKey(state))).resolves.toEqual({
      status: 'unavailable',
    });
    await expect(repository.compareAndSwap({
      key: openAiNativeSpeechDeliveryKey(state),
      expectedRevision: 1,
      next: state,
    })).resolves.toEqual({ status: 'unavailable' });
  });
});
