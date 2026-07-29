import type {
  AgentMissionFingerprintPort,
  AgentMissionOwner,
  AgentMissionReadTransaction,
  AgentMissionRealtimeAuthorityProof,
  AgentMissionTransaction,
  AgentMissionUnitOfWorkPort,
} from '@bob/core';
import {
  AcknowledgeQuoteScreen,
  AdvanceQuoteAgentMission,
  AgentMission,
  toAgentMissionView,
} from '@bob/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../observability/logger';
import type { Metrics } from '../observability/metrics';
import type { Persistence } from '../persistence/persistence';
import type { AgentMissionHttpAuthorization } from './agent-mission-http-authority';
import { AgentMissionService } from './agent-mission.service';

const OWNER = Object.freeze({
  companyId: 'company-1',
  ownerUserId: 'owner-1',
});
const PROOF = Object.freeze({
  subjectHashCandidates: Object.freeze(['a'.repeat(64)]),
  principalBindingHash: 'b'.repeat(64),
  capabilityHash: 'c'.repeat(64),
}) satisfies AgentMissionRealtimeAuthorityProof;
const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign: () => null,
  matches: () => null,
};
const MISSION_ID = '20000000-0000-4000-8000-000000000001';
const REALTIME_SESSION_ID = '30000000-0000-4000-8000-000000000001';
const ACK_COMMAND_ID = '10000000-0000-4000-8000-000000000003';
const NOW = '2026-07-29T00:00:00.000Z';

function continuationFixtures() {
  const started = AgentMission.start({
    id: MISSION_ID,
    ...OWNER,
    createdAt: NOW,
    stagedCustomerResolution: {
      kind: 'exact',
      customerId: 'customer-camping',
    },
    startOutcome: 'no_slot',
    draft: {
      sessionId: 'quote-draft-session-1',
      slotRevision: 1,
      contentRevision: 0,
    },
  });
  if (!started.ok) {
    throw new Error(`fixture start invalide:${JSON.stringify(started.error)}`);
  }
  const acknowledged = started.value.mission.acknowledgeQuoteScreen({
    expectedRevision: 1,
    binding: {
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      screenName: '/devis/new',
      screenInstanceId: 'quote-screen-1',
      acknowledgedAt: NOW,
    },
    observedDraft: {
      sessionId: 'quote-draft-session-1',
      slotRevision: 1,
      contentRevision: 0,
    },
    draftHasCustomer: false,
    occurredAt: NOW,
  });
  if (!acknowledged.ok) {
    throw new Error(`fixture ACK invalide:${acknowledged.error.code}`);
  }
  const advanced = acknowledged.value.mission.consumeStagedCustomerResolution({
    expectedRevision: 2,
    outcome: 'select_exact',
    customerId: 'customer-camping',
    updatedDraft: {
      sessionId: 'quote-draft-session-1',
      slotRevision: 2,
      contentRevision: 1,
    },
    occurredAt: NOW,
  });
  if (!advanced.ok) {
    throw new Error(`fixture Advance invalide:${advanced.error.code}`);
  }
  const acknowledgedView = toAgentMissionView(acknowledged.value.mission, NOW);
  const advancedView = toAgentMissionView(advanced.value.mission, NOW);
  if (!acknowledgedView.ok || !advancedView.ok) {
    throw new Error('fixture AgentMissionView invalide');
  }
  return {
    acknowledgedView: acknowledgedView.value,
    advancedView: advancedView.value,
    receipt: {
      ackCommandId: ACK_COMMAND_ID,
      missionId: MISSION_ID,
      missionRevisionAfter: 2,
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      occurredAt: NOW,
    },
  };
}

function authorization(
  operation: AgentMissionHttpAuthorization['operation'],
): AgentMissionHttpAuthorization {
  return Object.freeze({ operation, owner: OWNER, proof: PROOF });
}

class RejectingUnitOfWork implements AgentMissionUnitOfWorkPort {
  constructor(
    private readonly reason:
      | 'malformed'
      | 'not_found'
      | 'ambiguous'
      | 'expired'
      | 'state'
      | 'hash_mismatch',
  ) {}

  async readQuoteCreationOwner<T>(
    _owner: AgentMissionOwner,
    _authority: AgentMissionRealtimeAuthorityProof,
    _work: (transaction: AgentMissionReadTransaction) => Promise<T>,
  ) {
    return { status: 'capability_rejected' as const, reason: this.reason };
  }

  async runQuoteCreationOwner<T>(
    _owner: AgentMissionOwner,
    _authority: AgentMissionRealtimeAuthorityProof,
    _work: (transaction: AgentMissionTransaction) => Promise<T>,
  ) {
    return { status: 'capability_rejected' as const, reason: this.reason };
  }
}

function harness(unitOfWork: AgentMissionUnitOfWorkPort | null) {
  const capabilityInc = vi.fn();
  const screenAckInc = vi.fn();
  const metrics = {
    agentMissionCapabilityRejections: { inc: capabilityInc },
    agentMissionScreenAcks: { inc: screenAckInc },
  } as unknown as Metrics;
  const persistence = {
    createAgentMissionUnitOfWork: vi.fn(() => unitOfWork),
  } as unknown as Persistence;
  const service = new AgentMissionService(
    persistence,
    FINGERPRINTS,
    { audit: vi.fn() } as unknown as AppLogger,
    metrics,
  );
  return { service, capabilityInc, screenAckInc };
}

