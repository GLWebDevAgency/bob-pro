import type {
  AgentMissionFingerprintPort,
  AgentMissionOwner,
  AgentMissionReadTransaction,
  AgentMissionResumeReadTransaction,
  AgentMissionResumeUnitOfWorkPort,
  AgentMissionResumeV2ReadTransaction,
  AgentMissionResumeV2UnitOfWorkPort,
  AgentMissionRealtimeAuthorityProof,
  AgentMissionTransaction,
  AgentMissionUnitOfWorkPort,
  AgentMissionViewV1,
} from '@bob/core';
import {
  AcknowledgeQuoteScreen,
  AdvanceQuoteAgentMission,
  AgentMission,
  CancelQuoteAgentMissionPendingLine,
  ContinueQuoteAgentMissionLineQueue,
  ContinueQuoteAgentMissionLineResolution,
  DecideQuoteAgentMissionCatalogueChoice,
  DecideQuoteAgentMission,
  GetActiveAgentMission,
  GetResumableQuoteAgentMissionV2,
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
const EMPTY_PRESENTATION = Object.freeze({
  schema: 'bob.agent-mission.quote-presentation',
  version: 1,
  requiredFact: null,
  pendingLine: null,
  decision: null,
  catalogueChoices: Object.freeze([]),
  freeLineChoiceId: null,
  proposalStatus: Object.freeze({ kind: 'absent' }),
  proposal: null,
} as const);

function resumeProjection(view: AgentMissionViewV1) {
  const draft = view.payload.draft;
  if (draft === null) throw new Error('fixture mission sans brouillon');
  return {
    mission: {
      id: view.id,
      status: view.status as 'active',
      phase: view.phase,
      revision: view.revision,
      actionable: view.actionable,
      draft,
      idleExpiresAt: view.idleExpiresAt,
      hardExpiresAt: view.hardExpiresAt,
    },
    draft: {
      ...draft,
      step: 'lignes' as const,
    },
    customerChoices: [],
    presentation: EMPTY_PRESENTATION,
  };
}

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

function m2aCatalogueView(revision: number): AgentMissionViewV1 {
  return {
    ...m2aView('awaiting_catalogue_choice', revision),
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: {
        sessionId: 'quote-draft-session-1',
        slotRevision: 2,
        contentRevision: 1,
      },
      decision: {
        kind: 'catalogue',
        decisionId: '30000000-0000-4000-8000-000000000001',
        choiceSetRevision: revision,
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        expectedDraft: {
          sessionId: 'quote-draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        expectedWorkRevision: 2,
        candidates: [{
          choiceId: '40000000-0000-4000-8000-000000000001',
          catalogueItemId: 'catalogue-main-oeuvre',
          expectedCatalogueRevision: 3,
        }],
        freeLineChoiceId: '40000000-0000-4000-8000-000000000002',
        choiceSetHash: 'e'.repeat(64),
      },
      stagedCustomerResolution: null,
    },
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
  resumeV2UnitOfWork: AgentMissionResumeV2UnitOfWorkPort | null = null,
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
    createAgentMissionResumeV2UnitOfWork: vi.fn(() => resumeV2UnitOfWork),
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

class ResumeV2NullUnitOfWork implements AgentMissionResumeV2UnitOfWorkPort {
  readonly owners: AgentMissionOwner[] = [];

  async readQuoteCreationOwnerV2<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionResumeV2ReadTransaction) => Promise<T>,
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
        quoteLineWork: { list: async () => [] },
        catalogue: { findByIds: async () => [] },
        quoteVatContext: { get: async () => null },
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

  it('dérive la reprise V2 du même principal sans fallback vers la factory V1', async () => {
    const resumeV1 = new ResumeNullUnitOfWork();
    const resumeV2 = new ResumeV2NullUnitOfWork();
    const { service, persistence } = harness(null, resumeV1, resumeV2);

    const result = await requestContext.run(
      {
        correlationId: 'resume-v2-owner-test',
        principal: { userId: OWNER.ownerUserId, companyId: OWNER.companyId },
      },
      () => service.getCurrentResumeV2(),
    );

    expect(result).toEqual({
      ok: true,
      value: { mission: null, presentation: null },
    });
    expect(resumeV2.owners).toEqual([OWNER]);
    expect(persistence.createAgentMissionResumeV2UnitOfWork).toHaveBeenCalledOnce();
    expect(persistence.createAgentMissionResumeUnitOfWork).not.toHaveBeenCalled();
  });

  it('refuse la reprise V2 sans principal avant toute factory', async () => {
    const resumeV2 = new ResumeV2NullUnitOfWork();
    const { service, persistence } = harness(null, null, resumeV2);

    await expect(service.getCurrentResumeV2()).resolves.toEqual({
      ok: false,
      error: { kind: 'forbidden', reason: 'authenticated_owner_required' },
    });
    expect(persistence.createAgentMissionResumeV2UnitOfWork).not.toHaveBeenCalled();
  });

  it('refuse getCurrentV2 avec une capability V1 avant toute lecture', async () => {
    const { service, persistence } = harness(null);

    await expect(service.getCurrentV2(
      authorization('get_current_quote_creation'),
    )).resolves.toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_protocol',
        reason: 'upgrade_required',
      },
    });
    expect(persistence.createAgentMissionUnitOfWork).not.toHaveBeenCalled();
    expect(persistence.createAgentMissionResumeV2UnitOfWork).not.toHaveBeenCalled();
  });

  it('lie getCurrentV2 à la mission complète et à la projection du même snapshot', async () => {
    const view = m2aView('awaiting_line_details', 4);
    vi.spyOn(GetActiveAgentMission.prototype, 'execute').mockResolvedValue({
      ok: true,
      value: view,
    });
    vi.spyOn(
      GetResumableQuoteAgentMissionV2.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: resumeProjection(view),
    });
    const { service } = harness(
      new RejectingUnitOfWork('state'),
      null,
      new ResumeV2NullUnitOfWork(),
    );

    await expect(service.getCurrentV2(
      authorizationV2('get_current_quote_creation'),
    )).resolves.toEqual({
      ok: true,
      value: {
        mission: view,
        presentation: EMPTY_PRESENTATION,
      },
    });
  });

  it('ferme getCurrentV2 si la projection change entre les deux lectures', async () => {
    const view = m2aView('awaiting_line_details', 4);
    const changed = m2aView('awaiting_line_details', 5);
    vi.spyOn(GetActiveAgentMission.prototype, 'execute').mockResolvedValue({
      ok: true,
      value: view,
    });
    vi.spyOn(
      GetResumableQuoteAgentMissionV2.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: resumeProjection(changed),
    });
    const { service } = harness(
      new RejectingUnitOfWork('state'),
      null,
      new ResumeV2NullUnitOfWork(),
    );

    await expect(service.getCurrentV2(
      authorizationV2('get_current_quote_creation'),
    )).resolves.toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'agent_mission_command_projection',
        cause: 'mission_changed_after_command',
      },
    });
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
    {
      name: 'une sentinelle de ligne bornée',
      failure: new Error(
        'AGENT_MISSION_QUOTE_LINE_WORK_ROW_CORRUPT:serviceReference:sensitive-detail',
      ),
      expectedErrorType: 'error',
      expectedCauseCode: 'AGENT_MISSION_QUOTE_LINE_WORK_ROW_CORRUPT',
    },
    {
      name: 'une erreur inconnue',
      failure: new Error('sensitive database detail'),
      expectedErrorType: 'error',
      expectedCauseCode: 'unexpected_error',
    },
    {
      name: 'un rejet non Error',
      failure: 'sensitive non-error detail',
      expectedErrorType: 'non_error',
      expectedCauseCode: 'unexpected_error',
    },
  ])(
    'journalise $name de reprise V2 avec une cause structurée sans détail sensible',
    async ({
      failure,
      expectedErrorType,
      expectedCauseCode,
    }) => {
      const resumeV2: AgentMissionResumeV2UnitOfWorkPort = {
        readQuoteCreationOwnerV2: async () => {
          throw failure;
        },
      };
      const { service, logger } = harness(null, null, resumeV2);

      const result = await requestContext.run(
        {
          correlationId: 'resume-v2-failure-test',
          principal: { userId: OWNER.ownerUserId, companyId: OWNER.companyId },
        },
        () => service.getCurrentResumeV2(),
      );

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'unavailable',
          service: 'agent_mission_resume_v2_persistence',
        },
      });
      expect(logger.error).toHaveBeenCalledWith(
        'Lecture de reprise AgentMission V2 impossible.',
        undefined,
        'AgentMissionService',
        {
          errorType: expectedErrorType,
          causeCode: expectedCauseCode,
          port: 'agent_mission_resume_v2_persistence',
        },
      );
      expect(JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls))
        .not.toContain('sensitive');
    },
  );

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

  it('renvoie une projection V2 fraîche après ACK et décision ayant convergé vers M2-A-2', async () => {
    const fixtures = continuationFixtures();
    const acknowledgedLines = m2aView('awaiting_lines', 3);
    const details = m2aView('awaiting_line_details', 4);
    const selectedLines = m2aView('awaiting_lines', 5);
    const confirmation = m2aView('awaiting_line_confirmation', 6);
    vi.spyOn(AcknowledgeQuoteScreen.prototype, 'execute').mockResolvedValue({
      ok: true,
      value: {
        outcome: 'acknowledged',
        receipt: fixtures.receipt,
        mission: fixtures.acknowledgedView,
      },
    });
    vi.spyOn(AdvanceQuoteAgentMission.prototype, 'execute').mockResolvedValue({
      ok: true,
      value: {
        outcome: 'advanced',
        mission: acknowledgedLines,
      },
    });
    vi.spyOn(DecideQuoteAgentMission.prototype, 'execute').mockResolvedValue({
      ok: true,
      value: {
        outcome: 'selected',
        effect: { kind: 'selected' },
        mission: selectedLines,
      },
    });
    vi.spyOn(
      ContinueQuoteAgentMissionLineResolution.prototype,
      'execute',
    )
      .mockResolvedValueOnce({
        ok: true,
        value: {
          outcome: 'details_requested',
          mission: details,
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          requiredFact: 'unit_price',
          proposalId: null,
          continuationReceipt: null,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          outcome: 'proposal_presented',
          mission: confirmation,
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          requiredFact: null,
          proposalId: '70000000-0000-4000-8000-000000000001',
          continuationReceipt: null,
        },
      });
    vi.spyOn(
      GetResumableQuoteAgentMissionV2.prototype,
      'execute',
    )
      .mockResolvedValueOnce({
        ok: true,
        value: resumeProjection(details),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: resumeProjection(confirmation),
      });
    const { service } = harness(
      new RejectingUnitOfWork('state'),
      null,
      new ResumeV2NullUnitOfWork(),
    );

    await expect(service.acknowledgeScreen({
      authorization: authorizationV2('acknowledge_quote_screen'),
      missionId: MISSION_ID,
      commandId: ACK_COMMAND_ID,
      expectedMissionRevision: 1,
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      draftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        mission: { phase: 'awaiting_line_details', revision: 4 },
        presentation: EMPTY_PRESENTATION,
      },
    });

    await expect(service.decide({
      authorization: authorizationV2('decide_quote_creation'),
      missionId: MISSION_ID,
      commandId: '10000000-0000-4000-8000-000000000006',
      expectedMissionRevision: 3,
      expectedDraftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      decision: {
        action: 'select_screen_customer',
        customerId: 'customer-camping',
      },
      lines: [],
    })).resolves.toMatchObject({
      ok: true,
      value: {
        mission: { phase: 'awaiting_line_confirmation', revision: 6 },
        presentation: EMPTY_PRESENTATION,
      },
    });
  });

  it.each([
    ['awaiting_line_details', 'details_requested'],
    ['awaiting_line_confirmation', 'proposal_presented'],
  ] as const)(
    'un nouvel ACK reprend durablement une tête %s interrompue avant continuation',
    async (phase, continuationOutcome) => {
      const acknowledgedMission = m2aView(phase, 10);
      const convergedMission = m2aView(phase, 11);
      const receipt = {
        ackCommandId: ACK_COMMAND_ID,
        missionId: MISSION_ID,
        missionRevisionAfter: 9,
        realtimeSessionId: REALTIME_SESSION_ID,
        contextRevision: 5,
        contextDigest: 'a'.repeat(64),
        occurredAt: NOW,
      };
      vi.spyOn(AcknowledgeQuoteScreen.prototype, 'execute').mockResolvedValue({
        ok: true,
        value: {
          outcome: 'acknowledged',
          receipt,
          mission: acknowledgedMission,
        },
      });
      vi.spyOn(AdvanceQuoteAgentMission.prototype, 'execute').mockResolvedValue({
        ok: true,
        value: {
          outcome: 'superseded',
          mission: acknowledgedMission,
        },
      });
      vi.spyOn(
        ContinueQuoteAgentMissionLineResolution.prototype,
        'execute',
      ).mockResolvedValue({
        ok: true,
        value: {
          outcome: continuationOutcome,
          mission: convergedMission,
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          requiredFact: continuationOutcome === 'details_requested'
            ? 'unit_price'
            : null,
          proposalId: continuationOutcome === 'proposal_presented'
            ? '70000000-0000-4000-8000-000000000001'
            : null,
          continuationReceipt: null,
        },
      });
      const queueSpy = vi.spyOn(
        ContinueQuoteAgentMissionLineQueue.prototype,
        'execute',
      ).mockRejectedValue(new Error('queue ne doit pas être appelée'));
      vi.spyOn(
        GetResumableQuoteAgentMissionV2.prototype,
        'execute',
      ).mockResolvedValue({
        ok: true,
        value: resumeProjection(convergedMission),
      });
      const { service } = harness(
        new RejectingUnitOfWork('state'),
        null,
        new ResumeV2NullUnitOfWork(),
      );

      await expect(service.acknowledgeScreen({
        authorization: authorizationV2('acknowledge_quote_screen'),
        missionId: MISSION_ID,
        commandId: ACK_COMMAND_ID,
        expectedMissionRevision: 8,
        realtimeSessionId: REALTIME_SESSION_ID,
        contextRevision: 5,
        contextDigest: 'a'.repeat(64),
        draftSessionId: 'quote-draft-session-1',
        expectedDraftSlotRevision: 2,
        expectedDraftContentRevision: 1,
      })).resolves.toMatchObject({
        ok: true,
        value: {
          mission: {
            phase,
            revision: 11,
          },
          presentation: EMPTY_PRESENTATION,
        },
      });
      expect(
        ContinueQuoteAgentMissionLineResolution.prototype.execute,
      ).toHaveBeenCalledWith({
        ...OWNER,
        authority: PROOF_V2,
        missionId: MISSION_ID,
        parentCommandId: ACK_COMMAND_ID,
      });
      expect(queueSpy).not.toHaveBeenCalled();
    },
  );

  it('un nouvel ACK converge une tête queued interrompue après le commit utilisateur', async () => {
    const queuedMission = m2aView('awaiting_lines', 10);
    const convergedMission = m2aCatalogueView(11);
    const receipt = {
      ackCommandId: ACK_COMMAND_ID,
      missionId: MISSION_ID,
      missionRevisionAfter: 10,
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 5,
      contextDigest: 'a'.repeat(64),
      occurredAt: NOW,
    };
    vi.spyOn(AcknowledgeQuoteScreen.prototype, 'execute').mockResolvedValue({
      ok: true,
      value: {
        outcome: 'acknowledged',
        receipt,
        mission: queuedMission,
      },
    });
    vi.spyOn(AdvanceQuoteAgentMission.prototype, 'execute').mockResolvedValue({
      ok: true,
      value: {
        outcome: 'superseded',
        mission: queuedMission,
      },
    });
    vi.spyOn(
      ContinueQuoteAgentMissionLineResolution.prototype,
      'execute',
    )
      .mockResolvedValueOnce({
        ok: true,
        value: {
          outcome: 'needs_catalogue_resolution',
          mission: queuedMission,
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          requiredFact: null,
          proposalId: null,
          continuationReceipt: null,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          outcome: 'catalogue_choice_pending',
          mission: convergedMission,
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          requiredFact: null,
          proposalId: null,
          continuationReceipt: null,
        },
      });
    const queue = vi.spyOn(
      ContinueQuoteAgentMissionLineQueue.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: {
        outcome: 'choices_presented',
        mission: convergedMission,
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        presentedChoiceCount: 2,
        continuationReceipt: {
          commandId: '70000000-0000-4000-8000-000000000099',
          eventType: 'catalogue_choices_presented',
          missionRevisionAfter: 11,
        },
      },
    });
    vi.spyOn(
      GetResumableQuoteAgentMissionV2.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: resumeProjection(convergedMission),
    });
    const { service } = harness(
      new RejectingUnitOfWork('state'),
      null,
      new ResumeV2NullUnitOfWork(),
    );

    await expect(service.acknowledgeScreen({
      authorization: authorizationV2('acknowledge_quote_screen'),
      missionId: MISSION_ID,
      commandId: ACK_COMMAND_ID,
      expectedMissionRevision: 9,
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 5,
      contextDigest: 'a'.repeat(64),
      draftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        mission: {
          phase: 'awaiting_catalogue_choice',
          revision: 11,
        },
        presentation: EMPTY_PRESENTATION,
      },
    });
    expect(queue).toHaveBeenCalledWith({
      ...OWNER,
      authority: PROOF_V2,
      missionId: MISSION_ID,
      parentCommandId: ACK_COMMAND_ID,
    });
    expect(
      ContinueQuoteAgentMissionLineResolution.prototype.execute,
    ).toHaveBeenCalledTimes(2);
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
    const convergedMission = m2aCatalogueView(5);
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
        continuationReceipt: {
          commandId: '70000000-0000-4000-8000-000000000001',
          eventType: 'catalogue_choices_presented',
          missionRevisionAfter: 5,
        },
      },
    });
    vi.spyOn(
      ContinueQuoteAgentMissionLineResolution.prototype,
      'execute',
    )
      .mockResolvedValueOnce({
        ok: true,
        value: {
          outcome: 'needs_catalogue_resolution',
          mission: stagedMission,
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          requiredFact: null,
          proposalId: null,
          continuationReceipt: null,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          outcome: 'catalogue_choice_pending',
          mission: convergedMission,
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          requiredFact: null,
          proposalId: null,
          continuationReceipt: null,
        },
      });
    vi.spyOn(
      GetResumableQuoteAgentMissionV2.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: resumeProjection(convergedMission),
    });
    const { service, logger } = harness(
      new RejectingUnitOfWork('state'),
      null,
      new ResumeV2NullUnitOfWork(),
    );

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
        presentation: EMPTY_PRESENTATION,
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

  it('refuse une présentation lue après qu’une autre commande a changé la mission', async () => {
    const stagedMission = m2aView('awaiting_lines', 4);
    const commandMission = m2aView('awaiting_line_details', 5);
    const newerMission = m2aView('awaiting_line_details', 6);
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
      ContinueQuoteAgentMissionLineResolution.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: {
        outcome: 'stable',
        mission: commandMission,
        pendingLineId: null,
        requiredFact: null,
        proposalId: null,
        continuationReceipt: null,
      },
    });
    vi.spyOn(
      GetResumableQuoteAgentMissionV2.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: resumeProjection(newerMission),
    });
    const { service } = harness(
      new RejectingUnitOfWork('state'),
      null,
      new ResumeV2NullUnitOfWork(),
    );

    await expect(service.stageLinesFromVoiceTurn({
      authorization: authorizationV2('stage_quote_lines'),
      missionId: MISSION_ID,
      turnId: '10000000-0000-4000-8000-000000000021',
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      expectedMissionRevision: 3,
      expectedDraftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      lines: [LINE],
    })).resolves.toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'agent_mission_command_projection',
        cause: 'mission_changed_after_command',
      },
    });
  });

  it('fait converger le même choiceId catalogue au toucher et à la voix avant ACK', async () => {
    const selectedMission = m2aView('awaiting_lines', 6);
    const resolvedMission = m2aView('awaiting_line_details', 7);
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
      ContinueQuoteAgentMissionLineResolution.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: {
        outcome: 'details_requested',
        mission: resolvedMission,
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        requiredFact: 'unit_price',
        proposalId: null,
        continuationReceipt: {
          commandId: '70000000-0000-4000-8000-000000000002',
          eventType: 'line_details_requested',
          missionRevisionAfter: 7,
        },
      },
    });
    vi.spyOn(
      GetResumableQuoteAgentMissionV2.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: resumeProjection(resolvedMission),
    });
    const { service } = harness(
      new RejectingUnitOfWork('state'),
      null,
      new ResumeV2NullUnitOfWork(),
    );
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
      additionalLines: [LINE],
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
        continuation: {
          outcome: 'details_requested',
          requiredFact: 'unit_price',
        },
      },
    });
    expect(voice).toMatchObject({
      ok: true,
      value: {
        resolution: 'selected',
        continuation: {
          outcome: 'details_requested',
          requiredFact: 'unit_price',
        },
      },
    });
    const calls = vi.mocked(DecideQuoteAgentMissionCatalogueChoice.prototype.execute).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({
      choiceId: common.choiceId,
      additionalLines: [LINE],
      origin: { actor: 'user_tap', correlation: null },
    });
    expect(calls[1]?.[0]).toMatchObject({
      choiceId: common.choiceId,
      additionalLines: [],
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
    expect(ContinueQuoteAgentMissionLineResolution.prototype.execute)
      .toHaveBeenCalledTimes(2);
  });

  it('annule la même ligne en attente au toucher et à la voix sans modifier le brouillon', async () => {
    const cancelledMission = m2aView('awaiting_lines', 8);
    vi.spyOn(
      CancelQuoteAgentMissionPendingLine.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: {
        outcome: 'cancelled',
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        mission: cancelledMission,
        commandReceipt: {
          commandId: '10000000-0000-4000-8000-000000000040',
          eventType: 'line_cancelled',
          missionRevisionAfter: 8,
        },
      },
    });
    vi.spyOn(
      ContinueQuoteAgentMissionLineResolution.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: {
        outcome: 'empty',
        mission: cancelledMission,
        pendingLineId: null,
        requiredFact: null,
        proposalId: null,
        continuationReceipt: null,
      },
    });
    vi.spyOn(
      GetResumableQuoteAgentMissionV2.prototype,
      'execute',
    ).mockResolvedValue({
      ok: true,
      value: resumeProjection(cancelledMission),
    });
    const { service, logger } = harness(
      new RejectingUnitOfWork('state'),
      null,
      new ResumeV2NullUnitOfWork(),
    );
    const common = {
      missionId: MISSION_ID,
      expectedMissionRevision: 7,
      expectedDraftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      pendingLineId: '60000000-0000-4000-8000-000000000001',
      expectedWorkRevision: 4,
    } as const;

    const tap = await service.cancelPendingLine({
      authorization: authorizationV2('cancel_pending_quote_line'),
      ...common,
      commandId: '10000000-0000-4000-8000-000000000040',
    });
    const voice = await service.cancelPendingLineFromVoiceTurn({
      authorization: authorizationV2('cancel_pending_quote_line'),
      ...common,
      turnId: '10000000-0000-4000-8000-000000000041',
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
    });

    for (const result of [tap, voice]) {
      expect(result).toMatchObject({
        ok: true,
        value: {
          outcome: 'cancelled',
          pendingLineId: common.pendingLineId,
          mission: {
            phase: 'awaiting_lines',
            payload: {
              draft: {
                sessionId: common.expectedDraftSessionId,
                slotRevision: common.expectedDraftSlotRevision,
                contentRevision: common.expectedDraftContentRevision,
              },
            },
          },
          continuation: { outcome: 'empty' },
          presentation: EMPTY_PRESENTATION,
        },
      });
    }
    const calls = vi.mocked(
      CancelQuoteAgentMissionPendingLine.prototype.execute,
    ).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({
      ...common,
      commandId: '10000000-0000-4000-8000-000000000040',
      origin: { actor: 'user_tap', correlation: null },
    });
    expect(calls[1]?.[0]).toMatchObject({
      ...common,
      commandId: '10000000-0000-4000-8000-000000000041',
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: REALTIME_SESSION_ID,
          turnId: '10000000-0000-4000-8000-000000000041',
          contextRevision: 4,
          contextDigest: 'f'.repeat(64),
        },
      },
    });
    expect(logger.audit).toHaveBeenCalledTimes(2);
    expect(logger.audit).toHaveBeenCalledWith(
      'agent_mission.pending_line_cancelled',
      expect.objectContaining({
        actor: 'user_voice',
        outcome: 'cancelled',
        continuationOutcome: 'empty',
      }),
    );
  });
});
