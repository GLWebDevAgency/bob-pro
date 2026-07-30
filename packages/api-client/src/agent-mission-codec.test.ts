import { describe, expect, it } from 'vitest';
import {
  AgentMission,
  toAgentMissionView,
  type AgentMissionViewV1,
} from '@bob/core';
import {
  decodeAgentMissionCatalogueChoice,
  decodeAgentMissionDecision,
  decodeAgentMissionDecisionV2,
  decodeAgentMissionScreenAck,
  decodeAgentMissionStageQuoteLines,
  decodeAgentMissionStart,
  decodeAgentMissionViewV1,
  decodeAgentMissionViewV2,
} from './agent-mission-codec';

const CREATED_AT = '2026-07-26T08:00:00.000Z';
const ACKNOWLEDGED_AT = '2026-07-26T08:01:00.000Z';
const CANCELLED_AT = '2026-07-26T08:02:00.000Z';
const MISSION_ID = '11111111-1111-4111-8111-111111111111';
const REALTIME_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ACK_COMMAND_ID = '55555555-5555-4555-8555-555555555555';
const DRAFT = Object.freeze({
  sessionId: 'quote-draft-session-1',
  slotRevision: 1,
  contentRevision: 0,
});
const M2A_PENDING_LINE_ID = '33333333-3333-4333-8333-333333333333';
const M2A_DECISION_ID = '44444444-4444-4444-8444-444444444444';
const M2A_CANDIDATE_CHOICE_ID = '66666666-6666-4666-8666-666666666666';
const M2A_FREE_CHOICE_ID = '77777777-7777-4777-8777-777777777777';

function initialMission() {
  const started = AgentMission.start({
    id: MISSION_ID,
    companyId: 'company-1',
    ownerUserId: 'user-1',
    createdAt: CREATED_AT,
    stagedCustomerResolution: null,
    startOutcome: 'no_slot',
    draft: DRAFT,
  });
  if (!started.ok) throw new Error(`Mission fixture invalide: ${started.error.code}`);
  return started.value.mission;
}

function receipt() {
  return {
    ackCommandId: ACK_COMMAND_ID,
    missionId: MISSION_ID,
    missionRevisionAfter: 2,
    realtimeSessionId: REALTIME_SESSION_ID,
    contextRevision: 1,
    contextDigest: 'a'.repeat(64),
    occurredAt: ACKNOWLEDGED_AT,
  };
}

function viewAt(
  mission: AgentMission,
  databaseNow: string,
): AgentMissionViewV1 {
  const view = toAgentMissionView(mission, databaseNow);
  if (!view.ok) throw new Error(`Vue fixture invalide: ${view.error.kind}`);
  return view.value;
}

function acknowledgedMission() {
  const acknowledged = initialMission().acknowledgeQuoteScreen({
    expectedRevision: 1,
    binding: {
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
      contextDigest: 'a'.repeat(64),
      screenName: '/devis/new',
      screenInstanceId: 'quote-screen-1',
      acknowledgedAt: ACKNOWLEDGED_AT,
    },
    observedDraft: DRAFT,
    draftHasCustomer: false,
    occurredAt: ACKNOWLEDGED_AT,
  });
  if (!acknowledged.ok) {
    throw new Error(`ACK fixture invalide: ${acknowledged.error.code}`);
  }
  return acknowledged.value.mission;
}

function selectedMission() {
  const selected = acknowledgedMission().selectCustomer({
    expectedRevision: 2,
    source: 'screen_selection',
    customerId: 'customer-camping',
    updatedDraft: {
      sessionId: DRAFT.sessionId,
      slotRevision: 2,
      contentRevision: 1,
    },
    occurredAt: CANCELLED_AT,
  });
  if (!selected.ok) {
    throw new Error(`Sélection fixture invalide: ${selected.error.code}`);
  }
  return selected.value.mission;
}

