import { describe, expect, it } from 'vitest';
import {
  AgentMission,
  type AgentMissionResult,
} from '../../domain/agent/agent-mission';
import {
  type AgentMissionEvent,
} from '../../domain/agent/agent-mission-event';
import { sha256Hex } from '../../shared-kernel/sha256';
import {
  applyQuoteDraftCustomerSelection,
} from '../quote-drafts/apply-quote-draft-transition';
import {
  createEmptyQuoteDraftPayload,
  type QuoteDraftPayloadV1,
} from '../quote-drafts/quote-draft-slot';
import {
  type AgentMissionFingerprintPort,
} from '../ports/agent-mission-fingerprint';
import {
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
} from '../ports/agent-mission-repository';
import {
  type AgentMissionReadExecution,
  type AgentMissionReadTransaction,
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionTransaction,
  type AgentMissionUnitOfWorkPort,
  type AgentMissionWriteExecution,
} from '../ports/agent-mission-unit-of-work';
import {
  type CatalogueCandidate,
} from '../ports/catalogue-candidate-search';
import {
  type IdGeneratorPort,
} from '../ports/services';
import {
  ContinueQuoteAgentMissionLineQueue,
} from './continue-quote-agent-mission-line-queue';
import {
  DecideQuoteAgentMissionCatalogueChoice,
} from './decide-quote-agent-mission-catalogue-choice';
import {
  type AgentMissionQuoteLineCandidateV1,
} from './quote-line-candidate';
import {
  type AgentMissionQuoteLineWork,
} from './quote-line-work';
import {
  StageQuoteAgentMissionLines,
} from './stage-quote-agent-mission-lines-command';

const OWNER = Object.freeze({
  companyId: 'company-1',
  ownerUserId: 'owner-1',
});
const MISSION_ID = '00000000-0000-4000-8000-000000000001';
const REALTIME_SESSION_ID = '00000000-0000-4000-8000-000000000002';
const TURN_ID = '00000000-0000-4000-8000-000000000003';
const STAGE_COMMAND = '10000000-0000-4000-8000-000000000001';
const CHOICE_COMMAND = '10000000-0000-4000-8000-000000000002';
const CREATED_AT = '2026-07-29T10:00:00.000Z';
const CONTEXT_DIGEST = 'd'.repeat(64);
const AUTHORITY = Object.freeze({
  protocolVersion: 2,
  subjectHashCandidates: Object.freeze(['a'.repeat(64)]),
  principalBindingHash: 'b'.repeat(64),
  capabilityHash: 'c'.repeat(64),
}) satisfies AgentMissionRealtimeAuthorityProof;
const VOICE_ORIGIN = {
  actor: 'user_voice',
  correlation: {
    realtimeSessionId: REALTIME_SESSION_ID,
    turnId: TURN_ID,
    contextRevision: 4,
    contextDigest: CONTEXT_DIGEST,
  },
} as const;
const LINE = Object.freeze({
  serviceReference: 'Main-d’œuvre plomberie',
  categoryHint: 'labor',
  quantityDecimal: '2',
  unitReference: 'heure',
  unitPriceDecimal: null,
  currency: null,
  priceBasis: null,
  vatRateHint: null,
}) satisfies AgentMissionQuoteLineCandidateV1;

const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(canonicalRequest) {
    return { keyVersion: 1, hmac: sha256Hex(canonicalRequest) };
  },
  matches(canonicalRequest, fingerprint) {
    return fingerprint.keyVersion === 1
      ? fingerprint.hmac === sha256Hex(canonicalRequest)
      : null;
  },
};

