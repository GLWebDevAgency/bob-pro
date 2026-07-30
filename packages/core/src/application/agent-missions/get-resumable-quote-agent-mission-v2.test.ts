import { describe, expect, it } from 'vitest';
import { AgentMission } from '../../domain/agent/agent-mission';
import {
  applyQuoteDraftCustomerSelection,
} from '../quote-drafts/apply-quote-draft-transition';
import {
  createEmptyQuoteDraftPayload,
} from '../quote-drafts/quote-draft-slot';
import {
  type AgentMissionResumeV2ReadTransaction,
  type AgentMissionResumeV2UnitOfWorkPort,
} from '../ports/agent-mission-resume-unit-of-work';
import {
  type AgentMissionForeground,
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
} from '../ports/agent-mission-repository';
import {
  type CatalogueCandidateRecord,
} from '../ports/catalogue-candidate-search';
import {
  type CustomerCandidateReference,
} from '../ports/customer-candidate-search';
import {
  computeQuoteVatContextDigest,
  type QuoteVatDecisionContext,
} from '../ports/quote-vat-context';
import {
  deriveQuoteLineProposal,
} from './derive-quote-line-proposal';
import {
  GetResumableQuoteAgentMissionV2,
} from './get-resumable-quote-agent-mission-v2';
import {
  presentCatalogueChoicesOnQuoteLineWork,
  presentQuoteLineProposalOnWork,
  requestQuoteLineDetailsOnWork,
  type AgentMissionQuoteLineWork,
} from './quote-line-work';

const OWNER = Object.freeze({
  companyId: 'company-1',
  ownerUserId: 'owner-1',
});
const MISSION_ID = '10000000-0000-4000-8000-000000000001';
const WORK_ID = '20000000-0000-4000-8000-000000000001';
const DECISION_ID = '30000000-0000-4000-8000-000000000001';
const PROPOSAL_ID = '40000000-0000-4000-8000-000000000001';
const CHOICE_ONE = '50000000-0000-4000-8000-000000000001';
const CHOICE_TWO = '50000000-0000-4000-8000-000000000002';
const CHOICE_FREE = '50000000-0000-4000-8000-000000000003';
const CHOICE_CONFIRM = '60000000-0000-4000-8000-000000000001';
const CHOICE_EDIT = '60000000-0000-4000-8000-000000000002';
const CHOICE_CANCEL = '60000000-0000-4000-8000-000000000003';
const DRAFT_SESSION_ID = 'quote-line-session-1';
const NOW = '2026-07-30T08:05:00.000Z';
const SELECTED_AT = '2026-07-30T08:02:00.000Z';
const WORKED_AT = '2026-07-30T08:03:00.000Z';

const VAT_CONTEXT: QuoteVatDecisionContext = Object.freeze({
  customerId: 'customer-a',
  companyVatRegime: 'reel_normal',
  companyTrade: 'plombier',
  customerType: 'b2b',
  customerIsSubcontractingBtp: false,
});

const CATALOGUE_ONE: CatalogueCandidateRecord = Object.freeze({
  id: 'catalogue-main-oeuvre',
  revision: 7,
  label: 'Heure de main-d’œuvre plomberie',
  category: 'labor',
  unit: 'heure',
  unitPriceHT: 5_500,
  vatRate: 20,
});

const CATALOGUE_TWO: CatalogueCandidateRecord = Object.freeze({
  id: 'catalogue-deplacement',
  revision: 3,
  label: 'Déplacement local',
  category: 'travel',
  unit: 'forfait',
  unitPriceHT: 3_500,
  vatRate: 20,
});

