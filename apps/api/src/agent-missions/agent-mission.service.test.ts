import type {
  AgentMissionFingerprintPort,
  AgentMissionOwner,
  AgentMissionReadTransaction,
  AgentMissionResumeReadTransaction,
  AgentMissionResumeUnitOfWorkPort,
  AgentMissionRealtimeAuthorityProof,
  AgentMissionTransaction,
  AgentMissionUnitOfWorkPort,
  AgentMissionViewV1,
} from '@bob/core';
import {
  AcknowledgeQuoteScreen,
  AdvanceQuoteAgentMission,
  AgentMission,
  ContinueQuoteAgentMissionLineQueue,
  DecideQuoteAgentMissionCatalogueChoice,
  DecideQuoteAgentMission,
  StageQuoteAgentMissionLines,
  StartQuoteAgentMission,
  toAgentMissionView,
} from '@bob/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestContext, type AppLogger } from '../observability/logger';
import type { Metrics } from '../observability/metrics';
import type { Persistence } from '../persistence/persistence';
import type { AgentMissionHttpAuthorization } from './agent-mission-http-authority';
import { AgentMissionService } from './agent-mission.service';

const OWNER = Object.freeze({
  companyId: 'company-1',
  ownerUserId: 'owner-1',
});
const PROOF = Object.freeze({
  protocolVersion: 1,
  subjectHashCandidates: Object.freeze(['a'.repeat(64)]),
  principalBindingHash: 'b'.repeat(64),
  capabilityHash: 'c'.repeat(64),
}) satisfies AgentMissionRealtimeAuthorityProof;
const PROOF_V2 = Object.freeze({
  ...PROOF,
  protocolVersion: 2,
}) satisfies AgentMissionRealtimeAuthorityProof;
const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign: () => null,
  matches: () => null,
};
const MISSION_ID = '20000000-0000-4000-8000-000000000001';
const REALTIME_SESSION_ID = '30000000-0000-4000-8000-000000000001';
const ACK_COMMAND_ID = '10000000-0000-4000-8000-000000000003';
const NOW = '2026-07-29T00:00:00.000Z';
const LINE = Object.freeze({
  serviceReference: 'Main-d’œuvre plomberie',
  categoryHint: 'labor',
  quantityDecimal: '2',
  unitReference: 'heure',
  unitPriceDecimal: '55',
  currency: 'EUR',
  priceBasis: 'per_unit',
  vatRateHint: null,
});

function m2aView(
  phase: AgentMissionViewV1['phase'],
  revision: number,
): AgentMissionViewV1 {
  return {
    id: MISSION_ID,
    kind: 'quote_creation',
    status: 'active',
    actionable: true,
    phase,
    revision,
    payloadVersion: 1,
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: {
        sessionId: 'quote-draft-session-1',
        slotRevision: 2,
        contentRevision: 1,
      },
      decision: null,
      stagedCustomerResolution: null,
    },
    currentBinding: {
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      screenName: '/devis/new',
      screenInstanceId: 'quote-screen-1',
      acknowledgedAt: NOW,
    },
    idleExpiresAt: '2026-07-30T00:00:00.000Z',
    hardExpiresAt: '2026-08-05T00:00:00.000Z',
    terminalAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

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

function authorizationV2(
  operation: AgentMissionHttpAuthorization['operation'],
): AgentMissionHttpAuthorization {
  return Object.freeze({ operation, owner: OWNER, proof: PROOF_V2 });
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

class ForegroundUnavailableUnitOfWork implements AgentMissionUnitOfWorkPort {
  async readQuoteCreationOwner<T>(
    _owner: AgentMissionOwner,
    _authority: AgentMissionRealtimeAuthorityProof,
    _work: (transaction: AgentMissionReadTransaction) => Promise<T>,
  ) {
    return { status: 'capability_rejected' as const, reason: 'state' as const };
  }

  async runQuoteCreationOwner<T>(
    _owner: AgentMissionOwner,
    _authority: AgentMissionRealtimeAuthorityProof,
    _work: (transaction: AgentMissionTransaction) => Promise<T>,
  ) {
    return {
      status: 'foreground_unavailable' as const,
      reason: 'lock_timeout' as const,
    };
  }
}

function harness(
  unitOfWork: AgentMissionUnitOfWorkPort | null,
  resumeUnitOfWork: AgentMissionResumeUnitOfWorkPort | null = null,
) {
  const capabilityInc = vi.fn();
  const foregroundInc = vi.fn();
  const screenAckInc = vi.fn();
  const metrics = {
    agentMissionCapabilityRejections: { inc: capabilityInc },
    agentMissionForegroundContentions: { inc: foregroundInc },
    agentMissionScreenAcks: { inc: screenAckInc },
  } as unknown as Metrics;
  const persistence = {
    createAgentMissionUnitOfWork: vi.fn(() => unitOfWork),
    createAgentMissionResumeUnitOfWork: vi.fn(() => resumeUnitOfWork),
  } as unknown as Persistence;
  const logger = {
    audit: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  } as unknown as AppLogger;
  const service = new AgentMissionService(
    persistence,
    FINGERPRINTS,
    logger,
    metrics,
  );
  return {
    service,
    capabilityInc,
    foregroundInc,
    screenAckInc,
    persistence,
    logger,
  };
}

class ResumeNullUnitOfWork implements AgentMissionResumeUnitOfWorkPort {
  readonly owners: AgentMissionOwner[] = [];

  async readQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionResumeReadTransaction) => Promise<T>,
  ) {
    this.owners.push(owner);
    return {
      status: 'executed' as const,
      value: await work({
        databaseNow: async () => NOW,
        missions: {
          findActive: async () => null,
          findForeground: async () => null,
        },
        quoteDrafts: { get: async () => null },
        customers: { findByIds: async () => [] },
      }),
    };
  }
}

