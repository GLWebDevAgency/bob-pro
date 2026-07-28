import { describe, expect, it } from 'vitest';
import {
  AgentMission,
  toAgentMissionView,
  type AgentMissionViewV1,
} from '@bob/core';
import {
  decodeAgentMissionScreenAck,
  decodeAgentMissionStart,
} from './agent-mission-codec';

const CREATED_AT = '2026-07-26T08:00:00.000Z';
const ACKNOWLEDGED_AT = '2026-07-26T08:01:00.000Z';
const CANCELLED_AT = '2026-07-26T08:02:00.000Z';
const MISSION_ID = '11111111-1111-4111-8111-111111111111';
const REALTIME_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const DRAFT = Object.freeze({
  sessionId: 'quote-draft-session-1',
  slotRevision: 1,
  contentRevision: 0,
});

function initialMission() {
  const started = AgentMission.start({
    id: MISSION_ID,
    companyId: 'company-1',
    ownerUserId: 'user-1',
    createdAt: CREATED_AT,
    startOutcome: 'no_slot',
    draft: DRAFT,
  });
  if (!started.ok) throw new Error(`Mission fixture invalide: ${started.error.code}`);
  return started.value.mission;
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
      mission: activeView,
    })).not.toBeNull();
    expect(decodeAgentMissionScreenAck({
      outcome: 'acknowledged',
      mission: viewAt(initialMission(), CREATED_AT),
    })).toBeNull();
    expect(decodeAgentMissionScreenAck({
      outcome: 'acknowledged',
      mission: cancelledView,
    })).toBeNull();
    expect(decodeAgentMissionScreenAck({
      outcome: 'replayed',
      mission: cancelledView,
    })).toEqual({
      outcome: 'replayed',
      mission: cancelledView,
    });
  });
});