describe('AgentMissionService metrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      'get',
      'expired',
      (service: AgentMissionService) =>
        service.getCurrent(authorization('get_current_quote_creation')),
    ],
    [
      'start',
      'not_found',
      (service: AgentMissionService) => service.start({
        authorization: authorization('start_quote_creation'),
        commandId: '10000000-0000-4000-8000-000000000001',
      }),
    ],
    [
      'cancel',
      'ambiguous',
      (service: AgentMissionService) => service.cancel({
        authorization: authorization('cancel_quote_creation'),
        missionId: '20000000-0000-4000-8000-000000000001',
        commandId: '10000000-0000-4000-8000-000000000002',
        expectedMissionRevision: 1,
      }),
    ],
  ] as const)(
    'conserve la raison %s uniquement dans la métrique bornée',
    async (operation, reason, invoke) => {
      const { service, capabilityInc, screenAckInc } = harness(
        new RejectingUnitOfWork(reason),
      );

      await expect(invoke(service)).resolves.toEqual({
        ok: false,
        error: { kind: 'forbidden', reason: 'agent_mission_capability_invalid' },
      });
      expect(capabilityInc).toHaveBeenCalledOnce();
      expect(capabilityInc).toHaveBeenCalledWith({ operation, reason });
      expect(screenAckInc).not.toHaveBeenCalled();
    },
  );

  it('mesure séparément le rejet capability et le résultat public d’un screen ACK', async () => {
    const { service, capabilityInc, screenAckInc } = harness(
      new RejectingUnitOfWork('hash_mismatch'),
    );

    await expect(service.acknowledgeScreen({
      authorization: authorization('acknowledge_quote_screen'),
      missionId: '20000000-0000-4000-8000-000000000001',
      commandId: '10000000-0000-4000-8000-000000000003',
      expectedMissionRevision: 1,
      realtimeSessionId: '30000000-0000-4000-8000-000000000001',
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      draftSessionId: 'draft-session-1',
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
    })).resolves.toEqual({
      ok: false,
      error: { kind: 'forbidden', reason: 'agent_mission_capability_invalid' },
    });
    expect(capabilityInc).toHaveBeenCalledWith({
      operation: 'screen_ack',
      reason: 'hash_mismatch',
    });
    expect(screenAckInc).toHaveBeenCalledWith({ outcome: 'conflict' });
  });

  it('mesure indisponible sans inventer une raison capability quand la persistence manque', async () => {
    const { service, capabilityInc, screenAckInc } = harness(null);

    await expect(service.acknowledgeScreen({
      authorization: authorization('acknowledge_quote_screen'),
      missionId: '20000000-0000-4000-8000-000000000001',
      commandId: '10000000-0000-4000-8000-000000000004',
      expectedMissionRevision: 1,
      realtimeSessionId: '30000000-0000-4000-8000-000000000001',
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      draftSessionId: 'draft-session-1',
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
    })).resolves.toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'agent_mission_persistence' },
    });
    expect(capabilityInc).not.toHaveBeenCalled();
    expect(screenAckInc).toHaveBeenCalledWith({ outcome: 'unavailable' });
  });

  it('n’acquitte pas HTTP avant la continuation durable post-ACK', async () => {
    const fixtures = continuationFixtures();
    vi.spyOn(AcknowledgeQuoteScreen.prototype, 'execute').mockResolvedValue({
      ok: true,
      value: {
        outcome: 'acknowledged',
        receipt: fixtures.receipt,
        mission: fixtures.acknowledgedView,
      },
    });
    let resolveAdvance:
      | ((value: Awaited<ReturnType<AdvanceQuoteAgentMission['execute']>>) => void)
      | undefined;
    vi.spyOn(AdvanceQuoteAgentMission.prototype, 'execute').mockImplementation(
      () => new Promise((resolve) => {
        resolveAdvance = resolve;
      }),
    );
    const { service, screenAckInc } = harness(
      new RejectingUnitOfWork('state'),
    );
    const response = service.acknowledgeScreen({
      authorization: authorization('acknowledge_quote_screen'),
      missionId: MISSION_ID,
      commandId: ACK_COMMAND_ID,
      expectedMissionRevision: 1,
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      draftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
    });
    let settled = false;
    void response.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(resolveAdvance).toBeTypeOf('function');

    resolveAdvance?.({
      ok: true,
      value: {
        outcome: 'advanced',
        mission: fixtures.advancedView,
      },
    });

    await expect(response).resolves.toEqual({
      ok: true,
      value: {
        outcome: 'acknowledged',
        receipt: fixtures.receipt,
        mission: fixtures.advancedView,
      },
    });
    expect(AdvanceQuoteAgentMission.prototype.execute).toHaveBeenCalledWith({
      ...OWNER,
      authority: PROOF,
      missionId: MISSION_ID,
      acknowledgementCommandId: ACK_COMMAND_ID,
    });
    expect(screenAckInc).toHaveBeenCalledOnce();
    expect(screenAckInc).toHaveBeenCalledWith({ outcome: 'accepted' });
  });
});