function selectedQuoteFixture() {
  const empty = createEmptyQuoteDraftPayload(DRAFT_SESSION_ID);
  if (!empty.ok) throw new Error('invalid empty draft fixture');
  const payload = applyQuoteDraftCustomerSelection(empty.value, {
    id: 'customer-a',
    name: 'Client A',
  });
  if (!payload.ok) throw new Error('invalid selected draft fixture');
  const started = AgentMission.start({
    id: MISSION_ID,
    ...OWNER,
    protocolVersion: 2,
    createdAt: '2026-07-30T08:00:00.000Z',
    stagedCustomerResolution: null,
    startOutcome: 'no_slot',
    draft: {
      sessionId: DRAFT_SESSION_ID,
      slotRevision: 1,
      contentRevision: 0,
    },
  });
  if (!started.ok) throw new Error('invalid mission fixture');
  const acknowledged = started.value.mission.acknowledgeQuoteScreen({
    expectedRevision: 1,
    binding: {
      realtimeSessionId: '70000000-0000-4000-8000-000000000001',
      contextRevision: 1,
      contextDigest: 'a'.repeat(64),
      screenName: '/devis/new',
      screenInstanceId: 'quote-line:test',
      acknowledgedAt: '2026-07-30T08:01:00.000Z',
    },
    observedDraft: {
      sessionId: DRAFT_SESSION_ID,
      slotRevision: 1,
      contentRevision: 0,
    },
    draftHasCustomer: false,
    occurredAt: '2026-07-30T08:01:00.000Z',
  });
  if (!acknowledged.ok) throw new Error('invalid mission acknowledgement fixture');
  const selected = acknowledged.value.mission.selectCustomer({
    expectedRevision: 2,
    source: 'screen_selection',
    customerId: 'customer-a',
    updatedDraft: {
      sessionId: DRAFT_SESSION_ID,
      slotRevision: 2,
      contentRevision: 1,
    },
    occurredAt: SELECTED_AT,
  });
  if (!selected.ok) throw new Error('invalid customer transition fixture');
  const slot: AgentMissionQuoteDraftSlot = {
    ...OWNER,
    revision: 2,
    payloadVersion: 1,
    payload: payload.value,
    agentMissionId: MISSION_ID,
    createdAt: '2026-07-30T08:00:00.000Z',
    updatedAt: SELECTED_AT,
  };
  return Object.freeze({
    mission: selected.value.mission,
    payload: payload.value,
    slot,
  });
}

function queuedWork(
  overrides: Partial<AgentMissionQuoteLineWork> = {},
): AgentMissionQuoteLineWork {
  return {
    id: WORK_ID,
    ...OWNER,
    missionId: MISSION_ID,
    ordinal: 1,
    revision: 1,
    state: 'queued',
    origin: 'user_voice',
    serviceReference: 'Main-d’œuvre plomberie',
    category: 'labor',
    quantityMilli: 2_000,
    unit: 'heure',
    unitPriceCents: 5_500,
    requestedVatRate: 20,
    priceBasis: 'per_unit',
    housingOlderThan2y: null,
    energyRenovation: null,
    requiredFact: null,
    catalogueResolution: 'free',
    catalogueItemId: null,
    expectedCatalogueRevision: null,
    catalogueCategoryOverrideConfirmed: false,
    catalogueUnitOverrideConfirmed: false,
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    createdAt: SELECTED_AT,
    updatedAt: SELECTED_AT,
    ...overrides,
  };
}

class ResumeV2MemoryUnitOfWork implements AgentMissionResumeV2UnitOfWorkPort {
  mission: AgentMission | null;
  slot: AgentMissionQuoteDraftSlot | null;
  workItems: readonly AgentMissionQuoteLineWork[] = [];
  catalogue: readonly CatalogueCandidateRecord[] = [];
  catalogueReturnsUnfiltered = false;
  customers: readonly CustomerCandidateReference[] = [];
  vatContext: QuoteVatDecisionContext | null = VAT_CONTEXT;
  foregroundOverride: AgentMissionForeground | null | undefined;
  companyUnavailable: 'missing' | 'closed' | null = null;
  calls = 0;

  constructor() {
    const fixture = selectedQuoteFixture();
    this.mission = fixture.mission;
    this.slot = fixture.slot;
  }

  async readQuoteCreationOwnerV2<T>(
    _owner: AgentMissionOwner,
    work: (transaction: AgentMissionResumeV2ReadTransaction) => Promise<T>,
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
        databaseNow: async () => NOW,
        missions: {
          findActive: async () => this.mission,
          findForeground: async () => (
            this.foregroundOverride !== undefined
              ? this.foregroundOverride
              : this.mission === null
                ? null
                : { status: 'known' as const, mission: this.mission }
          ),
        },
        quoteDrafts: {
          get: async () => this.slot,
        },
        customers: {
          findByIds: async () => this.customers,
        },
        quoteLineWork: {
          list: async () => this.workItems,
        },
        catalogue: {
          findByIds: async ({ catalogueItemIds }) => (
            this.catalogueReturnsUnfiltered
              ? this.catalogue
              : this.catalogue.filter((item) => catalogueItemIds.includes(item.id))
          ),
        },
        quoteVatContext: {
          get: async () => this.vatContext,
        },
      }),
    };
  }
}

