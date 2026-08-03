import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentMission,
  toAgentMissionView,
  type AgentMissionViewV1,
} from '@bob/core';
import {
  decodeAgentMissionCatalogueChoice,
  decodeAgentMissionLineProposalDecision,
  decodeAgentMissionPatchQuoteLine,
  decodeAgentMissionStageQuoteLines,
  decodeQuoteAgentMissionResumeV2,
} from './agent-mission-codec';
import { HttpBobClient } from './http-client';

const CONFIG_VERSION = 'bob-live-provider-neutral-v4';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const MISSION_ID = '11111111-1111-4111-8111-111111111111';
const CAPABILITY = `bam1_${Buffer.alloc(32, 7).toString('base64url')}`;
const CAPABILITY_V2 = `bam2_${Buffer.alloc(32, 9).toString('base64url')}`;
const CREATED_AT = '2026-07-26T08:00:00.000Z';
const ACKNOWLEDGED_AT = '2026-07-26T08:01:00.000Z';
const ACK_COMMAND_ID = '55555555-5555-4555-8555-555555555555';
const DRAFT = Object.freeze({
  sessionId: 'quote-draft-session-1',
  slotRevision: 1,
  contentRevision: 0,
});
const LINE = Object.freeze({
  serviceReference: 'Main-d’œuvre plomberie',
  categoryHint: 'labor' as const,
  quantityDecimal: '2',
  unitReference: 'heure',
  unitPriceDecimal: '55',
  currency: 'EUR' as const,
  priceBasis: 'per_unit' as const,
  vatRateHint: '20' as const,
});
const PENDING_LINE_ID = '33333333-3333-4333-8333-333333333333';
const DECISION_ID = '88888888-8888-4888-8888-888888888888';
const CANDIDATE_CHOICE_ID = '99999999-9999-4999-8999-999999999999';
const FREE_CHOICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPOSAL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONFIRM_CHOICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const EDIT_CHOICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
const CANCEL_CHOICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';

function initialMission() {
  const result = AgentMission.start({
    id: MISSION_ID,
    companyId: 'company-1',
    ownerUserId: 'user-1',
    createdAt: CREATED_AT,
    stagedCustomerResolution: null,
    startOutcome: 'no_slot',
    draft: DRAFT,
  });
  if (!result.ok) throw new Error(`Mission fixture invalide: ${result.error.code}`);
  return result.value.mission;
}

function missionView(mission: AgentMission, now: string): AgentMissionViewV1 {
  const result = toAgentMissionView(mission, now);
  if (!result.ok) throw new Error(`Vue fixture invalide: ${result.error.kind}`);
  return result.value;
}

function acknowledgedMission() {
  const result = initialMission().acknowledgeQuoteScreen({
    expectedRevision: 1,
    binding: {
      realtimeSessionId: SESSION_ID,
      contextRevision: 3,
      contextDigest: 'a'.repeat(64),
      screenName: '/devis/new',
      screenInstanceId: 'quote-screen-1',
      acknowledgedAt: ACKNOWLEDGED_AT,
    },
    observedDraft: DRAFT,
    draftHasCustomer: false,
    occurredAt: ACKNOWLEDGED_AT,
  });
  if (!result.ok) throw new Error(`ACK fixture invalide: ${result.error.code}`);
  return result.value.mission;
}

function selectedMission() {
  const result = acknowledgedMission().selectCustomer({
    expectedRevision: 2,
    source: 'screen_selection',
    customerId: 'customer-camping',
    updatedDraft: {
      sessionId: DRAFT.sessionId,
      slotRevision: 2,
      contentRevision: 1,
    },
    occurredAt: '2026-07-26T08:02:00.000Z',
  });
  if (!result.ok) throw new Error(`Sélection fixture invalide: ${result.error.code}`);
  return result.value.mission;
}

function selectedM2AMission() {
  const result = AgentMission.start({
    id: MISSION_ID,
    companyId: 'company-1',
    ownerUserId: 'user-1',
    protocolVersion: 2,
    createdAt: CREATED_AT,
    stagedCustomerResolution: null,
    startOutcome: 'no_slot',
    draft: DRAFT,
  });
  if (!result.ok) throw new Error(`Mission M2-A invalide: ${result.error.code}`);
  const acknowledged = result.value.mission.acknowledgeQuoteScreen({
    expectedRevision: 1,
    binding: {
      realtimeSessionId: SESSION_ID,
      contextRevision: 3,
      contextDigest: 'a'.repeat(64),
      screenName: '/devis/new',
      screenInstanceId: 'quote-screen-1',
      acknowledgedAt: ACKNOWLEDGED_AT,
    },
    observedDraft: DRAFT,
    draftHasCustomer: false,
    occurredAt: ACKNOWLEDGED_AT,
  });
  if (!acknowledged.ok) throw new Error(`ACK M2-A invalide: ${acknowledged.error.code}`);
  const selected = acknowledged.value.mission.selectCustomer({
    expectedRevision: 2,
    source: 'screen_selection',
    customerId: 'customer-camping',
    updatedDraft: {
      sessionId: DRAFT.sessionId,
      slotRevision: 2,
      contentRevision: 1,
    },
    occurredAt: '2026-07-26T08:02:00.000Z',
  });
  if (!selected.ok) throw new Error(`Client M2-A invalide: ${selected.error.code}`);
  return selected.value.mission;
}

function catalogueChoiceM2AMission() {
  const staged = selectedM2AMission().recordLineCandidatesStaged({
    expectedRevision: 3,
    stagedCount: 1,
    firstQueueOrdinal: 1,
    lastQueueOrdinal: 1,
    occurredAt: '2026-07-26T08:03:00.000Z',
  });
  if (!staged.ok) throw new Error(`Staging M2-A invalide: ${staged.error.code}`);
  const presented = staged.value.mission.presentCatalogueChoices({
    expectedRevision: 4,
    decisionId: DECISION_ID,
    pendingLineId: PENDING_LINE_ID,
    expectedWorkRevision: 2,
    expectedDraft: {
      sessionId: DRAFT.sessionId,
      slotRevision: 2,
      contentRevision: 1,
    },
    candidates: [{
      choiceId: CANDIDATE_CHOICE_ID,
      catalogueItemId: 'catalogue-main-oeuvre',
      expectedCatalogueRevision: 1,
    }],
    freeLineChoiceId: FREE_CHOICE_ID,
    occurredAt: '2026-07-26T08:04:00.000Z',
  });
  if (!presented.ok) throw new Error(`Choix M2-A invalide: ${presented.error.code}`);
  return presented.value.mission;
}

