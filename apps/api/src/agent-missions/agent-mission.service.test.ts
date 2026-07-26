import type {
  AgentMissionFingerprintPort,
  AgentMissionOwner,
  AgentMissionReadTransaction,
  AgentMissionRealtimeAuthorityProof,
  AgentMissionTransaction,
  AgentMissionUnitOfWorkPort,
} from '@bob/core';
import { describe, expect, it, vi } from 'vitest';
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
});