function detailsFixture() {
  const fixture = selectedQuoteFixture();
  const requestedWork = requestQuoteLineDetailsOnWork({
    workItem: queuedWork({ unitPriceCents: null, priceBasis: null }),
    expectedRevision: 1,
    requiredFact: 'unit_price',
    occurredAt: WORKED_AT,
  });
  if (!requestedWork.ok) throw new Error('invalid details work fixture');
  const requestedMission = fixture.mission.requestLineDetails({
    expectedRevision: 3,
    pendingLineId: WORK_ID,
    requiredFact: 'unit_price',
    workRevisionAfter: requestedWork.value.revision,
    occurredAt: WORKED_AT,
  });
  if (!requestedMission.ok) throw new Error('invalid details mission fixture');
  return {
    ...fixture,
    mission: requestedMission.value.mission,
    work: requestedWork.value,
  };
}

function catalogueChoiceFixture() {
  const fixture = selectedQuoteFixture();
  const presentedWork = presentCatalogueChoicesOnQuoteLineWork({
    workItem: queuedWork({
      category: null,
      quantityMilli: null,
      unit: null,
      unitPriceCents: null,
      requestedVatRate: null,
      priceBasis: null,
      catalogueResolution: 'pending',
    }),
    expectedRevision: 1,
    occurredAt: WORKED_AT,
  });
  if (!presentedWork.ok) throw new Error('invalid catalogue work fixture');
  const presentedMission = fixture.mission.presentCatalogueChoices({
    expectedRevision: 3,
    decisionId: DECISION_ID,
    pendingLineId: WORK_ID,
    expectedWorkRevision: presentedWork.value.revision,
    expectedDraft: {
      sessionId: DRAFT_SESSION_ID,
      slotRevision: 2,
      contentRevision: 1,
    },
    candidates: [
      {
        choiceId: CHOICE_ONE,
        catalogueItemId: CATALOGUE_ONE.id,
        expectedCatalogueRevision: CATALOGUE_ONE.revision,
      },
      {
        choiceId: CHOICE_TWO,
        catalogueItemId: CATALOGUE_TWO.id,
        expectedCatalogueRevision: CATALOGUE_TWO.revision,
      },
    ],
    freeLineChoiceId: CHOICE_FREE,
    occurredAt: WORKED_AT,
  });
  if (!presentedMission.ok) throw new Error('invalid catalogue mission fixture');
  return {
    ...fixture,
    mission: presentedMission.value.mission,
    work: presentedWork.value,
  };
}

function proposalFixture(
  selectedCatalogue: CatalogueCandidateRecord | null = CATALOGUE_ONE,
) {
  const fixture = selectedQuoteFixture();
  const work = queuedWork(selectedCatalogue === null
    ? {}
    : {
        serviceReference: 'deux heures de main-d’œuvre',
        unitPriceCents: null,
        priceBasis: null,
        requestedVatRate: null,
        catalogueResolution: 'selected',
        catalogueItemId: selectedCatalogue.id,
        expectedCatalogueRevision: selectedCatalogue.revision,
      });
  const derived = deriveQuoteLineProposal({
    workItem: work,
    payload: fixture.payload,
    selectedCatalogue,
    vatContext: VAT_CONTEXT,
  });
  if (derived.kind !== 'resolved') throw new Error('invalid proposal derivation fixture');
  const proposedWork = presentQuoteLineProposalOnWork({
    workItem: work,
    expectedRevision: work.revision,
    facts: derived.proposal.facts,
    proposalId: PROPOSAL_ID,
    proposalDiffHash: derived.proposal.diffHash,
    occurredAt: WORKED_AT,
  });
  if (!proposedWork.ok) {
    throw new Error(`invalid proposal work fixture: ${JSON.stringify(proposedWork.error)}`);
  }
  const proposedMission = fixture.mission.presentLineProposal({
    expectedRevision: 3,
    decisionId: DECISION_ID,
    pendingLineId: WORK_ID,
    proposalId: PROPOSAL_ID,
    expectedDraft: {
      sessionId: DRAFT_SESSION_ID,
      slotRevision: 2,
      contentRevision: 1,
    },
    expectedWorkRevision: proposedWork.value.revision,
    expectedCatalogue: selectedCatalogue === null
      ? null
      : {
          itemId: selectedCatalogue.id,
          revision: selectedCatalogue.revision,
        },
    expectedVatContextDigest: computeQuoteVatContextDigest(VAT_CONTEXT),
    diffHash: derived.proposal.diffHash,
    confirmChoiceId: CHOICE_CONFIRM,
    editChoiceId: CHOICE_EDIT,
    cancelChoiceId: CHOICE_CANCEL,
    occurredAt: WORKED_AT,
  });
  if (!proposedMission.ok) throw new Error('invalid proposal mission fixture');
  return {
    ...fixture,
    mission: proposedMission.value.mission,
    work: proposedWork.value,
    proposal: derived.proposal,
    selectedCatalogue,
  };
}