function resolvedM2AMission() {
  const resolved = catalogueChoiceM2AMission().selectCatalogueChoice({
    expectedRevision: 5,
    decisionId: DECISION_ID,
    choiceSetRevision: 5,
    choiceId: FREE_CHOICE_ID,
    pendingLineId: PENDING_LINE_ID,
    expectedWorkRevision: 2,
    observedDraft: {
      sessionId: DRAFT.sessionId,
      slotRevision: 2,
      contentRevision: 1,
    },
    observedResolution: { kind: 'free' },
    workRevisionAfter: 3,
    occurredAt: '2026-07-26T08:05:00.000Z',
  });
  if (!resolved.ok) throw new Error(`Résolution M2-A invalide: ${resolved.error.code}`);
  return resolved.value.transition.mission;
}

function patchedLineDetailsM2AMission() {
  const base = resolvedM2AMission();
  const requested = base.requestLineDetails({
    expectedRevision: base.toSnapshot().revision,
    pendingLineId: PENDING_LINE_ID,
    requiredFact: 'unit_price',
    workRevisionAfter: 4,
    occurredAt: '2026-07-26T08:06:00.000Z',
  });
  if (!requested.ok) {
    throw new Error(`Détails M2-A invalides: ${requested.error.code}`);
  }
  const patched = requested.value.mission.patchLineFact({
    expectedRevision: requested.value.mission.toSnapshot().revision,
    pendingLineId: PENDING_LINE_ID,
    field: 'unit_price',
    workRevisionAfter: 5,
    occurredAt: '2026-07-26T08:07:00.000Z',
  });
  if (!patched.ok) {
    throw new Error(`Patch M2-A invalide: ${patched.error.code}`);
  }
  const continued = patched.value.mission.requestLineDetails({
    expectedRevision: patched.value.mission.toSnapshot().revision,
    pendingLineId: PENDING_LINE_ID,
    requiredFact: 'vat_rate',
    workRevisionAfter: 6,
    occurredAt: '2026-07-26T08:08:00.000Z',
  });
  if (!continued.ok) {
    throw new Error(`Continuation patch M2-A invalide: ${continued.error.code}`);
  }
  return continued.value.mission;
}

function lineProposalM2AMission() {
  const base = resolvedM2AMission();
  const draft = base.toSnapshot().payload.draft;
  if (draft === null) throw new Error('Brouillon M2-A attendu');
  const presented = base.presentLineProposal({
    expectedRevision: base.toSnapshot().revision,
    decisionId: DECISION_ID,
    pendingLineId: PENDING_LINE_ID,
    proposalId: PROPOSAL_ID,
    expectedDraft: draft,
    expectedWorkRevision: 4,
    expectedCatalogue: null,
    expectedVatContextDigest: 'a'.repeat(64),
    diffHash: 'b'.repeat(64),
    confirmChoiceId: CONFIRM_CHOICE_ID,
    editChoiceId: EDIT_CHOICE_ID,
    cancelChoiceId: CANCEL_CHOICE_ID,
    occurredAt: '2026-07-26T08:06:00.000Z',
  });
  if (!presented.ok) {
    throw new Error(`Proposition M2-A invalide: ${presented.error.code}`);
  }
  return presented.value.mission;
}

function editedLineM2AMission() {
  const proposal = lineProposalM2AMission();
  const decision = proposal.toSnapshot().payload.decision;
  if (decision?.kind !== 'line_confirmation') {
    throw new Error('Décision de ligne attendue');
  }
  const edited = proposal.rejectLineProposal({
    expectedRevision: proposal.toSnapshot().revision,
    decisionId: decision.decisionId,
    choiceSetRevision: decision.choiceSetRevision,
    choiceId: EDIT_CHOICE_ID,
    pendingLineId: decision.pendingLineId,
    proposalId: decision.proposalId,
    proposalRevision: decision.proposalRevision,
    expectedWorkRevision: decision.expectedWorkRevision,
    observedDraft: decision.expectedDraft,
    observedCatalogue: decision.expectedCatalogue,
    diffHash: decision.diffHash,
    workRevisionAfter: 5,
    occurredAt: '2026-07-26T08:07:00.000Z',
  });
  if (!edited.ok) {
    throw new Error(`Édition M2-A invalide: ${edited.error.code}`);
  }
  return edited.value.mission;
}

function cancelledPendingLineM2AMission() {
  const details = patchedLineDetailsM2AMission();
  const draft = details.toSnapshot().payload.draft;
  if (draft === null) throw new Error('Brouillon M2-A attendu');
  const cancelled = details.cancelPendingLine({
    expectedRevision: details.toSnapshot().revision,
    pendingLineId: PENDING_LINE_ID,
    expectedWorkRevision: 6,
    observedDraft: draft,
    occurredAt: '2026-07-26T08:09:00.000Z',
  });
  if (!cancelled.ok) {
    throw new Error(`Annulation de ligne M2-A invalide: ${cancelled.error.code}`);
  }
  return cancelled.value.mission;
}

function cataloguePresentation(view: AgentMissionViewV1) {
  const decision = view.payload.decision;
  if (decision?.kind !== 'catalogue') {
    throw new Error('Décision catalogue attendue dans la fixture');
  }
  return {
    schema: 'bob.agent-mission.quote-presentation',
    version: 1,
    requiredFact: null,
    pendingLine: {
      pendingLineId: decision.pendingLineId,
      expectedWorkRevision: decision.expectedWorkRevision,
    },
    decision: {
      kind: decision.kind,
      decisionId: decision.decisionId,
      choiceSetRevision: decision.choiceSetRevision,
      pendingLineId: decision.pendingLineId,
      expectedDraft: decision.expectedDraft,
      expectedWorkRevision: decision.expectedWorkRevision,
      choices: decision.candidates,
      freeLineChoiceId: decision.freeLineChoiceId,
      choiceSetHash: decision.choiceSetHash,
    },
    catalogueChoices: [{
      choiceId: CANDIDATE_CHOICE_ID,
      available: true,
      label: 'Heure de main-d’œuvre plomberie',
      category: 'labor',
      unit: 'heure',
      unitPriceCents: 5_500,
      vatRate: 20,
    }],
    freeLineChoiceId: decision.freeLineChoiceId,
    proposalStatus: { kind: 'absent' },
    proposal: null,
  };
}

function awaitingLinesPresentation(expectedWorkRevision: number) {
  return {
    schema: 'bob.agent-mission.quote-presentation',
    version: 1,
    requiredFact: null,
    pendingLine: {
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision,
    },
    decision: null,
    catalogueChoices: [],
    freeLineChoiceId: null,
    proposalStatus: { kind: 'absent' },
    proposal: null,
  };
}

function lineDetailsPresentation(
  expectedWorkRevision: number,
  requiredFact: 'unit_price' | 'vat_rate' | null,
) {
  return {
    schema: 'bob.agent-mission.quote-presentation',
    version: 1,
    requiredFact,
    pendingLine: {
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision,
    },
    decision: null,
    catalogueChoices: [],
    freeLineChoiceId: null,
    proposalStatus: { kind: 'absent' },
    proposal: null,
  };
}