function value<T>(result: AgentMissionResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function payloadWithCustomer(): QuoteDraftPayloadV1 {
  const empty = createEmptyQuoteDraftPayload('quote-session-1');
  if (!empty.ok) throw new Error(JSON.stringify(empty.error));
  const selected = applyQuoteDraftCustomerSelection(empty.value, {
    id: 'customer-1',
    name: 'Camping Les Pins',
  });
  if (!selected.ok) throw new Error(JSON.stringify(selected.error));
  return selected.value;
}

function activeFixture(): {
  readonly mission: AgentMission;
  readonly slot: AgentMissionQuoteDraftSlot;
} {
  const started = value(AgentMission.start({
    id: MISSION_ID,
    ...OWNER,
    protocolVersion: 2,
    createdAt: CREATED_AT,
    stagedCustomerResolution: null,
    startOutcome: 'no_slot',
    draft: {
      sessionId: 'quote-session-1',
      slotRevision: 1,
      contentRevision: 0,
    },
  })).mission;
  const acknowledged = value(started.acknowledgeQuoteScreen({
    expectedRevision: 1,
    binding: {
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 4,
      contextDigest: CONTEXT_DIGEST,
      screenName: '/devis/new',
      screenInstanceId: 'quote-wizard-1',
      acknowledgedAt: '2026-07-29T10:00:01.000Z',
    },
    observedDraft: {
      sessionId: 'quote-session-1',
      slotRevision: 1,
      contentRevision: 0,
    },
    draftHasCustomer: false,
    occurredAt: '2026-07-29T10:00:01.000Z',
  })).mission;
  const selected = value(acknowledged.selectCustomer({
    expectedRevision: 2,
    source: 'screen_selection',
    customerId: 'customer-1',
    updatedDraft: {
      sessionId: 'quote-session-1',
      slotRevision: 2,
      contentRevision: 1,
    },
    occurredAt: '2026-07-29T10:00:02.000Z',
  })).mission;
  return {
    mission: selected,
    slot: {
      ...OWNER,
      agentMissionId: MISSION_ID,
      revision: 2,
      payloadVersion: 1,
      payload: payloadWithCustomer(),
      createdAt: CREATED_AT,
      updatedAt: '2026-07-29T10:00:02.000Z',
    },
  };
}

class SequenceIds implements IdGeneratorPort {
  private next = 1;

  get generated(): number {
    return this.next - 1;
  }

  newId(): string {
    const suffix = String(this.next).padStart(12, '0');
    this.next += 1;
    return `20000000-0000-4000-8000-${suffix}`;
  }
}

interface MemoryState {
  mission: AgentMission;
  events: AgentMissionEvent[];
  slot: AgentMissionQuoteDraftSlot;
  workItems: Map<string, AgentMissionQuoteLineWork>;
  catalogue: CatalogueCandidate[];
}

function cloneSlot(slot: AgentMissionQuoteDraftSlot): AgentMissionQuoteDraftSlot {
  return JSON.parse(JSON.stringify(slot)) as AgentMissionQuoteDraftSlot;
}

function cloneState(state: MemoryState): MemoryState {
  return {
    mission: state.mission,
    events: [...state.events],
    slot: cloneSlot(state.slot),
    workItems: new Map(state.workItems),
    catalogue: state.catalogue.map((item) => ({ ...item })),
  };
}

function sameOwner(
  owner: AgentMissionOwner,
  entity: { readonly companyId: string; readonly ownerUserId: string },
): boolean {
  return owner.companyId === entity.companyId
    && owner.ownerUserId === entity.ownerUserId;
}

class M2A1MemoryUnitOfWork implements AgentMissionUnitOfWorkPort {
  private state: MemoryState;
  now = '2026-07-29T10:00:03.000Z';
  searchCalls = 0;
  catalogueGetCalls = 0;
  queueListCalls = 0;
  workInsertCalls = 0;
  realtimeSessionId = REALTIME_SESSION_ID;
  appliedContext: { readonly revision: number; readonly digest: string } | null = {
    revision: 4,
    digest: CONTEXT_DIGEST,
  };

  constructor() {
    const fixture = activeFixture();
    this.state = {
      mission: fixture.mission,
      events: [],
      slot: fixture.slot,
      workItems: new Map(),
      catalogue: [],
    };
  }

  snapshot(): MemoryState {
    return cloneState(this.state);
  }

  setCatalogue(candidates: readonly CatalogueCandidate[]): void {
    this.state = {
      ...this.state,
      catalogue: candidates.map((candidate) => ({ ...candidate })),
    };
  }

  reviseCatalogue(id: string, revision: number): void {
    this.state = {
      ...this.state,
      catalogue: this.state.catalogue.map((candidate) => (
        candidate.id === id ? { ...candidate, revision } : candidate
      )),
    };
  }

  async readQuoteCreationOwner<T>(
    _owner: AgentMissionOwner,
    _authority: AgentMissionRealtimeAuthorityProof,
    _work: (transaction: AgentMissionReadTransaction) => Promise<T>,
  ): Promise<AgentMissionReadExecution<T>> {
    throw new Error('unused read transaction');
  }

  async runQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    authority: AgentMissionRealtimeAuthorityProof,
    work: (transaction: AgentMissionTransaction) => Promise<T>,
  ): Promise<AgentMissionWriteExecution<T>> {
    if (!sameOwner(owner, this.state.mission.toSnapshot()) || authority.protocolVersion !== 2) {
      return { status: 'capability_rejected', reason: 'not_found' };
    }
    const next = cloneState(this.state);
    const missionLookup = () => (
      sameOwner(owner, next.mission.toSnapshot())
        ? { status: 'known' as const, mission: next.mission }
        : null
    );
    const transaction = {
      databaseNow: async () => this.now,
      realtime: {
        realtimeSessionId: this.realtimeSessionId,
        appliedContext: this.appliedContext,
      },
      missions: {
        findActive: async () => (
          next.mission.status === 'active' ? next.mission : null
        ),
        findForeground: async () => missionLookup(),
        findById: async ({ missionId }: { readonly missionId: string }) => (
          missionId === next.mission.id ? missionLookup() : null
        ),
        findActiveForUpdate: async () => (
          next.mission.status === 'active' ? next.mission : null
        ),
        findForegroundForUpdate: async () => missionLookup(),
        findByIdForUpdate: async ({ missionId }: { readonly missionId: string }) => (
          missionId === next.mission.id ? missionLookup() : null
        ),
        insert: async () => 'conflict' as const,
        updateCas: async ({
          mission,
          expectedRevision,
        }: {
          readonly mission: AgentMission;
          readonly expectedRevision: number;
        }) => {
          if (
            mission.id !== next.mission.id
            || next.mission.revision !== expectedRevision
          ) return 'revision_conflict' as const;
          next.mission = mission;
          return 'updated' as const;
        },
      },
      events: {
        findByCommandId: async ({ commandId }: { readonly commandId: string }) => {
          const event = next.events.find(
            (candidate) => candidate.toSnapshot().commandId === commandId,
          );
          return event === undefined ? null : { status: 'known' as const, event };
        },
        append: async (event: AgentMissionEvent) => {
          const snapshot = event.toSnapshot();
          if (
            !sameOwner(owner, snapshot)
            || next.events.some((candidate) => {
              const current = candidate.toSnapshot();
              return current.commandId === snapshot.commandId
                || (
                  current.missionId === snapshot.missionId
                  && current.sequence === snapshot.sequence
                );
            })
          ) throw new Error('duplicate_or_cross_owner_event');
          next.events.push(event);
        },
      },
      quoteDrafts: {
        getForUpdate: async () => next.slot,
        create: async () => null,
        claim: async () => null,
        release: async ({ missionId }: { readonly missionId: string }) => {
          if (next.slot.agentMissionId !== missionId) return false;
          next.slot = {
            ...next.slot,
            agentMissionId: null,
            updatedAt: this.now,
          };
          return true;
        },
        selectCustomerCas: async () => null,
      },
      quoteLineWork: {
        listForUpdate: async () => {
          this.queueListCalls += 1;
          return [...next.workItems.values()]
            .sort((left, right) => left.ordinal - right.ordinal);
        },
        findByIdForUpdate: async ({
          workItemId,
        }: {
          readonly workItemId: string;
        }) => next.workItems.get(workItemId) ?? null,
        insertMany: async ({
          workItems,
        }: {
          readonly workItems: readonly AgentMissionQuoteLineWork[];
        }) => {
          this.workInsertCalls += 1;
          if (workItems.some((item) => (
            next.workItems.has(item.id)
            || [...next.workItems.values()].some(
              (current) => current.ordinal === item.ordinal,
            )
          ))) return 'conflict' as const;
          for (const item of workItems) next.workItems.set(item.id, item);
          return 'inserted' as const;
        },
        updateCas: async ({
          workItem,
          expectedRevision,
        }: {
          readonly workItem: AgentMissionQuoteLineWork;
          readonly expectedRevision: number;
        }) => {
          const current = next.workItems.get(workItem.id);
          if (
            current === undefined
            || current.revision !== expectedRevision
            || workItem.revision !== expectedRevision + 1
            || current.origin !== workItem.origin
            || current.ordinal !== workItem.ordinal
          ) return 'revision_conflict' as const;
          next.workItems.set(workItem.id, workItem);
          return 'updated' as const;
        },
        delete: async () => 'not_found' as const,
        deleteAll: async () => {
          const count = next.workItems.size;
          next.workItems.clear();
          return count;
        },
      },
      quoteScreen: {
        observeForUpdate: async () => ({
          status: 'rejected' as const,
          reason: 'unavailable' as const,
        }),
      },
      customers: {
        search: async () => [],
        findById: async () => null,
        findByIds: async () => [],
      },
      catalogueCandidates: {
        search: async () => {
          this.searchCalls += 1;
          return {
            candidates: next.catalogue.slice(0, 5),
            truncated: next.catalogue.length >= 6,
          };
        },
        getById: async ({
          id,
        }: {
          readonly id: string;
        }) => {
          this.catalogueGetCalls += 1;
          const found = next.catalogue.find((candidate) => candidate.id === id);
          if (found === undefined) return null;
          const { matchKind: _matchKind, ...record } = found;
          return record;
        },
      },
    } as unknown as AgentMissionTransaction;

    const output = await work(transaction);
    this.state = next;
    return { status: 'executed', value: output };
  }
}