describe('AgentMissionService metrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dérive la reprise froide du principal JWT sans capability ni identité appelante', async () => {
    const resume = new ResumeNullUnitOfWork();
    const { service } = harness(null, resume);

    const result = await requestContext.run(
      {
        correlationId: 'resume-owner-test',
        principal: { userId: OWNER.ownerUserId, companyId: OWNER.companyId },
      },
      () => service.getCurrentResume(),
    );

    expect(result).toEqual({ ok: true, value: { mission: null } });
    expect(resume.owners).toEqual([OWNER]);
  });

  it('refuse la reprise sans principal avant toute factory de persistance', async () => {
    const resume = new ResumeNullUnitOfWork();
    const { service, persistence } = harness(null, resume);

    await expect(service.getCurrentResume()).resolves.toEqual({
      ok: false,
      error: { kind: 'forbidden', reason: 'authenticated_owner_required' },
    });
    expect(persistence.createAgentMissionResumeUnitOfWork).not.toHaveBeenCalled();
  });

  it('convertit une panne du snapshot froid en indisponibilité sans faux mission:null', async () => {
    const resume: AgentMissionResumeUnitOfWorkPort = {
      readQuoteCreationOwner: async () => {
        throw new Error('sensitive database detail');
      },
    };
    const { service, logger } = harness(null, resume);

    const result = await requestContext.run(
      {
        correlationId: 'resume-failure-test',
        principal: { userId: OWNER.ownerUserId, companyId: OWNER.companyId },
      },
      () => service.getCurrentResume(),
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'agent_mission_resume_persistence' },
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Lecture de reprise AgentMission impossible (Error).',
      undefined,
      'AgentMissionService',
    );
    expect(JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls))
      .not.toContain('sensitive database detail');
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
    [
      'decision',
      'state',
      (service: AgentMissionService) => service.decide({
        authorization: authorization('decide_quote_creation'),
        missionId: '20000000-0000-4000-8000-000000000001',
        commandId: '10000000-0000-4000-8000-000000000006',
        expectedMissionRevision: 2,
        expectedDraftSessionId: 'quote-draft-session-1',
        expectedDraftSlotRevision: 1,
        expectedDraftContentRevision: 0,
        decision: {
          action: 'select_screen_customer',
          customerId: 'customer-camping',
        },
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

  it('mesure une contention foreground sans exposer le SQLSTATE', async () => {
    const { service, capabilityInc, foregroundInc, logger } = harness(
      new ForegroundUnavailableUnitOfWork(),
    );

    await expect(service.start({
      authorization: authorization('start_quote_creation'),
      commandId: '10000000-0000-4000-8000-000000000001',
    })).resolves.toEqual({
      ok: false,
      error: {
        kind: 'unavailable',
        service: 'agent_mission_foreground',
        retryAfterSeconds: 1,
      },
    });
    expect(foregroundInc).toHaveBeenCalledOnce();
    expect(foregroundInc).toHaveBeenCalledWith({
      operation: 'start',
      reason: 'lock_timeout',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'AgentMission foreground indisponible (start/lock_timeout).',
      'AgentMissionService',
    );
    expect(capabilityInc).not.toHaveBeenCalled();
  });

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

  it('réutilise le turnId comme commandId et construit seule la provenance voix', async () => {
    vi.spyOn(StartQuoteAgentMission.prototype, 'execute').mockResolvedValue({
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'sentinel', message: 'test' }],
      },
    });
    const { service } = harness(new RejectingUnitOfWork('state'));
    const turnId = '10000000-0000-4000-8000-000000000005';

    await service.startFromVoiceTurn({
      authorization: authorization('start_quote_creation'),
      realtimeSessionId: REALTIME_SESSION_ID,
      turnId,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      customerReference: 'Camping les Pins',
      lines: [],
    });

    expect(StartQuoteAgentMission.prototype.execute).toHaveBeenCalledWith({
      ...OWNER,
      authority: PROOF,
      commandId: turnId,
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: REALTIME_SESSION_ID,
          turnId,
          contextRevision: 4,
          contextDigest: 'f'.repeat(64),
        },
      },
      customerReference: 'Camping les Pins',
      lines: [],
    });
  });

  it('fait traverser le même use case de décision au toucher et à la voix', async () => {
    vi.spyOn(DecideQuoteAgentMission.prototype, 'execute').mockResolvedValue({
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'sentinel', message: 'test' }],
      },
    });
    const { service } = harness(new RejectingUnitOfWork('state'));
    const base = {
      missionId: MISSION_ID,
      expectedMissionRevision: 3,
      expectedDraftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
    };
    await service.decide({
      authorization: authorization('decide_quote_creation'),
      ...base,
      commandId: '10000000-0000-4000-8000-000000000006',
      decision: {
        action: 'select_screen_customer',
        customerId: 'customer-camping',
      },
    });
    await service.decideFromVoiceTurn({
      authorization: authorization('decide_quote_creation'),
      ...base,
      turnId: '10000000-0000-4000-8000-000000000007',
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      decision: {
        action: 'choose_presented_option',
        decisionId: '30000000-0000-4000-8000-000000000001',
        choiceSetRevision: 3,
        choiceId: '40000000-0000-4000-8000-000000000001',
      },
      lines: [],
    });

    expect(DecideQuoteAgentMission.prototype.execute).toHaveBeenNthCalledWith(1, {
      ...OWNER,
      authority: PROOF,
      ...base,
      commandId: '10000000-0000-4000-8000-000000000006',
      origin: { actor: 'user_tap', correlation: null },
      decision: {
        action: 'select_screen_customer',
        customerId: 'customer-camping',
      },
      lines: [],
    });
    expect(DecideQuoteAgentMission.prototype.execute).toHaveBeenNthCalledWith(2, {
      ...OWNER,
      authority: PROOF,
      ...base,
      commandId: '10000000-0000-4000-8000-000000000007',
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: REALTIME_SESSION_ID,
          turnId: '10000000-0000-4000-8000-000000000007',
          contextRevision: 4,
          contextDigest: 'f'.repeat(64),
        },
      },
      decision: {
        action: 'choose_presented_option',
        decisionId: '30000000-0000-4000-8000-000000000001',
        choiceSetRevision: 3,
        choiceId: '40000000-0000-4000-8000-000000000001',
      },
      lines: [],
    });
  });

  it('stage les lignes voix puis attend la continuation durable avant de répondre', async () => {
    const stagedMission = m2aView('awaiting_lines', 4);
    const convergedMission = m2aView('awaiting_catalogue_choice', 5);
    vi.spyOn(StageQuoteAgentMissionLines.prototype, 'execute').mockResolvedValue({
      ok: true,
      value: {
        outcome: 'staged',
        mission: stagedMission,
        stagedCount: 1,
        firstQueueOrdinal: 1,
        lastQueueOrdinal: 1,
      },
    });
    vi.spyOn(
      ContinueQuoteAgentMissionLineQueue.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: {
        outcome: 'choices_presented',
        mission: convergedMission,
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        presentedChoiceCount: 2,
      },
    });
    const { service, logger } = harness(new RejectingUnitOfWork('state'));

    const result = await service.stageLinesFromVoiceTurn({
      authorization: authorizationV2('stage_quote_lines'),
      missionId: MISSION_ID,
      turnId: '10000000-0000-4000-8000-000000000020',
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      expectedMissionRevision: 3,
      expectedDraftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      lines: [LINE],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: 'staged',
        mission: { phase: 'awaiting_catalogue_choice', revision: 5 },
        continuation: {
          outcome: 'choices_presented',
          presentedChoiceCount: 2,
        },
      },
    });
    expect(StageQuoteAgentMissionLines.prototype.execute).toHaveBeenCalledWith({
      ...OWNER,
      authority: PROOF_V2,
      missionId: MISSION_ID,
      commandId: '10000000-0000-4000-8000-000000000020',
      expectedMissionRevision: 3,
      expectedDraftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      lines: [LINE],
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: REALTIME_SESSION_ID,
          turnId: '10000000-0000-4000-8000-000000000020',
          contextRevision: 4,
          contextDigest: 'f'.repeat(64),
        },
      },
    });
    expect(ContinueQuoteAgentMissionLineQueue.prototype.execute)
      .toHaveBeenCalledWith({
        ...OWNER,
        authority: PROOF_V2,
        missionId: MISSION_ID,
        parentCommandId: '10000000-0000-4000-8000-000000000020',
      });
    expect(logger.audit).toHaveBeenCalledWith(
      'agent_mission.line_candidates_staged',
      expect.objectContaining({
        actor: 'user_voice',
        stagedCount: 1,
        continuationOutcome: 'choices_presented',
      }),
    );
  });

  it('fait converger le même choiceId catalogue au toucher et à la voix avant ACK', async () => {
    const selectedMission = m2aView('awaiting_lines', 6);
    vi.spyOn(
      DecideQuoteAgentMissionCatalogueChoice.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: {
        outcome: 'selected',
        resolution: 'selected',
        invalidationReason: null,
        mission: selectedMission,
      },
    });
    vi.spyOn(
      ContinueQuoteAgentMissionLineQueue.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: {
        outcome: 'deferred_to_m2a2',
        mission: selectedMission,
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        presentedChoiceCount: 0,
      },
    });
    const { service } = harness(new RejectingUnitOfWork('state'));
    const common = {
      missionId: MISSION_ID,
      expectedMissionRevision: 5,
      expectedDraftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      decisionId: '30000000-0000-4000-8000-000000000001',
      choiceSetRevision: 5,
      pendingLineId: '60000000-0000-4000-8000-000000000001',
      expectedWorkRevision: 2,
      choiceId: '40000000-0000-4000-8000-000000000001',
      additionalLines: [],
    } as const;

    const tap = await service.decideCatalogueChoice({
      authorization: authorizationV2('decide_catalogue_choice'),
      ...common,
      commandId: '10000000-0000-4000-8000-000000000030',
    });
    const voice = await service.decideCatalogueChoiceFromVoiceTurn({
      authorization: authorizationV2('decide_catalogue_choice'),
      ...common,
      turnId: '10000000-0000-4000-8000-000000000031',
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
    });

    expect(tap).toMatchObject({
      ok: true,
      value: {
        resolution: 'selected',
        continuation: { outcome: 'deferred_to_m2a2' },
      },
    });
    expect(voice).toMatchObject({
      ok: true,
      value: {
        resolution: 'selected',
        continuation: { outcome: 'deferred_to_m2a2' },
      },
    });
    const calls = vi.mocked(
      DecideQuoteAgentMissionCatalogueChoice.prototype.execute,
    ).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({
      choiceId: common.choiceId,
      origin: { actor: 'user_tap', correlation: null },
    });
    expect(calls[1]?.[0]).toMatchObject({
      choiceId: common.choiceId,
      commandId: '10000000-0000-4000-8000-000000000031',
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: REALTIME_SESSION_ID,
          turnId: '10000000-0000-4000-8000-000000000031',
          contextRevision: 4,
          contextDigest: 'f'.repeat(64),
        },
      },
    });
    expect(ContinueQuoteAgentMissionLineQueue.prototype.execute)
      .toHaveBeenCalledTimes(2);
  });
});