function lineConfirmationPresentation(view: AgentMissionViewV1) {
  const decision = view.payload.decision;
  if (decision?.kind !== 'line_confirmation') {
    throw new Error('Décision de confirmation attendue dans la fixture');
  }
  return {
    schema: 'bob.agent-mission.quote-presentation',
    version: 1,
    requiredFact: null,
    pendingLine: {
      pendingLineId: decision.pendingLineId,
      expectedWorkRevision: decision.expectedWorkRevision,
    },
    decision: {
      kind: decision.kind,
      decisionId: decision.decisionId,
      choiceSetRevision: decision.choiceSetRevision,
      pendingLineId: decision.pendingLineId,
      proposalId: decision.proposalId,
      proposalRevision: decision.proposalRevision,
      expectedDraft: decision.expectedDraft,
      expectedWorkRevision: decision.expectedWorkRevision,
      expectedCatalogue: decision.expectedCatalogue,
      expectedVatContextDigest: decision.expectedVatContextDigest,
      diffHash: decision.diffHash,
      choices: decision.choices,
      choiceSetHash: decision.choiceSetHash,
    },
    catalogueChoices: [],
    freeLineChoiceId: null,
    proposalStatus: {
      kind: 'stale',
      reason: 'vat_context_changed',
    },
    proposal: null,
  };
}

function nativeBootstrap(
  negotiation: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    transport: 'webrtc',
    answerSdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\na=recvonly\r\n',
    sessionHandle: SESSION_ID,
    hardExpiresAt: '2026-07-26T08:15:00.000Z',
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    configVersion: CONFIG_VERSION,
    speechDelivery: 'openai-native-webrtc-v1',
    maxSessionSeconds: 900,
    ...negotiation,
  };
}