function candidate(
  id: string,
  revision = 1,
  matchKind: CatalogueCandidate['matchKind'] = 'exact',
): CatalogueCandidate {
  return {
    id,
    label: `Prestation ${id}`,
    category: 'labor',
    unit: 'heure',
    unitPriceHT: 5_500,
    vatRate: 20,
    revision,
    matchKind,
  };
}

function suite() {
  const unitOfWork = new M2A1MemoryUnitOfWork();
  const ids = new SequenceIds();
  const deps = { unitOfWork, ids, fingerprints: FINGERPRINTS };
  return {
    unitOfWork,
    ids,
    stage: new StageQuoteAgentMissionLines(deps),
    continueQueue: new ContinueQuoteAgentMissionLineQueue(deps),
    decide: new DecideQuoteAgentMissionCatalogueChoice(deps),
  };
}

function stageInput(
  origin: typeof VOICE_ORIGIN | { readonly actor: 'user_tap'; readonly correlation: null }
    = VOICE_ORIGIN,
) {
  return {
    ...OWNER,
    authority: AUTHORITY,
    missionId: MISSION_ID,
    commandId: STAGE_COMMAND,
    expectedMissionRevision: 3,
    expectedDraftSessionId: 'quote-session-1',
    expectedDraftSlotRevision: 2,
    expectedDraftContentRevision: 1,
    origin,
    lines: [LINE],
  } as const;
}