function draftConflictFixture(
  requestDiscard: boolean,
): {
  readonly mission: AgentMission;
  readonly slot: AgentMissionQuoteDraftSlot;
} {
  const payload = createEmptyQuoteDraftPayload(DRAFT_SESSION_ID);
  if (!payload.ok) throw new Error('invalid conflict draft fixture');
  const started = AgentMission.start({
    id: MISSION_ID,
    ...OWNER,
    protocolVersion: 2,
    createdAt: '2026-07-30T08:00:00.000Z',
    stagedCustomerResolution: null,
    startOutcome: 'draft_conflict',
    existingDraft: {
      sessionId: DRAFT_SESSION_ID,
      slotRevision: 1,
      contentRevision: 0,
    },
    decision: {
      decisionId: DECISION_ID,
      resumeChoiceId: CHOICE_ONE,
      requestDiscardChoiceId: CHOICE_TWO,
    },
  });
  if (!started.ok) throw new Error('invalid conflict mission fixture');
  let mission = started.value.mission;
  if (requestDiscard) {
    const requested = mission.requestDraftDiscard({
      expectedRevision: 1,
      decisionId: DECISION_ID,
      choiceSetRevision: 1,
      choiceId: CHOICE_TWO,
      observedDraft: {
        sessionId: DRAFT_SESSION_ID,
        slotRevision: 1,
        contentRevision: 0,
      },
      nextDecision: {
        decisionId: '30000000-0000-4000-8000-000000000002',
        confirmChoiceId: '50000000-0000-4000-8000-000000000004',
        keepChoiceId: '50000000-0000-4000-8000-000000000005',
      },
      occurredAt: '2026-07-30T08:01:00.000Z',
    });
    if (!requested.ok) throw new Error('invalid discard request fixture');
    mission = requested.value.mission;
  }
  return {
    mission,
    slot: {
      ...OWNER,
      revision: 1,
      payloadVersion: 1,
      payload: payload.value,
      agentMissionId: null,
      createdAt: '2026-07-30T07:59:00.000Z',
      updatedAt: '2026-07-30T07:59:00.000Z',
    },
  };
}