function client(getToken?: () => Promise<string | null>): HttpBobClient {
  return new HttpBobClient({
    baseUrl: 'https://api.bob.test',
    companyId: 'company-1',
    ...(getToken === undefined ? {} : { getToken }),
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function nativeCallInput(
  agentMissionProtocolVersion?: 1 | 2 | null,
): Parameters<HttpBobClient['createRealtimeVoiceCall']>[0] {
  return {
    transport: 'webrtc',
    sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n',
    configVersion: CONFIG_VERSION,
    speechDelivery: 'openai-native-webrtc-v1',
    sessionHandle: SESSION_ID,
    ...(agentMissionProtocolVersion === undefined
      ? {}
      : { agentMissionProtocolVersion }),
  };
}

describe('Realtime AgentMission capability handle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('encapsule le secret, pose seule le header et injecte le vrai realtimeSessionId', async () => {
    const initialView = missionView(initialMission(), CREATED_AT);
    const acknowledgedView = missionView(acknowledgedMission(), ACKNOWLEDGED_AT);
    const selectedView = missionView(selectedMission(), '2026-07-26T08:02:00.000Z');
    const cancelled = initialMission().cancel({
      expectedRevision: 1,
      reason: 'user_cancelled',
      occurredAt: ACKNOWLEDGED_AT,
    });
    if (!cancelled.ok) throw new Error(`Cancel fixture invalide: ${cancelled.error.code}`);
    const cancelledView = missionView(cancelled.value.mission, ACKNOWLEDGED_AT);
    const getToken = vi.fn(async () => 'supabase-jwt');
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        expect(JSON.parse(String(init?.body))).toEqual({
          sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n',
          configVersion: CONFIG_VERSION,
          speechDelivery: 'openai-native-webrtc-v1',
          agentMissionProtocolVersion: 1,
          sessionHandle: SESSION_ID,
        });
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
          agentMissionCapability: CAPABILITY,
        })), { headers: { 'content-type': 'application/json' } });
      }

      expect(init?.headers).toMatchObject({
        authorization: 'Bearer supabase-jwt',
        'x-bob-agent-mission-capability': CAPABILITY,
      });
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeUndefined();
        return new Response(JSON.stringify({
          acknowledged: true,
          replayed: false,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === '/agent-missions/current/quote-creation') {
        expect(init?.method).toBe('GET');
        expect(init?.body).toBeUndefined();
        return new Response(JSON.stringify({ mission: initialView }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/agent-missions/quote-creation/start') {
        expect(JSON.parse(String(init?.body))).toEqual({
          commandId: '33333333-3333-4333-8333-333333333333',
        });
        return new Response(JSON.stringify({
          outcome: 'created',
          startOutcome: 'no_slot',
          mission: initialView,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/cancel`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          commandId: '44444444-4444-4444-8444-444444444444',
          expectedMissionRevision: 1,
          reason: 'user_cancelled',
        });
        return new Response(JSON.stringify({
          outcome: 'cancelled',
          mission: cancelledView,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/screen-acks`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          commandId: '55555555-5555-4555-8555-555555555555',
          expectedMissionRevision: 1,
          realtimeSessionId: SESSION_ID,
          contextRevision: 3,
          contextDigest: 'a'.repeat(64),
          draftSessionId: DRAFT.sessionId,
          expectedDraftSlotRevision: 1,
          expectedDraftContentRevision: 0,
        });
        return new Response(JSON.stringify({
          outcome: 'acknowledged',
          receipt: {
            ackCommandId: ACK_COMMAND_ID,
            missionId: MISSION_ID,
            missionRevisionAfter: 2,
            realtimeSessionId: SESSION_ID,
            contextRevision: 3,
            contextDigest: 'a'.repeat(64),
            occurredAt: ACKNOWLEDGED_AT,
          },
          mission: acknowledgedView,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/decisions`) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty('missionId');
        expect(body).not.toHaveProperty('realtimeSessionId');
        expect(body).not.toHaveProperty('actor');
        if (body.action === 'select_screen_customer') {
          expect(body).toEqual({
            action: 'select_screen_customer',
            commandId: '66666666-6666-4666-8666-666666666666',
            expectedMissionRevision: 2,
            expectedDraftSessionId: DRAFT.sessionId,
            expectedDraftSlotRevision: 1,
            expectedDraftContentRevision: 0,
            customerId: 'customer-camping',
          });
        } else {
          expect(body).toEqual({
            action: 'choose_presented_option',
            commandId: '77777777-7777-4777-8777-777777777777',
            expectedMissionRevision: 2,
            expectedDraftSessionId: DRAFT.sessionId,
            expectedDraftSlotRevision: 1,
            expectedDraftContentRevision: 0,
            decisionId: '88888888-8888-4888-8888-888888888888',
            choiceSetRevision: 2,
            choiceId: '99999999-9999-4999-8999-999999999999',
          });
        }
        return new Response(JSON.stringify({
          outcome: 'selected',
          effect: { kind: 'selected' },
          mission: selectedView,
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const bootstrap = await client(getToken).createRealtimeVoiceCall(nativeCallInput(1));
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    expect(paths.slice(0, 2)).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
    ]);
    const handle = bootstrap.value.agentMissionSession;
    expect(handle).not.toBeNull();
    expect(handle).not.toBeUndefined();
    if (!handle) return;

    expect(handle.realtimeSessionId).toBe(SESSION_ID);
    expect(handle.protocolVersion).toBe(1);
    expect('stageQuoteLines' in handle).toBe(false);
    expect('decideQuoteCatalogueChoice' in handle).toBe(false);
    expect(Object.keys(handle)).toEqual([]);
    expect({ ...handle }).toEqual({});
    expect(JSON.stringify(handle)).toBe('{}');
    expect(JSON.stringify(bootstrap.value)).not.toContain('bam1_');
    expect({ ...bootstrap.value }).not.toHaveProperty('agentMissionSession');

    await expect(handle.getCurrentQuoteCreation()).resolves.toEqual({
      ok: true,
      value: { mission: initialView },
    });
    await expect(handle.startQuoteCreation({
      commandId: '33333333-3333-4333-8333-333333333333',
    })).resolves.toMatchObject({ ok: true, value: { outcome: 'created' } });
    await expect(handle.cancelQuoteCreation({
      missionId: MISSION_ID,
      commandId: '44444444-4444-4444-8444-444444444444',
      expectedMissionRevision: 1,
    })).resolves.toMatchObject({ ok: true, value: { outcome: 'cancelled' } });
    await expect(handle.acknowledgeQuoteScreen({
      missionId: MISSION_ID,
      commandId: '55555555-5555-4555-8555-555555555555',
      expectedMissionRevision: 1,
      contextRevision: 3,
      contextDigest: 'a'.repeat(64),
      draftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
    })).resolves.toMatchObject({ ok: true, value: { outcome: 'acknowledged' } });
    await expect(handle.decideQuoteCreation({
      missionId: MISSION_ID,
      action: 'select_screen_customer',
      commandId: '66666666-6666-4666-8666-666666666666',
      expectedMissionRevision: 2,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
      customerId: 'customer-camping',
    })).resolves.toMatchObject({ ok: true, value: { outcome: 'selected' } });
    await expect(handle.decideQuoteCreation({
      missionId: MISSION_ID,
      action: 'choose_presented_option',
      commandId: '77777777-7777-4777-8777-777777777777',
      expectedMissionRevision: 2,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
      decisionId: '88888888-8888-4888-8888-888888888888',
      choiceSetRevision: 2,
      choiceId: '99999999-9999-4999-8999-999999999999',
    })).resolves.toMatchObject({ ok: true, value: { outcome: 'selected' } });

    const fetchesBeforeDispose = fetchMock.mock.calls.length;
    const tokenReadsBeforeDispose = getToken.mock.calls.length;
    handle.dispose();
    expect(handle.disposed).toBe(true);
    await expect(handle.getCurrentQuoteCreation()).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });
    await expect(handle.decideQuoteCreation({
      missionId: MISSION_ID,
      action: 'select_screen_customer',
      commandId: '66666666-6666-4666-8666-666666666666',
      expectedMissionRevision: 2,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
      customerId: 'customer-camping',
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(fetchesBeforeDispose);
    expect(getToken).toHaveBeenCalledTimes(tokenReadsBeforeDispose);
  });

  it('expose les commandes M2-A uniquement sur un handle bam2 opaque et exact', async () => {
    const catalogueView = missionView(
      catalogueChoiceM2AMission(),
      '2026-07-26T08:04:00.000Z',
    );
    const resolvedView = missionView(
      resolvedM2AMission(),
      '2026-07-26T08:05:00.000Z',
    );
    const patchedDetailsView = missionView(
      patchedLineDetailsM2AMission(),
      '2026-07-26T08:08:00.000Z',
    );
    const proposalMission = lineProposalM2AMission();
    const proposalDecision = proposalMission.toSnapshot().payload.decision;
    if (proposalDecision?.kind !== 'line_confirmation') {
      throw new Error('Décision de proposition attendue');
    }
    const proposalView = missionView(
      proposalMission,
      '2026-07-26T08:06:00.000Z',
    );
    const editedView = missionView(
      editedLineM2AMission(),
      '2026-07-26T08:07:00.000Z',
    );
    const cancelledPendingLineView = missionView(
      cancelledPendingLineM2AMission(),
      '2026-07-26T08:09:00.000Z',
    );
    const catalogueDraft = catalogueView.payload.draft;
    if (catalogueDraft === null) throw new Error('Brouillon catalogue attendu');
    expect(decodeQuoteAgentMissionResumeV2({
      mission: {
        id: catalogueView.id,
        status: catalogueView.status,
        phase: catalogueView.phase,
        revision: catalogueView.revision,
        actionable: catalogueView.actionable,
        draft: catalogueDraft,
        idleExpiresAt: catalogueView.idleExpiresAt,
        hardExpiresAt: catalogueView.hardExpiresAt,
      },
      draft: { ...catalogueDraft, step: 'lignes' },
      customerChoices: [],
      presentation: cataloguePresentation(catalogueView),
    })).not.toBeNull();
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          agentMissionProtocolVersion: 2,
        });
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 2,
          agentMissionCapability: CAPABILITY_V2,
        })), { headers: { 'content-type': 'application/json' } });
      }
      expect(init?.headers).toMatchObject({
        'x-bob-agent-mission-capability': CAPABILITY_V2,
      });
      if (path === '/agent-missions/current/quote-creation') {
        return new Response(JSON.stringify({
          mission: catalogueView,
          presentation: cataloguePresentation(catalogueView),
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        return new Response(JSON.stringify({
          acknowledged: true,
          replayed: false,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/screen-acks`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          commandId: '13131313-1313-4313-8313-131313131313',
          expectedMissionRevision: 1,
          realtimeSessionId: SESSION_ID,
          contextRevision: 3,
          contextDigest: 'a'.repeat(64),
          draftSessionId: DRAFT.sessionId,
          expectedDraftSlotRevision: 1,
          expectedDraftContentRevision: 0,
        });
        return new Response(JSON.stringify({
          outcome: 'acknowledged',
          receipt: {
            ackCommandId: '13131313-1313-4313-8313-131313131313',
            missionId: MISSION_ID,
            missionRevisionAfter: 2,
            realtimeSessionId: SESSION_ID,
            contextRevision: 3,
            contextDigest: 'a'.repeat(64),
            occurredAt: ACKNOWLEDGED_AT,
          },
          mission: patchedDetailsView,
          presentation: lineDetailsPresentation(6, 'vat_rate'),
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/decisions`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          action: 'select_screen_customer',
          commandId: '14141414-1414-4414-8414-141414141414',
          expectedMissionRevision: 2,
          expectedDraftSessionId: DRAFT.sessionId,
          expectedDraftSlotRevision: 1,
          expectedDraftContentRevision: 0,
          customerId: 'customer-camping',
        });
        return new Response(JSON.stringify({
          outcome: 'selected',
          effect: { kind: 'selected' },
          mission: proposalView,
          presentation: lineConfirmationPresentation(proposalView),
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/quote-lines`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedMissionRevision: 3,
          expectedDraftSessionId: DRAFT.sessionId,
          expectedDraftSlotRevision: 2,
          expectedDraftContentRevision: 1,
          lines: [LINE],
        });
        return new Response(JSON.stringify({
          outcome: 'staged',
          mission: catalogueView,
          stagedCount: 1,
          firstQueueOrdinal: 1,
          lastQueueOrdinal: 1,
          continuation: {
            outcome: 'choices_presented',
            pendingLineId: PENDING_LINE_ID,
            presentedChoiceCount: 2,
            requiredFact: null,
            proposalId: null,
          },
          presentation: cataloguePresentation(catalogueView),
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/catalogue-choices`) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          expectedMissionRevision: 5,
          expectedDraftSessionId: DRAFT.sessionId,
          expectedDraftSlotRevision: 2,
          expectedDraftContentRevision: 1,
          decisionId: DECISION_ID,
          choiceSetRevision: 5,
          pendingLineId: PENDING_LINE_ID,
          expectedWorkRevision: 2,
          choiceId: FREE_CHOICE_ID,
          additionalLines: [],
        });
        expect(body).not.toHaveProperty('missionId');
        expect(body).not.toHaveProperty('catalogueItemId');
        expect(body).not.toHaveProperty('realtimeSessionId');
        return new Response(JSON.stringify({
          outcome: 'selected',
          resolution: 'free',
          invalidationReason: null,
          mission: resolvedView,
          continuation: {
            outcome: 'deferred_to_m2a2',
            pendingLineId: PENDING_LINE_ID,
            presentedChoiceCount: 0,
            requiredFact: null,
            proposalId: null,
          },
          presentation: awaitingLinesPresentation(3),
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/quote-line-patches`) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          expectedMissionRevision: 7,
          expectedDraftSessionId: DRAFT.sessionId,
          expectedDraftSlotRevision: 2,
          expectedDraftContentRevision: 1,
          pendingLineId: PENDING_LINE_ID,
          expectedWorkRevision: 4,
          scope: 'answer_required_fact',
          patch: {
            field: 'unit_price',
            decimal: '55',
            currency: 'EUR',
            basis: 'per_unit',
          },
        });
        expect(body).not.toHaveProperty('missionId');
        expect(body).not.toHaveProperty('actor');
        return new Response(JSON.stringify({
          outcome: 'patched',
          pendingLineId: PENDING_LINE_ID,
          workRevisionAfter: 5,
          mission: patchedDetailsView,
          continuation: {
            outcome: 'details_requested',
            pendingLineId: PENDING_LINE_ID,
            presentedChoiceCount: 0,
            requiredFact: 'vat_rate',
            proposalId: null,
          },
          presentation: lineDetailsPresentation(6, 'vat_rate'),
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/quote-line-cancellations`) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          commandId: '15151515-1515-4515-8515-151515151515',
          expectedMissionRevision: patchedDetailsView.revision,
          expectedDraftSessionId: DRAFT.sessionId,
          expectedDraftSlotRevision: 2,
          expectedDraftContentRevision: 1,
          pendingLineId: PENDING_LINE_ID,
          expectedWorkRevision: 6,
        });
        expect(body).not.toHaveProperty('missionId');
        expect(body).not.toHaveProperty('decisionId');
        expect(body).not.toHaveProperty('choiceId');
        return new Response(JSON.stringify({
          outcome: 'cancelled',
          pendingLineId: PENDING_LINE_ID,
          mission: cancelledPendingLineView,
          continuation: {
            outcome: 'empty',
            pendingLineId: null,
            presentedChoiceCount: 0,
            requiredFact: null,
            proposalId: null,
          },
          presentation: {
            schema: 'bob.agent-mission.quote-presentation',
            version: 1,
            requiredFact: null,
            pendingLine: null,
            decision: null,
            catalogueChoices: [],
            freeLineChoiceId: null,
            proposalStatus: { kind: 'absent' },
            proposal: null,
          },
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/quote-line-decisions`) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          commandId: '12121212-1212-4212-8212-121212121212',
          expectedMissionRevision: proposalDecision.choiceSetRevision,
          expectedDraftSessionId: DRAFT.sessionId,
          expectedDraftSlotRevision: 2,
          expectedDraftContentRevision: 1,
          decisionId: proposalDecision.decisionId,
          choiceSetRevision: proposalDecision.choiceSetRevision,
          choiceSetHash: proposalDecision.choiceSetHash,
          choiceId: EDIT_CHOICE_ID,
          pendingLineId: PENDING_LINE_ID,
          proposalId: PROPOSAL_ID,
          proposalRevision: 1,
          expectedWorkRevision: 4,
          expectedCatalogue: null,
          diffHash: 'b'.repeat(64),
        });
        expect(body).not.toHaveProperty('missionId');
        expect(body).not.toHaveProperty('actor');
        return new Response(JSON.stringify({
          outcome: 'edit_requested',
          invalidationReason: null,
          mission: editedView,
          continuation: {
            outcome: 'stable',
            pendingLineId: null,
            presentedChoiceCount: 0,
            requiredFact: null,
            proposalId: null,
          },
          presentation: lineDetailsPresentation(5, null),
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const bootstrap = await client().createRealtimeVoiceCall(nativeCallInput(2));
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    const handle = bootstrap.value.agentMissionSession;
    expect(handle?.protocolVersion).toBe(2);
    if (!handle || handle.protocolVersion !== 2) return;
    expect(Object.keys(handle)).toEqual([]);
    expect(JSON.stringify(handle)).toBe('{}');
    expect(JSON.stringify(bootstrap.value)).not.toContain('bam2_');

    await expect(handle.getCurrentQuoteCreation()).resolves.toMatchObject({
      ok: true,
      value: {
        mission: { phase: 'awaiting_catalogue_choice' },
        presentation: {
          decision: { kind: 'catalogue' },
          catalogueChoices: [{ choiceId: CANDIDATE_CHOICE_ID }],
        },
      },
    });
    await expect(handle.acknowledgeQuoteScreen({
      missionId: MISSION_ID,
      commandId: '13131313-1313-4313-8313-131313131313',
      expectedMissionRevision: 1,
      contextRevision: 3,
      contextDigest: 'a'.repeat(64),
      draftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        mission: { phase: 'awaiting_line_details' },
        presentation: {
          requiredFact: 'vat_rate',
          pendingLine: { pendingLineId: PENDING_LINE_ID },
        },
      },
    });
    await expect(handle.decideQuoteCreation({
      missionId: MISSION_ID,
      action: 'select_screen_customer',
      commandId: '14141414-1414-4414-8414-141414141414',
      expectedMissionRevision: 2,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
      customerId: 'customer-camping',
    })).resolves.toMatchObject({
      ok: true,
      value: {
        mission: { phase: 'awaiting_line_confirmation' },
        presentation: {
          decision: {
            kind: 'line_confirmation',
            proposalId: PROPOSAL_ID,
          },
        },
      },
    });

    const fetchesAfterBootstrap = fetchMock.mock.calls.length;
    await expect(handle.stageQuoteLines({
      missionId: MISSION_ID,
      commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expectedMissionRevision: 3,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      lines: [],
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
    await expect(handle.decideQuoteCatalogueChoice({
      missionId: MISSION_ID,
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedMissionRevision: 5,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      decisionId: DECISION_ID,
      choiceSetRevision: 5,
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 2,
      choiceId: FREE_CHOICE_ID,
      additionalLines: Array.from({ length: 21 }, () => LINE),
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
    await expect(handle.patchQuoteLine({
      missionId: MISSION_ID,
      commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      expectedMissionRevision: 7,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 4,
      scope: 'answer_required_fact',
      patch: {
        field: 'unit_price',
        decimal: 'NaN',
        currency: 'EUR',
        basis: 'per_unit',
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
    await expect(handle.decideQuoteLineProposal({
      missionId: MISSION_ID,
      commandId: '12121212-1212-4212-8212-121212121212',
      expectedMissionRevision: proposalDecision.choiceSetRevision,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      decisionId: proposalDecision.decisionId,
      choiceSetRevision: proposalDecision.choiceSetRevision,
      choiceSetHash: 'not-a-hash',
      choiceId: EDIT_CHOICE_ID,
      pendingLineId: PENDING_LINE_ID,
      proposalId: PROPOSAL_ID,
      proposalRevision: 1,
      expectedWorkRevision: 4,
      expectedCatalogue: null,
      diffHash: 'b'.repeat(64),
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
    await expect(handle.cancelPendingQuoteLine({
      missionId: MISSION_ID,
      commandId: '15151515-1515-4515-8515-151515151515',
      expectedMissionRevision: patchedDetailsView.revision,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 0,
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(fetchesAfterBootstrap);

    const stagedResult = await handle.stageQuoteLines({
      missionId: MISSION_ID,
      commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expectedMissionRevision: 3,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      lines: [LINE],
    });
    if (!stagedResult.ok) {
      throw new Error(JSON.stringify(stagedResult.error));
    }
    expect(stagedResult).toMatchObject({
      ok: true,
      value: { outcome: 'staged' },
    });
    await expect(handle.decideQuoteCatalogueChoice({
      missionId: MISSION_ID,
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedMissionRevision: 5,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      decisionId: DECISION_ID,
      choiceSetRevision: 5,
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 2,
      choiceId: FREE_CHOICE_ID,
      additionalLines: [],
    })).resolves.toMatchObject({
      ok: true,
      value: { outcome: 'selected', resolution: 'free' },
    });
    await expect(handle.patchQuoteLine({
      missionId: MISSION_ID,
      commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      expectedMissionRevision: 7,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 4,
      scope: 'answer_required_fact',
      patch: {
        field: 'unit_price',
        decimal: '55',
        currency: 'EUR',
        basis: 'per_unit',
      },
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'patched',
        continuation: { outcome: 'details_requested', requiredFact: 'vat_rate' },
      },
    });
    await expect(handle.cancelPendingQuoteLine({
      missionId: MISSION_ID,
      commandId: '15151515-1515-4515-8515-151515151515',
      expectedMissionRevision: patchedDetailsView.revision,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 6,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'cancelled',
        pendingLineId: PENDING_LINE_ID,
        mission: { phase: 'awaiting_lines' },
        continuation: { outcome: 'empty', pendingLineId: null },
        presentation: { pendingLine: null, decision: null },
      },
    });
    await expect(handle.decideQuoteLineProposal({
      missionId: MISSION_ID,
      commandId: '12121212-1212-4212-8212-121212121212',
      expectedMissionRevision: proposalDecision.choiceSetRevision,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      decisionId: proposalDecision.decisionId,
      choiceSetRevision: proposalDecision.choiceSetRevision,
      choiceSetHash: proposalDecision.choiceSetHash,
      choiceId: EDIT_CHOICE_ID,
      pendingLineId: PENDING_LINE_ID,
      proposalId: PROPOSAL_ID,
      proposalRevision: 1,
      expectedWorkRevision: 4,
      expectedCatalogue: null,
      diffHash: 'b'.repeat(64),
    })).resolves.toMatchObject({
      ok: true,
      value: { outcome: 'edit_requested' },
    });
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
      '/agent-missions/current/quote-creation',
      `/agent-missions/${MISSION_ID}/screen-acks`,
      `/agent-missions/${MISSION_ID}/decisions`,
      `/agent-missions/${MISSION_ID}/quote-lines`,
      `/agent-missions/${MISSION_ID}/catalogue-choices`,
      `/agent-missions/${MISSION_ID}/quote-line-patches`,
      `/agent-missions/${MISSION_ID}/quote-line-cancellations`,
      `/agent-missions/${MISSION_ID}/quote-line-decisions`,
    ]);

    const beforeDispose = fetchMock.mock.calls.length;
    handle.dispose();
    await expect(handle.stageQuoteLines({
      missionId: MISSION_ID,
      commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expectedMissionRevision: 3,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      lines: [LINE],
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });
    await expect(handle.patchQuoteLine({
      missionId: MISSION_ID,
      commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      expectedMissionRevision: 7,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 4,
      scope: 'answer_required_fact',
      patch: {
        field: 'unit_price',
        decimal: '55',
        currency: 'EUR',
        basis: 'per_unit',
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });
    await expect(handle.cancelPendingQuoteLine({
      missionId: MISSION_ID,
      commandId: '15151515-1515-4515-8515-151515151515',
      expectedMissionRevision: patchedDetailsView.revision,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 6,
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(beforeDispose);
  });

  it('préserve explicitement null/null sans fabriquer de capability locale', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(nativeBootstrap({
      agentMissionProtocolVersion: null,
      agentMissionCapability: null,
    })), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().createRealtimeVoiceCall(nativeCallInput(null));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.hasOwn(result.value, 'agentMissionSession')).toBe(true);
    expect(result.value.agentMissionSession).toBeNull();
    expect(JSON.stringify(result.value)).not.toContain('agentMission');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const m2aDisabled = await client().createRealtimeVoiceCall(nativeCallInput(2));
    expect(m2aDisabled.ok).toBe(true);
    if (!m2aDisabled.ok) return;
    expect(m2aDisabled.value.agentMissionSession).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('échoue fermé et termine la session avant retour si le reçu durable est refusé', async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
          agentMissionCapability: CAPABILITY,
        })), { headers: { 'content-type': 'application/json' } });
      }
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        expect(init?.headers).toMatchObject({
          'x-bob-agent-mission-capability': CAPABILITY,
        });
        return new Response(JSON.stringify({
          error: { kind: 'forbidden', reason: 'agent_mission_bootstrap_receipt_rejected' },
        }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === `/voice/realtime/calls/${SESSION_ID}`) {
        expect(init?.method).toBe('DELETE');
        expect(init?.headers).not.toHaveProperty(
          'x-bob-agent-mission-capability',
        );
        return new Response(JSON.stringify({ ended: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().createRealtimeVoiceCall(nativeCallInput(1)),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'forbidden' },
    });
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
      `/voice/realtime/calls/${SESSION_ID}`,
    ]);
  });

  it('ne rejoue pas un reçu au contrat invalide et compense la session', async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
          agentMissionCapability: CAPABILITY,
        })), { headers: { 'content-type': 'application/json' } });
      }
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        return new Response(JSON.stringify({ acknowledged: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === `/voice/realtime/calls/${SESSION_ID}`) {
        return new Response(JSON.stringify({ ended: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().createRealtimeVoiceCall(nativeCallInput(1)),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
      `/voice/realtime/calls/${SESSION_ID}`,
    ]);
  });

  it('rejoue le même reçu après perte de réponse avant de construire le handle opaque', async () => {
    let receiptAttempts = 0;
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
          agentMissionCapability: CAPABILITY,
        })), { headers: { 'content-type': 'application/json' } });
      }
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        receiptAttempts += 1;
        if (receiptAttempts === 1) {
          throw new Error('réponse perdue après commit du reçu');
        }
        return new Response(JSON.stringify({
          acknowledged: true,
          replayed: true,
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().createRealtimeVoiceCall(nativeCallInput(1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(receiptAttempts).toBe(2);
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
    ]);
    expect(result.value.agentMissionSession?.disposed).toBe(false);
    result.value.agentMissionSession?.dispose();
  });

  it('ne rejoue pas après abort, annule physiquement l ACK et compense avant de rendre la main', async () => {
    const controller = new AbortController();
    const paths: string[] = [];
    let acknowledgementSignal: AbortSignal | null = null;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
          agentMissionCapability: CAPABILITY,
        })), { headers: { 'content-type': 'application/json' } });
      }
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        acknowledgementSignal = init?.signal ?? null;
        controller.abort();
        return new Response(JSON.stringify({
          acknowledged: true,
          replayed: false,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/voice/realtime/calls/${SESSION_ID}`) {
        return new Response(JSON.stringify({ ended: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().createRealtimeVoiceCall(nativeCallInput(1), controller.signal),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency' },
    });
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
      `/voice/realtime/calls/${SESSION_ID}`,
    ]);
    expect((acknowledgementSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(paths.filter((path) => (
      path === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
    ))).toHaveLength(1);
  });

  it('laisse au transport l’unique DELETE de bootstrap quand il en prend la propriété', async () => {
    const controller = new AbortController();
    const paths: string[] = [];
    const deleteBodies: unknown[] = [];
    const diagnostic = {
      version: 1 as const,
      terminationSource: 'policy' as const,
      lastSuccessfulCheckpoint: 'bootstrap_acknowledged' as const,
      closeReason: 'entitlement_revoked' as const,
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        expect(JSON.parse(String(init?.body))).not.toHaveProperty('bootstrapTerminationOwner');
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
          agentMissionCapability: CAPABILITY,
        })), { headers: { 'content-type': 'application/json' } });
      }
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        controller.abort();
        return new Response(JSON.stringify({
          acknowledged: true,
          replayed: false,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/voice/realtime/calls/${SESSION_ID}`) {
        deleteBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ended: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const bobClient = client();
    await expect(bobClient.createRealtimeVoiceCall({
      ...nativeCallInput(1),
      bootstrapTerminationOwner: 'transport',
    }, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency' },
    });
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
    ]);

    await expect(bobClient.hangupRealtimeVoiceCall(
      SESSION_ID,
      undefined,
      diagnostic,
    )).resolves.toEqual({ ok: true, value: { ended: true } });

    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
      `/voice/realtime/calls/${SESSION_ID}`,
    ]);
    expect(deleteBodies).toEqual([diagnostic]);
  });

  it('refuse la propriété transport sans handle UUID avant tout effet réseau', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { sessionHandle, ...callWithoutHandle } = nativeCallInput(1);
    expect(sessionHandle).toBe(SESSION_ID);

    await expect(client().createRealtimeVoiceCall({
      ...callWithoutHandle,
      bootstrapTerminationOwner: 'transport',
    })).resolves.toEqual({
      ok: false,
      error: {
        kind: 'validation',
        issues: [{
          field: 'bootstrapTerminationOwner',
          message: 'Seul un transport WebRTC lié à un handle UUID peut posséder la terminaison.',
        }],
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un signal transport déjà annulé interdit le POST avant tout effet réseau', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(client().createRealtimeVoiceCall({
      ...nativeCallInput(1),
      bootstrapTerminationOwner: 'transport',
    }, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'api',
        cause: 'Requête annulée.',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un abort transport pendant un token différé interdit durablement tout POST', async () => {
    const token = deferred<string | null>();
    const getToken = vi.fn(() => token.promise);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const bootstrap = client(getToken).createRealtimeVoiceCall({
      ...nativeCallInput(1),
      bootstrapTerminationOwner: 'transport',
    }, controller.signal);
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledOnce());
    controller.abort();

    await expect(bootstrap).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api', cause: 'Requête annulée.' },
    });
    token.resolve('supabase-jwt');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un abort transport pendant le POST attend sa réponse et ne démarre aucun ACK', async () => {
    const post = deferred<Response>();
    const paths: string[] = [];
    const fetchMock = vi.fn((url: unknown) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') return post.promise;
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    let settled = false;
    const bootstrap = client().createRealtimeVoiceCall({
      ...nativeCallInput(1),
      bootstrapTerminationOwner: 'transport',
    }, controller.signal).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(paths).toEqual(['/voice/realtime/calls']));
    controller.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    post.resolve(new Response(JSON.stringify(nativeBootstrap({
      agentMissionProtocolVersion: 1,
      agentMissionCapability: CAPABILITY,
    })), { headers: { 'content-type': 'application/json' } }));
    await expect(bootstrap).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api', cause: 'Requête annulée.' },
    });
    expect(paths).toEqual(['/voice/realtime/calls']);
  });

  it('le timeout transport reste borné et avorte le fetch même si le binding ne se règle pas', async () => {
    vi.useFakeTimers();
    const neverSettled = deferred<Response>();
    let networkSignal: AbortSignal | null = null;
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      networkSignal = init?.signal ?? null;
      return neverSettled.promise;
    });
    vi.stubGlobal('fetch', fetchMock);

    const bootstrap = client().createRealtimeVoiceCall({
      ...nativeCallInput(1),
      bootstrapTerminationOwner: 'transport',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(12_000);
    await expect(bootstrap).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'api',
        cause: 'Délai réseau dépassé après 12000 ms.',
      },
    });
    expect((networkSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('refuse un propriétaire de terminaison runtime inconnu avant tout effet réseau', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      ...nativeCallInput(1),
      bootstrapTerminationOwner: 'typo_runtime',
    } as unknown as Parameters<HttpBobClient['createRealtimeVoiceCall']>[0];

    await expect(client().createRealtimeVoiceCall(input)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'validation',
        issues: [{
          field: 'bootstrapTerminationOwner',
          message: 'Le propriétaire de terminaison du bootstrap est invalide.',
        }],
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('compense un bootstrap V1 mal formé avec le handle demandé', async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
        })), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/voice/realtime/calls/${SESSION_ID}`) {
        return new Response(JSON.stringify({ ended: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().createRealtimeVoiceCall(nativeCallInput(1)),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}`,
    ]);
  });

  it.each([
    ['réponse N+1 ajoutée à une demande omise', undefined, {
      agentMissionProtocolVersion: null,
      agentMissionCapability: null,
    }],
    ['paire absente après demande V1', 1, {}],
    ['capability absente', 1, { agentMissionProtocolVersion: 1 }],
    ['version absente', 1, { agentMissionCapability: CAPABILITY }],
    ['capability non canonique', 1, {
      agentMissionProtocolVersion: 1,
      agentMissionCapability: 'bam1_invalide',
    }],
    ['version inconnue', 1, {
      agentMissionProtocolVersion: 2,
      agentMissionCapability: CAPABILITY,
    }],
    ['réponse bam2 après demande V1', 1, {
      agentMissionProtocolVersion: 2,
      agentMissionCapability: CAPABILITY_V2,
    }],
    ['réponse V1 après demande V2', 2, {
      agentMissionProtocolVersion: 1,
      agentMissionCapability: CAPABILITY,
    }],
    ['capability bam1 avec version V2', 2, {
      agentMissionProtocolVersion: 2,
      agentMissionCapability: CAPABILITY,
    }],
    ['capability interdite après demande null', null, {
      agentMissionProtocolVersion: 1,
      agentMissionCapability: CAPABILITY,
    }],
  ] as const)('refuse toute négociation partielle ou discordante : %s', async (
    _label,
    requested,
    responseBinding,
  ) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(
      nativeBootstrap(responseBinding),
    ), { headers: { 'content-type': 'application/json' } })));

    const result = await client().createRealtimeVoiceCall(nativeCallInput(requested));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('refuse une propriété présente mais undefined avant token et réseau', async () => {
    const getToken = vi.fn(async () => 'supabase-jwt');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const input = {
      ...nativeCallInput(),
      agentMissionProtocolVersion: undefined,
    } as never;
    await expect(client(getToken).createRealtimeVoiceCall(input)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Contrats réseau M2-A exacts', () => {
  function commandFixtures() {
    const catalogueView = missionView(
      catalogueChoiceM2AMission(),
      '2026-07-26T08:04:00.000Z',
    );
    const resolvedView = missionView(
      resolvedM2AMission(),
      '2026-07-26T08:05:00.000Z',
    );
    const patchedDetailsView = missionView(
      patchedLineDetailsM2AMission(),
      '2026-07-26T08:08:00.000Z',
    );
    const editedView = missionView(
      editedLineM2AMission(),
      '2026-07-26T08:07:00.000Z',
    );
    return {
      stage: {
        outcome: 'staged',
        mission: catalogueView,
        stagedCount: 1,
        firstQueueOrdinal: 1,
        lastQueueOrdinal: 1,
        continuation: {
          outcome: 'choices_presented',
          pendingLineId: PENDING_LINE_ID,
          presentedChoiceCount: 2,
          requiredFact: null,
          proposalId: null,
        },
        presentation: cataloguePresentation(catalogueView),
      },
      catalogue: {
        outcome: 'selected',
        resolution: 'free',
        invalidationReason: null,
        mission: resolvedView,
        continuation: {
          outcome: 'deferred_to_m2a2',
          pendingLineId: PENDING_LINE_ID,
          presentedChoiceCount: 0,
          requiredFact: null,
          proposalId: null,
        },
        presentation: awaitingLinesPresentation(3),
      },
      patch: {
        outcome: 'patched',
        pendingLineId: PENDING_LINE_ID,
        workRevisionAfter: 5,
        mission: patchedDetailsView,
        continuation: {
          outcome: 'details_requested',
          pendingLineId: PENDING_LINE_ID,
          presentedChoiceCount: 0,
          requiredFact: 'vat_rate',
          proposalId: null,
        },
        presentation: lineDetailsPresentation(6, 'vat_rate'),
      },
      decision: {
        outcome: 'edit_requested',
        invalidationReason: null,
        mission: editedView,
        continuation: {
          outcome: 'stable',
          pendingLineId: null,
          presentedChoiceCount: 0,
          requiredFact: null,
          proposalId: null,
        },
        presentation: lineDetailsPresentation(5, null),
      },
    };
  }

  it('accepte les quatre réponses serveur complètes', () => {
    const wire = commandFixtures();
    expect(decodeAgentMissionStageQuoteLines(wire.stage, MISSION_ID)).toEqual(
      wire.stage,
    );
    expect(decodeAgentMissionCatalogueChoice(wire.catalogue, MISSION_ID)).toEqual(
      wire.catalogue,
    );
    expect(decodeAgentMissionPatchQuoteLine(wire.patch, MISSION_ID)).toEqual(
      wire.patch,
    );
    expect(
      decodeAgentMissionLineProposalDecision(wire.decision, MISSION_ID),
    ).toEqual(wire.decision);
  });

  it('refuse les clés ajoutées et les continuations contradictoires', () => {
    const wire = commandFixtures();
    expect(decodeAgentMissionStageQuoteLines({
      ...wire.stage,
      companyId: 'forged',
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionCatalogueChoice({
      ...wire.catalogue,
      presentation: {
        ...wire.catalogue.presentation,
        internalWork: 'forbidden',
      },
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionPatchQuoteLine({
      ...wire.patch,
      continuation: {
        ...wire.patch.continuation,
        proposalId: PROPOSAL_ID,
      },
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionLineProposalDecision({
      ...wire.decision,
      invalidationReason: 'choice_set_stale',
    }, MISSION_ID)).toBeNull();
  });
});
