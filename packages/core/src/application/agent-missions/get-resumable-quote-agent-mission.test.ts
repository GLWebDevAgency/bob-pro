import { describe, expect, it } from 'vitest';
import {
  AgentMission,
  AGENT_MISSION_IDLE_TTL_MS,
} from '../../domain/agent/agent-mission';
import { createEmptyQuoteDraftPayload } from '../quote-drafts/quote-draft-slot';
import type {
  AgentMissionOwner,
  AgentMissionQuoteDraftSlot,
} from '../ports/agent-mission-repository';
import type {
  AgentMissionResumeReadTransaction,
  AgentMissionResumeUnitOfWorkPort,
} from '../ports/agent-mission-resume-unit-of-work';
import type { CustomerCandidateReference } from '../ports/customer-candidate-search';
import { GetResumableQuoteAgentMission } from './get-resumable-quote-agent-mission';

const OWNER = Object.freeze({
  companyId: 'company-1',
  ownerUserId: 'owner-1',
});
const NOW = '2026-07-29T08:00:00.000Z';
const MISSION_ID = '10000000-0000-4000-8000-000000000001';
const DECISION_ID = '20000000-0000-4000-8000-000000000001';
const CHOICE_ONE = '30000000-0000-4000-8000-000000000001';
const CHOICE_TWO = '30000000-0000-4000-8000-000000000002';
const DRAFT_SESSION_ID = 'draft-session-1';

function draftPayload() {
  const created = createEmptyQuoteDraftPayload(DRAFT_SESSION_ID);
  if (!created.ok) throw new Error('invalid draft fixture');
  return created.value;
}

function startedMission() {
  const started = AgentMission.start({
    id: MISSION_ID,
    ...OWNER,
    createdAt: NOW,
    startOutcome: 'no_slot',
    draft: {
      sessionId: DRAFT_SESSION_ID,
      slotRevision: 1,
      contentRevision: 0,
    },
    stagedCustomerResolution: null,
  });
  if (!started.ok) throw new Error('invalid mission fixture');
  return started.value.mission;
}

function missionWithChoices() {
  const started = startedMission();
  const acknowledged = started.acknowledgeQuoteScreen({
    expectedRevision: 1,
    binding: {
      realtimeSessionId: '40000000-0000-4000-8000-000000000001',
      contextRevision: 1,
      contextDigest: 'a'.repeat(64),
      screenName: '/devis/new',
      screenInstanceId: 'devis-new:test',
      acknowledgedAt: NOW,
    },
    observedDraft: {
      sessionId: DRAFT_SESSION_ID,
      slotRevision: 1,
      contentRevision: 0,
    },
    draftHasCustomer: false,
    occurredAt: NOW,
  });
  if (!acknowledged.ok) throw new Error('invalid ack fixture');
  const presented = acknowledged.value.mission.presentCustomerChoices({
    expectedRevision: acknowledged.value.mission.revision,
    decisionId: DECISION_ID,
    candidates: [
      { choiceId: CHOICE_ONE, customerId: 'customer-one' },
      { choiceId: CHOICE_TWO, customerId: 'customer-two' },
    ],
    occurredAt: NOW,
  });
  if (!presented.ok) throw new Error('invalid choice fixture');
  return presented.value.mission;
}

function slot(
  owner: AgentMissionOwner = OWNER,
  overrides: Partial<AgentMissionQuoteDraftSlot> = {},
): AgentMissionQuoteDraftSlot {
  return {
    ...owner,
    revision: 1,
    payloadVersion: 1,
    payload: draftPayload(),
    agentMissionId: MISSION_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class ResumeMemoryUnitOfWork implements AgentMissionResumeUnitOfWorkPort {
  mission: AgentMission | null = startedMission();
  slot: AgentMissionQuoteDraftSlot | null = slot();
  customers: readonly CustomerCandidateReference[] = [];
  now = NOW;
  companyUnavailable: 'missing' | 'closed' | null = null;
  calls = 0;

  async readQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionResumeReadTransaction) => Promise<T>,
  ) {
    this.calls += 1;
    if (this.companyUnavailable !== null) {
      return {
        status: 'company_unavailable' as const,
        reason: this.companyUnavailable,
      };
    }
    return {
      status: 'executed' as const,
      value: await work({
        databaseNow: async () => this.now,
        missions: {
          findActive: async () => this.mission,
        },
        quoteDrafts: {
          get: async () => this.slot,
        },
        customers: {
          findByIds: async () => this.customers,
        },
      }),
    };
  }
}