async function prepareChoices(
  candidates: readonly CatalogueCandidate[],
) {
  const current = suite();
  current.unitOfWork.setCatalogue(candidates);
  const staged = await current.stage.execute(stageInput());
  expect(staged, JSON.stringify(staged)).toMatchObject({
    ok: true,
    value: { outcome: 'staged' },
  });
  const continued = await current.continueQueue.execute({
    ...OWNER,
    authority: AUTHORITY,
    missionId: MISSION_ID,
    parentCommandId: STAGE_COMMAND,
  });
  return { current, staged, continued };
}

describe('boucle M2-A-1 catalogue', () => {
  it('enchaîne staging → choix scellé → sélection réelle + ligne additionnelle atomique', async () => {
    const { current, continued } = await prepareChoices([
      candidate('catalogue-1'),
      candidate('catalogue-2', 3, 'token'),
    ]);
    expect(continued, JSON.stringify(continued)).toMatchObject({
      ok: true,
      value: {
        outcome: 'choices_presented',
        presentedChoiceCount: 3,
        mission: { phase: 'awaiting_catalogue_choice' },
      },
    });
    if (!continued.ok) return;
    const decision = continued.value.mission.payload.decision;
    expect(decision?.kind).toBe('catalogue');
    if (decision?.kind !== 'catalogue') return;
    const choice = decision.candidates[0];
    if (choice === undefined) throw new Error('missing choice fixture');
    const idsBeforeChoice = current.ids.generated;
    const chosen = await current.decide.execute({
      ...OWNER,
      authority: AUTHORITY,
      missionId: MISSION_ID,
      commandId: CHOICE_COMMAND,
      expectedMissionRevision: continued.value.mission.revision,
      expectedDraftSessionId: 'quote-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      origin: VOICE_ORIGIN,
      decisionId: decision.decisionId,
      choiceSetRevision: decision.choiceSetRevision,
      pendingLineId: decision.pendingLineId,
      expectedWorkRevision: decision.expectedWorkRevision,
      choiceId: choice.choiceId,
      additionalLines: [
        { ...LINE, serviceReference: 'Déplacement chantier' },
      ],
    });

    expect(chosen, JSON.stringify(chosen)).toMatchObject({
      ok: true,
      value: {
        outcome: 'selected',
        resolution: 'selected',
        mission: { phase: 'awaiting_lines' },
      },
    });
    const state = current.unitOfWork.snapshot();
    const ordered = [...state.workItems.values()]
      .sort((left, right) => left.ordinal - right.ordinal);
    expect(ordered).toHaveLength(2);
    expect(ordered[0]).toMatchObject({
      state: 'queued',
      catalogueResolution: 'selected',
      catalogueItemId: 'catalogue-1',
      expectedCatalogueRevision: 1,
      serviceReference: 'Main-d’œuvre plomberie',
      quantityMilli: 2_000,
      requiredFact: null,
      proposalId: null,
    });
    expect(ordered[1]).toMatchObject({
      ordinal: 2,
      origin: 'user_voice',
      serviceReference: 'Déplacement chantier',
      catalogueResolution: 'pending',
    });
    const selectionEvent = state.events.at(-1)?.toSnapshot();
    expect(selectionEvent).toMatchObject({
      eventType: 'catalogue_choice_selected',
      actor: 'user_voice',
      realtimeSessionId: REALTIME_SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 4,
      draftSlotRevisionBefore: 2,
      draftSlotRevisionAfter: 2,
      draftContentRevisionBefore: 1,
      draftContentRevisionAfter: 1,
    });

    const readsBeforeReplay = current.unitOfWork.catalogueGetCalls;
    const insertsBeforeReplay = current.unitOfWork.workInsertCalls;
    const idsBeforeReplay = current.ids.generated;
    const replayed = await current.decide.execute({
      ...OWNER,
      authority: AUTHORITY,
      missionId: MISSION_ID,
      commandId: CHOICE_COMMAND,
      expectedMissionRevision: continued.value.mission.revision,
      expectedDraftSessionId: 'quote-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      origin: VOICE_ORIGIN,
      decisionId: decision.decisionId,
      choiceSetRevision: decision.choiceSetRevision,
      pendingLineId: decision.pendingLineId,
      expectedWorkRevision: decision.expectedWorkRevision,
      choiceId: choice.choiceId,
      additionalLines: [
        { ...LINE, serviceReference: 'Déplacement chantier' },
      ],
    });
    expect(replayed).toMatchObject({
      ok: true,
      value: { outcome: 'replayed', resolution: 'selected' },
    });
    expect(current.unitOfWork.catalogueGetCalls).toBe(readsBeforeReplay);
    expect(current.unitOfWork.workInsertCalls).toBe(insertsBeforeReplay);
    expect(current.ids.generated).toBe(idsBeforeReplay);
    expect(idsBeforeReplay).toBeGreaterThan(idsBeforeChoice);
  });

  it('transforme un vrai zéro catalogue en ligne libre et rejoue sans nouvelle recherche', async () => {
    const current = suite();
    const staged = await current.stage.execute(stageInput());
    expect(staged.ok).toBe(true);
    const first = await current.continueQueue.execute({
      ...OWNER,
      authority: AUTHORITY,
      missionId: MISSION_ID,
      parentCommandId: STAGE_COMMAND,
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        outcome: 'catalogue_not_found',
        presentedChoiceCount: 0,
      },
    });
    expect([...current.unitOfWork.snapshot().workItems.values()][0]).toMatchObject({
      state: 'queued',
      catalogueResolution: 'free',
    });
    const searchCalls = current.unitOfWork.searchCalls;
    const replayed = await current.continueQueue.execute({
      ...OWNER,
      authority: AUTHORITY,
      missionId: MISSION_ID,
      parentCommandId: STAGE_COMMAND,
    });
    expect(replayed).toMatchObject({
      ok: true,
      value: { outcome: 'replayed' },
    });
    expect(current.unitOfWork.searchCalls).toBe(searchCalls);
  });

  it('traite une ancienne continuation non acquise comme superseded sans desserrer sa fence', async () => {
    const current = suite();
    const first = await current.stage.execute(stageInput());
    expect(first).toMatchObject({
      ok: true,
      value: { outcome: 'staged', mission: { revision: 4 } },
    });
    const second = await current.stage.execute({
      ...stageInput(),
      commandId: '12000000-0000-4000-8000-000000000099',
      expectedMissionRevision: 4,
      lines: [{ ...LINE, serviceReference: 'Deuxième ligne' }],
    });
    expect(second).toMatchObject({
      ok: true,
      value: { outcome: 'staged', mission: { revision: 5 } },
    });
    const searchesBefore = current.unitOfWork.searchCalls;
    const superseded = await current.continueQueue.execute({
      ...OWNER,
      authority: AUTHORITY,
      missionId: MISSION_ID,
      parentCommandId: STAGE_COMMAND,
    });
    expect(superseded).toMatchObject({
      ok: true,
      value: {
        outcome: 'superseded',
        mission: { revision: 5 },
        presentedChoiceCount: 0,
      },
    });
    expect(current.unitOfWork.searchCalls).toBe(searchesBefore);
  });

  it('refuse qu’une nouvelle session acquière une continuation fraîche de l’ancienne', async () => {
    const current = suite();
    const staged = await current.stage.execute(stageInput());
    expect(staged.ok).toBe(true);
    current.unitOfWork.realtimeSessionId =
      '20000000-0000-4000-8000-000000000099';
    current.unitOfWork.appliedContext = {
      revision: 5,
      digest: 'b'.repeat(64),
    };
    const result = await current.continueQueue.execute({
      ...OWNER,
      authority: AUTHORITY,
      missionId: MISSION_ID,
      parentCommandId: STAGE_COMMAND,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_line_continuation',
        reason: 'context_stale',
      },
    });
    expect(current.unitOfWork.searchCalls).toBe(0);
  });

  it('invalide le choix révisé sans le copier mais conserve les lignes du même tour', async () => {
    const { current, continued } = await prepareChoices([
      candidate('catalogue-1', 7),
    ]);
    if (!continued.ok) return;
    const decision = continued.value.mission.payload.decision;
    if (decision?.kind !== 'catalogue') return;
    const choice = decision.candidates[0];
    if (choice === undefined) return;
    current.unitOfWork.reviseCatalogue('catalogue-1', 8);

    const result = await current.decide.execute({
      ...OWNER,
      authority: AUTHORITY,
      missionId: MISSION_ID,
      commandId: CHOICE_COMMAND,
      expectedMissionRevision: continued.value.mission.revision,
      expectedDraftSessionId: 'quote-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      origin: VOICE_ORIGIN,
      decisionId: decision.decisionId,
      choiceSetRevision: decision.choiceSetRevision,
      pendingLineId: decision.pendingLineId,
      expectedWorkRevision: decision.expectedWorkRevision,
      choiceId: choice.choiceId,
      additionalLines: [{ ...LINE, serviceReference: 'Déplacement chantier' }],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: 'invalidated',
        resolution: null,
        invalidationReason: 'choice_set_stale',
      },
    });
    const workItems = [...current.unitOfWork.snapshot().workItems.values()];
    expect(workItems).toHaveLength(2);
    expect(workItems[0]).toMatchObject({
      state: 'queued',
      catalogueResolution: 'pending',
      catalogueItemId: null,
    });
    expect(workItems[1]).toMatchObject({
      state: 'queued',
      catalogueResolution: 'pending',
      serviceReference: 'Déplacement chantier',
      ordinal: 2,
    });
  });

  it('préserve un tap autonome sans fabriquer de corrélation', async () => {
    const current = suite();
    const result = await current.stage.execute(stageInput({
      actor: 'user_tap',
      correlation: null,
    }));
    expect(result.ok).toBe(true);
    expect(current.unitOfWork.snapshot().events[0]?.toSnapshot()).toMatchObject({
      actor: 'user_tap',
      realtimeSessionId: null,
      turnId: null,
      contextRevision: null,
      contextDigest: null,
    });
  });

  it('refuse un replay dont les faits changent avant toute nouvelle écriture', async () => {
    const current = suite();
    expect((await current.stage.execute(stageInput())).ok).toBe(true);
    const inserts = current.unitOfWork.workInsertCalls;
    const ids = current.ids.generated;
    const changed = await current.stage.execute({
      ...stageInput(),
      lines: [{ ...LINE, quantityDecimal: '3' }],
    });
    expect(changed).toMatchObject({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_command',
        reason: 'fingerprint_mismatch',
      },
    });
    expect(current.unitOfWork.workInsertCalls).toBe(inserts);
    expect(current.ids.generated).toBe(ids);
  });

  it('commit réellement expiration, nettoyage et événement avant de rendre le conflit', async () => {
    const current = suite();
    expect((await current.stage.execute(stageInput())).ok).toBe(true);
    current.unitOfWork.now = '2026-07-30T10:00:04.000Z';
    const expired = await current.stage.execute({
      ...stageInput(),
      commandId: '10000000-0000-4000-8000-000000000099',
      expectedMissionRevision: 4,
    });
    expect(expired).toMatchObject({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission',
        reason: 'expired',
      },
    });
    const state = current.unitOfWork.snapshot();
    expect(state.mission.status).toBe('expired');
    expect(state.workItems.size).toBe(0);
    expect(state.events.at(-1)?.toSnapshot().eventType).toBe('mission_expired');
  });
});