function selectedM2AMission() {
  const started = AgentMission.start({
    id: MISSION_ID,
    companyId: 'company-1',
    ownerUserId: 'user-1',
    protocolVersion: 2,
    createdAt: CREATED_AT,
    stagedCustomerResolution: null,
    startOutcome: 'no_slot',
    draft: DRAFT,
  });
  if (!started.ok) throw new Error(`Mission M2-A invalide: ${started.error.code}`);
  const acknowledged = started.value.mission.acknowledgeQuoteScreen({
    expectedRevision: 1,
    binding: {
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
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
    occurredAt: CANCELLED_AT,
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
    decisionId: M2A_DECISION_ID,
    pendingLineId: M2A_PENDING_LINE_ID,
    expectedWorkRevision: 2,
    expectedDraft: {
      sessionId: DRAFT.sessionId,
      slotRevision: 2,
      contentRevision: 1,
    },
    candidates: [{
      choiceId: M2A_CANDIDATE_CHOICE_ID,
      catalogueItemId: 'catalogue-main-oeuvre',
      expectedCatalogueRevision: 1,
    }],
    freeLineChoiceId: M2A_FREE_CHOICE_ID,
    occurredAt: '2026-07-26T08:04:00.000Z',
  });
  if (!presented.ok) {
    throw new Error(`Choix M2-A invalide: ${presented.error.code}`);
  }
  return presented.value.mission;
}

function resolvedM2AMission() {
  const resolved = catalogueChoiceM2AMission().selectCatalogueChoice({
    expectedRevision: 5,
    decisionId: M2A_DECISION_ID,
    choiceSetRevision: 5,
    choiceId: M2A_FREE_CHOICE_ID,
    pendingLineId: M2A_PENDING_LINE_ID,
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

describe('AgentMission HTTP codecs', () => {
  it('accepte les deux formes de replay start et conserve la vue autoritaire courante', () => {
    const advancedView = viewAt(acknowledgedMission(), ACKNOWLEDGED_AT);

    expect(decodeAgentMissionStart({
      outcome: 'replayed',
      startOutcome: null,
      mission: advancedView,
    })).toEqual({
      outcome: 'replayed',
      startOutcome: null,
      mission: advancedView,
    });
    expect(decodeAgentMissionStart({
      outcome: 'replayed',
      startOutcome: 'no_slot',
      mission: advancedView,
    })).toEqual({
      outcome: 'replayed',
      startOutcome: 'no_slot',
      mission: advancedView,
    });
  });

  it('lie un start créé à sa phase initiale et un join à une mission active', () => {
    const initialView = viewAt(initialMission(), CREATED_AT);
    const advancedView = viewAt(acknowledgedMission(), ACKNOWLEDGED_AT);
    const cancelled = acknowledgedMission().cancel({
      expectedRevision: 2,
      reason: 'user_cancelled',
      occurredAt: CANCELLED_AT,
    });
    if (!cancelled.ok) throw new Error(`Cancel fixture invalide: ${cancelled.error.code}`);
    const cancelledView = viewAt(cancelled.value.mission, CANCELLED_AT);

    expect(decodeAgentMissionStart({
      outcome: 'created',
      startOutcome: 'no_slot',
      mission: initialView,
    })).not.toBeNull();
    expect(decodeAgentMissionStart({
      outcome: 'created',
      startOutcome: 'no_slot',
      mission: advancedView,
    })).toBeNull();
    expect(decodeAgentMissionStart({
      outcome: 'joined_active',
      startOutcome: null,
      mission: advancedView,
    })).not.toBeNull();
    expect(decodeAgentMissionStart({
      outcome: 'joined_active',
      startOutcome: null,
      mission: cancelledView,
    })).toBeNull();
  });

  it('exige le binding post-écran seulement pour un ACK neuf, pas pour sa vue rejouée', () => {
    const activeView = viewAt(acknowledgedMission(), ACKNOWLEDGED_AT);
    const cancelled = acknowledgedMission().cancel({
      expectedRevision: 2,
      reason: 'user_cancelled',
      occurredAt: CANCELLED_AT,
    });
    if (!cancelled.ok) throw new Error(`Cancel fixture invalide: ${cancelled.error.code}`);
    const cancelledView = viewAt(cancelled.value.mission, CANCELLED_AT);

    expect(decodeAgentMissionScreenAck({
      outcome: 'acknowledged',
      receipt: receipt(),
      mission: activeView,
    })).not.toBeNull();
    expect(decodeAgentMissionScreenAck({
      outcome: 'acknowledged',
      receipt: receipt(),
      mission: viewAt(initialMission(), CREATED_AT),
    })).toBeNull();
    expect(decodeAgentMissionScreenAck({
      outcome: 'acknowledged',
      receipt: receipt(),
      mission: cancelledView,
    })).toBeNull();
    expect(decodeAgentMissionScreenAck({
      outcome: 'replayed',
      receipt: receipt(),
      mission: cancelledView,
    })).toEqual({
      outcome: 'replayed',
      receipt: receipt(),
      mission: cancelledView,
    });
    expect(decodeAgentMissionScreenAck({
      outcome: 'replayed',
      receipt: { ...receipt(), missionId: '99999999-9999-4999-8999-999999999999' },
      mission: cancelledView,
    })).toBeNull();
  });

  it('décode les effets exacts d’une décision et lie la réponse à la mission demandée', () => {
    const awaitingCustomer = viewAt(acknowledgedMission(), ACKNOWLEDGED_AT);
    const selected = viewAt(selectedMission(), CANCELLED_AT);

    expect(decodeAgentMissionDecision({
      outcome: 'selected',
      effect: { kind: 'selected' },
      mission: selected,
    }, MISSION_ID)).toEqual({
      outcome: 'selected',
      effect: { kind: 'selected' },
      mission: selected,
    });
    expect(decodeAgentMissionDecision({
      outcome: 'invalidated',
      effect: { kind: 'invalidated', reason: 'candidate_unavailable' },
      mission: awaitingCustomer,
    }, MISSION_ID)).toEqual({
      outcome: 'invalidated',
      effect: { kind: 'invalidated', reason: 'candidate_unavailable' },
      mission: awaitingCustomer,
    });
    expect(decodeAgentMissionDecision({
      outcome: 'replayed',
      effect: { kind: 'invalidated', reason: 'choice_set_stale' },
      mission: awaitingCustomer,
    }, MISSION_ID)).toEqual({
      outcome: 'replayed',
      effect: { kind: 'invalidated', reason: 'choice_set_stale' },
      mission: awaitingCustomer,
    });
    expect(decodeAgentMissionDecision({
      outcome: 'replayed',
      mission: awaitingCustomer,
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionDecision({
      outcome: 'replayed',
      effect: { kind: 'presented', candidateCount: 2 },
      mission: awaitingCustomer,
    }, MISSION_ID)).toBeNull();

    expect(decodeAgentMissionDecision({
      outcome: 'selected',
      effect: { kind: 'selected' },
      mission: awaitingCustomer,
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionDecision({
      outcome: 'invalidated',
      effect: { kind: 'invalidated', reason: 'candidate_unavailable' },
      mission: selected,
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionDecision({
      outcome: 'selected',
      effect: { kind: 'selected' },
      mission: selected,
    }, '99999999-9999-4999-8999-999999999999')).toBeNull();
    expect(decodeAgentMissionDecision({
      outcome: 'selected',
      mission: selected,
      extra: true,
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionDecision({
      outcome: 'unknown',
      mission: selected,
    }, MISSION_ID)).toBeNull();
  });

  it('isole strictement les vues V1 et V2 sans élargir le wire historique', () => {
    const commonM2AView = viewAt(selectedM2AMission(), CANCELLED_AT);
    const catalogueM2AView = viewAt(
      catalogueChoiceM2AMission(),
      '2026-07-26T08:04:00.000Z',
    );

    expect(commonM2AView).not.toHaveProperty('protocolVersion');
    // Une phase commune reste byte-for-byte lisible par N-1 ; l'autorité serveur empêche seule
    // qu'une mission V2 soit projetée dans sa session bam1.
    expect(decodeAgentMissionViewV1(commonM2AView)).toEqual(commonM2AView);
    expect(decodeAgentMissionViewV2(commonM2AView)).toEqual(commonM2AView);
    expect(decodeAgentMissionViewV1(catalogueM2AView)).toBeNull();
    expect(decodeAgentMissionViewV2(catalogueM2AView)).toEqual(catalogueM2AView);
    expect(decodeAgentMissionViewV2({
      ...catalogueM2AView,
      protocolVersion: 2,
    })).toBeNull();
  });

  it('décode le staging M2-A avec ordinals et continuation cohérents', () => {
    const mission = viewAt(
      catalogueChoiceM2AMission(),
      '2026-07-26T08:04:00.000Z',
    );
    const wire = {
      outcome: 'staged',
      mission,
      stagedCount: 1,
      firstQueueOrdinal: 1,
      lastQueueOrdinal: 1,
      continuation: {
        outcome: 'choices_presented',
        pendingLineId: M2A_PENDING_LINE_ID,
        presentedChoiceCount: 2,
      },
    };
    expect(decodeAgentMissionStageQuoteLines(wire, MISSION_ID)).toEqual(wire);
    expect(decodeAgentMissionStageQuoteLines({
      ...wire,
      lastQueueOrdinal: 2,
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionStageQuoteLines({
      ...wire,
      continuation: {
        ...wire.continuation,
        presentedChoiceCount: 1,
      },
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionStageQuoteLines({
      ...wire,
      extra: true,
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionStageQuoteLines(
      wire,
      '99999999-9999-4999-8999-999999999999',
    )).toBeNull();
  });

  it('ferme les couples résultat/résolution du choix catalogue M2-A', () => {
    const mission = viewAt(
      resolvedM2AMission(),
      '2026-07-26T08:05:00.000Z',
    );
    const wire = {
      outcome: 'selected',
      resolution: 'free',
      invalidationReason: null,
      mission,
      continuation: {
        outcome: 'deferred_to_m2a2',
        pendingLineId: M2A_PENDING_LINE_ID,
        presentedChoiceCount: 0,
      },
    };
    expect(decodeAgentMissionCatalogueChoice(wire, MISSION_ID)).toEqual(wire);
    expect(decodeAgentMissionCatalogueChoice({
      ...wire,
      invalidationReason: 'choice_set_stale',
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionCatalogueChoice({
      ...wire,
      outcome: 'invalidated',
      resolution: null,
      invalidationReason: 'candidate_unavailable',
    }, MISSION_ID)).not.toBeNull();
    expect(decodeAgentMissionCatalogueChoice({
      ...wire,
      outcome: 'replayed',
      resolution: null,
      invalidationReason: null,
    }, MISSION_ID)).toBeNull();
  });

  it('autorise une décision client V2 à converger directement vers le choix catalogue', () => {
    const mission = viewAt(
      catalogueChoiceM2AMission(),
      '2026-07-26T08:04:00.000Z',
    );
    expect(decodeAgentMissionDecision({
      outcome: 'selected',
      effect: { kind: 'selected' },
      mission,
    }, MISSION_ID)).toBeNull();
    expect(decodeAgentMissionDecisionV2({
      outcome: 'selected',
      effect: { kind: 'selected' },
      mission,
    }, MISSION_ID)).not.toBeNull();
  });
});