describe('GetResumableQuoteAgentMissionV2', () => {
  it('refuse une identité invalide avant toute transaction', async () => {
    const unitOfWork = new ResumeV2MemoryUnitOfWork();

    await expect(new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute({
      companyId: ' company-1',
      ownerUserId: 'owner-1',
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
    expect(unitOfWork.calls).toBe(0);
  });

  it('retourne un vide honnête seulement sans mission ni marqueur de brouillon', async () => {
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = null;
    unitOfWork.slot = unitOfWork.slot === null
      ? null
      : { ...unitOfWork.slot, agentMissionId: null };

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toEqual({
      ok: true,
      value: { mission: null, presentation: null },
    });

    unitOfWork.slot = unitOfWork.slot === null
      ? null
      : { ...unitOfWork.slot, agentMissionId: MISSION_ID };
    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        cause: 'orphaned_draft_mission_owner',
      },
    });
  });

  it('projette le fait manquant et les fences de la tête durable', async () => {
    const fixture = detailsFixture();
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [fixture.work];

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        mission: { phase: 'awaiting_line_details' },
        presentation: {
          requiredFact: 'unit_price',
          pendingLine: {
            pendingLineId: WORK_ID,
            expectedWorkRevision: 2,
          },
          decision: null,
          catalogueChoices: [],
          freeLineChoiceId: null,
          proposalStatus: { kind: 'absent' },
          proposal: null,
        },
      },
    });
  });

  it.each([
    [false, 'awaiting_draft_decision'],
    [true, 'awaiting_draft_discard_confirmation'],
  ] as const)(
    'reprend le brouillon non revendiqué dans la phase %s',
    async (requestDiscard, phase) => {
      const fixture = draftConflictFixture(requestDiscard);
      const unitOfWork = new ResumeV2MemoryUnitOfWork();
      unitOfWork.mission = fixture.mission;
      unitOfWork.slot = fixture.slot;
      unitOfWork.workItems = [
        queuedWork({ catalogueResolution: 'pending' }),
      ];

      const result = await new GetResumableQuoteAgentMissionV2({
        unitOfWork,
      }).execute(OWNER);

      expect(result).toMatchObject({
        ok: true,
        value: {
          mission: {
            phase,
            draft: {
              sessionId: DRAFT_SESSION_ID,
              slotRevision: 1,
              contentRevision: 0,
            },
          },
          presentation: {
            decision: null,
            pendingLine: {
              pendingLineId: WORK_ID,
              expectedWorkRevision: 1,
            },
          },
        },
      });
    },
  );

  it.each([
    ['awaiting_quote_screen', false],
    ['awaiting_customer', true],
  ] as const)(
    'reprend la ligne initiale durable en phase %s avant sa convergence',
    async (phase, acknowledgeScreen) => {
      const payload = createEmptyQuoteDraftPayload(DRAFT_SESSION_ID);
      if (!payload.ok) throw new Error('invalid pre-line draft fixture');
      const started = AgentMission.start({
        id: MISSION_ID,
        ...OWNER,
        protocolVersion: 2,
        createdAt: '2026-07-30T08:00:00.000Z',
        stagedCustomerResolution: null,
        startOutcome: 'no_slot',
        draft: {
          sessionId: DRAFT_SESSION_ID,
          slotRevision: 1,
          contentRevision: 0,
        },
      });
      if (!started.ok) throw new Error('invalid pre-line mission fixture');
      const mission = acknowledgeScreen
        ? started.value.mission.acknowledgeQuoteScreen({
            expectedRevision: 1,
            binding: {
              realtimeSessionId: '70000000-0000-4000-8000-000000000001',
              contextRevision: 1,
              contextDigest: 'a'.repeat(64),
              screenName: '/devis/new',
              screenInstanceId: 'quote-line:pre-line',
              acknowledgedAt: '2026-07-30T08:01:00.000Z',
            },
            observedDraft: {
              sessionId: DRAFT_SESSION_ID,
              slotRevision: 1,
              contentRevision: 0,
            },
            draftHasCustomer: false,
            occurredAt: '2026-07-30T08:01:00.000Z',
          })
        : started;
      if (!mission.ok) throw new Error('invalid pre-line phase fixture');
      const unitOfWork = new ResumeV2MemoryUnitOfWork();
      unitOfWork.mission = mission.value.mission;
      unitOfWork.slot = {
        ...OWNER,
        revision: 1,
        payloadVersion: 1,
        payload: payload.value,
        agentMissionId: MISSION_ID,
        createdAt: '2026-07-30T08:00:00.000Z',
        updatedAt: '2026-07-30T08:00:00.000Z',
      };
      unitOfWork.workItems = [
        queuedWork({ catalogueResolution: 'pending' }),
      ];

      await expect(
        new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          mission: { phase },
          presentation: {
            pendingLine: {
              pendingLineId: WORK_ID,
              expectedWorkRevision: 1,
            },
          },
        },
      });
    },
  );

  it('conserve l’ordre scellé des choix mais ne fabrique jamais les données absentes', async () => {
    const fixture = catalogueChoiceFixture();
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [fixture.work];
    unitOfWork.catalogue = [CATALOGUE_TWO];

    const result = await new GetResumableQuoteAgentMissionV2({
      unitOfWork,
    }).execute(OWNER);

    expect(result).toMatchObject({
      ok: true,
      value: {
        mission: { phase: 'awaiting_catalogue_choice' },
        presentation: {
          pendingLine: {
            pendingLineId: WORK_ID,
            expectedWorkRevision: 2,
          },
          decision: {
            kind: 'catalogue',
            decisionId: DECISION_ID,
          },
          catalogueChoices: [
            {
              choiceId: CHOICE_ONE,
              available: false,
              label: null,
              category: null,
              unit: null,
              unitPriceCents: null,
              vatRate: null,
            },
            {
              choiceId: CHOICE_TWO,
              available: true,
              label: CATALOGUE_TWO.label,
              unitPriceCents: CATALOGUE_TWO.unitPriceHT,
            },
          ],
          freeLineChoiceId: CHOICE_FREE,
        },
      },
    });
    if (!result.ok || result.value.mission === null) {
      throw new Error('catalogue projection unexpectedly absent');
    }
    const persistedDecision = fixture.mission.payload.decision;
    if (persistedDecision?.kind !== 'catalogue') {
      throw new Error('catalogue decision fixture lost');
    }
    expect(result.value.presentation.decision).toEqual({
      kind: 'catalogue',
      decisionId: persistedDecision.decisionId,
      choiceSetRevision: persistedDecision.choiceSetRevision,
      pendingLineId: persistedDecision.pendingLineId,
      expectedDraft: persistedDecision.expectedDraft,
      expectedWorkRevision: persistedDecision.expectedWorkRevision,
      choices: persistedDecision.candidates,
      freeLineChoiceId: persistedDecision.freeLineChoiceId,
      choiceSetHash: persistedDecision.choiceSetHash,
    });
    expect(result.value.presentation.decision).not.toHaveProperty('candidates');
    expect(Object.keys(result.value.mission).sort()).toEqual([
      'actionable',
      'draft',
      'hardExpiresAt',
      'id',
      'idleExpiresAt',
      'phase',
      'revision',
      'status',
    ]);
  });

  it('redérive une proposition disponible depuis le catalogue et la TVA réels', async () => {
    const fixture = proposalFixture();
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [fixture.work];
    unitOfWork.catalogue = [CATALOGUE_ONE];

    const result = await new GetResumableQuoteAgentMissionV2({
      unitOfWork,
    }).execute(OWNER);

    expect(result).toMatchObject({
      ok: true,
      value: {
        mission: { phase: 'awaiting_line_confirmation' },
        presentation: {
          decision: {
            kind: 'line_confirmation',
            decisionId: DECISION_ID,
            choices: [
              { choiceId: CHOICE_CONFIRM, action: 'confirm_line' },
              { choiceId: CHOICE_EDIT, action: 'edit_line' },
              { choiceId: CHOICE_CANCEL, action: 'cancel_line' },
            ],
          },
          proposalStatus: { kind: 'available' },
          proposal: {
            proposalId: PROPOSAL_ID,
            diffHash: fixture.proposal.diffHash,
            line: fixture.proposal.line,
            catalogue: {
              itemId: CATALOGUE_ONE.id,
              revision: CATALOGUE_ONE.revision,
              label: CATALOGUE_ONE.label,
            },
          },
        },
      },
    });
  });

  it('annule les données métier de proposition quand le catalogue a évolué', async () => {
    const fixture = proposalFixture();
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [fixture.work];
    unitOfWork.catalogue = [{
      ...CATALOGUE_ONE,
      revision: CATALOGUE_ONE.revision + 1,
      label: 'Libellé révisé non confirmé',
    }];

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        presentation: {
          proposalStatus: {
            kind: 'stale',
            reason: 'catalogue_changed',
          },
          proposal: null,
        },
      },
    });
  });

  it('annule la proposition quand le contexte TVA ne reproduit plus le diff', async () => {
    const fixture = proposalFixture();
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [fixture.work];
    unitOfWork.catalogue = [CATALOGUE_ONE];
    unitOfWork.vatContext = {
      ...VAT_CONTEXT,
      companyTrade: 'coach',
    };

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        presentation: {
          proposalStatus: {
            kind: 'stale',
            reason: 'vat_context_changed',
          },
          proposal: null,
        },
      },
    });
  });

  it('redérive aussi une ligne libre sans inventer une origine catalogue', async () => {
    const fixture = proposalFixture(null);
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [fixture.work];
    unitOfWork.catalogue = [];

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        presentation: {
          proposalStatus: { kind: 'available' },
          proposal: {
            proposalId: PROPOSAL_ID,
            catalogue: null,
          },
        },
      },
    });
  });

  it.each([
    [
      'injectée',
      [
        CATALOGUE_ONE,
        CATALOGUE_TWO,
        { ...CATALOGUE_TWO, id: 'catalogue-injecte' },
      ],
    ],
    ['dupliquée', [CATALOGUE_ONE, CATALOGUE_ONE, CATALOGUE_TWO]],
  ] as const)('refuse une projection catalogue %s', async (_label, catalogue) => {
    const fixture = catalogueChoiceFixture();
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [fixture.work];
    unitOfWork.catalogue = catalogue;
    unitOfWork.catalogueReturnsUnfiltered = true;

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        cause: 'non_authoritative_catalogue_projection',
      },
    });
  });

  it('refuse une fence catalogue mission/work contradictoire', async () => {
    const fixture = proposalFixture();
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [{
      ...fixture.work,
      catalogueItemId: CATALOGUE_TWO.id,
      expectedCatalogueRevision: CATALOGUE_TWO.revision,
    }];

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        cause: 'phase_work_decision_mismatch',
      },
    });
  });

  it.each([
    [
      'déjà en attente',
      (head: AgentMissionQuoteLineWork): AgentMissionQuoteLineWork => ({
        ...head,
        id: '20000000-0000-4000-8000-000000000002',
        ordinal: 2,
      }),
    ],
    [
      'déjà résolue libre',
      (_head: AgentMissionQuoteLineWork): AgentMissionQuoteLineWork =>
        queuedWork({
          id: '20000000-0000-4000-8000-000000000002',
          ordinal: 2,
          catalogueResolution: 'free',
        }),
    ],
    [
      'déjà résolue catalogue',
      (_head: AgentMissionQuoteLineWork): AgentMissionQuoteLineWork =>
        queuedWork({
          id: '20000000-0000-4000-8000-000000000002',
          ordinal: 2,
          catalogueResolution: 'selected',
          catalogueItemId: CATALOGUE_ONE.id,
          expectedCatalogueRevision: CATALOGUE_ONE.revision,
        }),
    ],
  ] as const)('refuse une seconde ligne %s', async (_label, tailFactory) => {
    const fixture = detailsFixture();
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [fixture.work, tailFactory(fixture.work)];

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        cause: 'phase_work_decision_mismatch',
      },
    });
  });

  it('refuse une redérivation différente quand toutes les fences externes sont stables', async () => {
    const fixture = proposalFixture();
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [{
      ...fixture.work,
      category: 'travel',
      catalogueCategoryOverrideConfirmed: true,
    }];
    unitOfWork.catalogue = [CATALOGUE_ONE];

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        cause: 'proposal_redrive_mismatch',
      },
    });
  });

  it('projette honnêtement une tête queued sans prétendre déclencher sa convergence', async () => {
    const fixture = selectedQuoteFixture();
    const head = queuedWork({ catalogueResolution: 'pending' });
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [head];

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        mission: { phase: 'awaiting_lines' },
        presentation: {
          pendingLine: {
            pendingLineId: WORK_ID,
            expectedWorkRevision: 1,
          },
          decision: null,
          proposalStatus: { kind: 'absent' },
        },
      },
    });
  });

  it('échoue fermé si phase, décision et work item ne décrivent pas le même état', async () => {
    const fixture = catalogueChoiceFixture();
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.mission = fixture.mission;
    unitOfWork.slot = fixture.slot;
    unitOfWork.workItems = [{
      ...fixture.work,
      revision: fixture.work.revision + 1,
    }];

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        cause: 'phase_work_decision_mismatch',
      },
    });
  });

  it('ne transforme jamais une société fermée en mission absente', async () => {
    const unitOfWork = new ResumeV2MemoryUnitOfWork();
    unitOfWork.companyUnavailable = 'closed';

    await expect(
      new GetResumableQuoteAgentMissionV2({ unitOfWork }).execute(OWNER),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: 'unavailable',
        service: 'agent_mission_resume_company_closed',
      },
    });
  });
});