describe('GetResumableQuoteAgentMission', () => {
  it('refuse une identité invalide avant toute lecture', async () => {
    const unitOfWork = new ResumeMemoryUnitOfWork();
    const useCase = new GetResumableQuoteAgentMission({ unitOfWork });

    await expect(useCase.execute({
      companyId: ' company-1',
      ownerUserId: 'owner-1',
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
    expect(unitOfWork.calls).toBe(0);
  });

  it('retourne un null honnête seulement sans mission ni marqueur de propriété', async () => {
    const unitOfWork = new ResumeMemoryUnitOfWork();
    unitOfWork.mission = null;
    unitOfWork.slot = slot(OWNER, { agentMissionId: null });
    const useCase = new GetResumableQuoteAgentMission({ unitOfWork });

    await expect(useCase.execute(OWNER)).resolves.toEqual({
      ok: true,
      value: { mission: null },
    });
  });

  it('échoue fermé devant un marqueur de mission orphelin', async () => {
    const unitOfWork = new ResumeMemoryUnitOfWork();
    unitOfWork.mission = null;
    const useCase = new GetResumableQuoteAgentMission({ unitOfWork });

    await expect(useCase.execute(OWNER)).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'agent_mission_resume_snapshot',
        cause: 'orphaned_draft_mission_owner',
      },
    });
  });

  it('projette le brouillon et les libellés DB dans l’ordre persistant', async () => {
    const unitOfWork = new ResumeMemoryUnitOfWork();
    unitOfWork.mission = missionWithChoices();
    unitOfWork.customers = [
      { customerId: 'customer-two', canonicalName: 'Nom DB renommé' },
    ];
    const useCase = new GetResumableQuoteAgentMission({ unitOfWork });

    const result = await useCase.execute(OWNER);

    expect(result).toMatchObject({
      ok: true,
      value: {
        mission: {
          id: MISSION_ID,
          status: 'active',
          phase: 'awaiting_customer_choice',
          actionable: true,
          draft: {
            sessionId: DRAFT_SESSION_ID,
            slotRevision: 1,
            contentRevision: 0,
          },
        },
        draft: {
          sessionId: DRAFT_SESSION_ID,
          slotRevision: 1,
          contentRevision: 0,
          step: 'client',
        },
        customerChoices: [
          { status: 'unavailable', choiceId: CHOICE_ONE },
          {
            status: 'available',
            choiceId: CHOICE_TWO,
            label: 'Nom DB renommé',
          },
        ],
      },
    });
  });

  it('refuse une projection dont le nom client n’est pas encore canonique', async () => {
    const unitOfWork = new ResumeMemoryUnitOfWork();
    unitOfWork.mission = missionWithChoices();
    unitOfWork.customers = [
      { customerId: 'customer-two', canonicalName: 'Camping  Les Pins' },
    ];

    await expect(
      new GetResumableQuoteAgentMission({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'agent_mission_resume_snapshot',
        cause: 'invalid_customer_projection',
      },
    });
  });

  it.each([
    ['slot absent', null],
    ['révision slot divergente', slot(OWNER, { revision: 2 })],
    ['propriétaire mission divergent', slot(OWNER, { agentMissionId: null })],
    ['owner divergent', slot({ companyId: 'company-1', ownerUserId: 'owner-2' })],
  ] as const)('échoue fermé si le fence brouillon diverge : %s', async (_label, value) => {
    const unitOfWork = new ResumeMemoryUnitOfWork();
    unitOfWork.slot = value;
    const useCase = new GetResumableQuoteAgentMission({ unitOfWork });

    await expect(useCase.execute(OWNER)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'agent_mission_resume_snapshot' },
    });
  });

  it.each([
    [
      'dupliquée',
      [
        { customerId: 'customer-one', canonicalName: 'Client un' },
        { customerId: 'customer-one', canonicalName: 'Client un bis' },
      ],
    ],
    [
      'injectée',
      [{ customerId: 'customer-other', canonicalName: 'Client injecté' }],
    ],
  ] as const)('refuse une projection client %s', async (_label, customers) => {
    const unitOfWork = new ResumeMemoryUnitOfWork();
    unitOfWork.mission = missionWithChoices();
    unitOfWork.customers = customers;
    const useCase = new GetResumableQuoteAgentMission({ unitOfWork });

    await expect(useCase.execute(OWNER)).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'agent_mission_resume_snapshot',
        cause: 'non_authoritative_customer_projection',
      },
    });
  });

  it('projette une expiration sans écrire ni libérer implicitement le slot', async () => {
    const unitOfWork = new ResumeMemoryUnitOfWork();
    unitOfWork.now = new Date(
      Date.parse(NOW) + AGENT_MISSION_IDLE_TTL_MS,
    ).toISOString();
    const useCase = new GetResumableQuoteAgentMission({ unitOfWork });

    await expect(useCase.execute(OWNER)).resolves.toMatchObject({
      ok: true,
      value: {
        mission: { status: 'expired', actionable: false },
      },
    });
    expect(unitOfWork.slot?.agentMissionId).toBe(MISSION_ID);
  });

  it('ne transforme pas une société indisponible en mission absente', async () => {
    const unitOfWork = new ResumeMemoryUnitOfWork();
    unitOfWork.companyUnavailable = 'closed';
    const useCase = new GetResumableQuoteAgentMission({ unitOfWork });

    await expect(useCase.execute(OWNER)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'unavailable',
        service: 'agent_mission_resume_company_closed',
      },
    });
  });
});
