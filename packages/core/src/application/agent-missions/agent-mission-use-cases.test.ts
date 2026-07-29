import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_IDLE_TTL_MS,
  type AgentMission,
  type AgentMissionKind,
} from '../../domain/agent/agent-mission';
import { type AgentMissionEvent } from '../../domain/agent/agent-mission-event';
import { sha256Hex } from '../../shared-kernel/sha256';
import {
  createEmptyQuoteDraftPayload,
  type QuoteDraftPayloadV1,
} from '../quote-drafts/quote-draft-slot';
import { type AgentMissionFingerprintPort } from '../ports/agent-mission-fingerprint';
import {
  type CustomerCandidateReference,
} from '../ports/customer-candidate-search';
import {
  type AgentMissionEventLookup,
  type AgentMissionForeground,
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
} from '../ports/agent-mission-repository';
import {
  type AgentMissionAuthorizedRealtimeLease,
  type AgentMissionReadExecution,
  type AgentMissionReadTransaction,
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionQuoteScreenObservation,
  type AgentMissionTransaction,
  type AgentMissionUnitOfWorkPort,
  type AgentMissionWriteExecution,
} from '../ports/agent-mission-unit-of-work';
import { type IdGeneratorPort } from '../ports/services';
import {
  AcknowledgeQuoteScreen,
  type AcknowledgeQuoteScreenInput,
} from './acknowledge-quote-screen';
import {
  AdvanceQuoteAgentMission,
  type AdvanceQuoteAgentMissionInput,
} from './advance-quote-agent-mission';
import {
  CancelQuoteAgentMission,
  type CancelQuoteAgentMissionInput,
} from './cancel-quote-agent-mission';
import {
  DecideQuoteAgentMission,
  type DecideQuoteAgentMissionInput,
} from './decide-quote-agent-mission';
import { GetActiveAgentMission } from './get-active-agent-mission';
import {
  StartQuoteAgentMission,
  type StartQuoteAgentMissionCommand,
} from './start-quote-agent-mission';
import { deriveAgentMissionSystemCommandId } from './agent-mission-application';
import {
  parseAgentMissionQuoteLineWork,
  type AgentMissionQuoteLineWork,
} from './quote-line-work';

const OWNER = {
  companyId: 'company-1',
  ownerUserId: 'owner-1',
} as const;
const OTHER_OWNER = {
  companyId: 'company-1',
  ownerUserId: 'owner-2',
} as const;
const START_COMMAND = '10000000-0000-4000-8000-000000000001';
const SECOND_START_COMMAND = '10000000-0000-4000-8000-000000000002';
const CANCEL_COMMAND = '10000000-0000-4000-8000-000000000003';
const ACK_COMMAND = '10000000-0000-4000-8000-000000000004';
const DECISION_COMMAND = '10000000-0000-4000-8000-000000000005';
const INITIAL_NOW = '2026-07-26T10:00:00.000Z';
const REALTIME_SESSION_ID = '30000000-0000-4000-8000-000000000001';
const TURN_ID = '30000000-0000-4000-8000-000000000002';
const SECOND_TURN_ID = '30000000-0000-4000-8000-000000000003';
const AUTHORITY = Object.freeze({
  subjectHashCandidates: Object.freeze(['a'.repeat(64)]),
  principalBindingHash: 'b'.repeat(64),
  capabilityHash: 'c'.repeat(64),
}) satisfies AgentMissionRealtimeAuthorityProof;

interface MemoryState {
  readonly missions: Map<string, AgentMission>;
  readonly events: AgentMissionEvent[];
  readonly customers: readonly CustomerCandidateReference[];
  readonly quoteLineWork: Map<string, AgentMissionQuoteLineWork>;
  slot: AgentMissionQuoteDraftSlot | null;
}

function emptyPayload(sessionId: string): QuoteDraftPayloadV1 {
  const parsed = createEmptyQuoteDraftPayload(sessionId);
  if (!parsed.ok) throw new Error(`invalid fixture: ${parsed.error.code}`);
  return parsed.value;
}

function cloneSlot(slot: AgentMissionQuoteDraftSlot | null): AgentMissionQuoteDraftSlot | null {
  return slot === null
    ? null
    : JSON.parse(JSON.stringify(slot)) as AgentMissionQuoteDraftSlot;
}

function cloneState(state: MemoryState): MemoryState {
  return {
    missions: new Map(state.missions),
    events: [...state.events],
    customers: state.customers.map((customer) => ({ ...customer })),
    quoteLineWork: new Map(state.quoteLineWork),
    slot: cloneSlot(state.slot),
  };
}

function sameOwner(
  owner: AgentMissionOwner,
  entity: { readonly companyId: string; readonly ownerUserId: string },
): boolean {
  return entity.companyId === owner.companyId && entity.ownerUserId === owner.ownerUserId;
}

class SequenceIds implements IdGeneratorPort {
  private next = 1;

  newId(): string {
    const suffix = String(this.next++).padStart(12, '0');
    return `20000000-0000-4000-8000-${suffix}`;
  }
}

const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(canonicalRequest) {
    return { keyVersion: 1, hmac: sha256Hex(canonicalRequest) };
  },
  matches(canonicalRequest, fingerprint) {
    if (fingerprint.keyVersion !== 1) return null;
    return fingerprint.hmac === sha256Hex(canonicalRequest);
  },
};

class MemoryAgentMissionUnitOfWork implements AgentMissionUnitOfWorkPort {
  private state: MemoryState = {
    missions: new Map(),
    events: [],
    customers: [],
    quoteLineWork: new Map(),
    slot: null,
  };

  now = INITIAL_NOW;
  failAtWrite: number | null = null;
  companyUnavailableReason: 'missing' | 'closed' | null = null;
  foregroundUnavailableReason:
    | 'lock_timeout'
    | 'query_canceled'
    | 'transaction_timeout'
    | null = null;
  foregroundOverride: AgentMissionForeground | null | undefined;
  eventLookupOverride: AgentMissionEventLookup | null | undefined;
  insertOutcome: 'inserted' | 'conflict' = 'inserted';
  insertConflictForeground: AgentMissionForeground | null | undefined;
  screenObservation: AgentMissionQuoteScreenObservation = {
    status: 'rejected',
    reason: 'unavailable',
  };
  readTransactions = 0;
  writeTransactions = 0;
  findByIdForUpdateCalls = 0;
  findByIdCalls = 0;
  findByCommandIdCalls = 0;
  customerSearches = 0;
  customerByIdOverride: CustomerCandidateReference | null | undefined;
  customersByIdsOverride: readonly CustomerCandidateReference[] | undefined;
  appliedContext: AgentMissionAuthorizedRealtimeLease['appliedContext'] = {
    revision: 4,
    digest: 'f'.repeat(64),
  };

  snapshot(): MemoryState {
    return cloneState(this.state);
  }

  setSlot(payload: QuoteDraftPayloadV1, revision = 1): void {
    this.state.slot = {
      ...OWNER,
      revision,
      payloadVersion: 1,
      payload,
      agentMissionId: null,
      createdAt: INITIAL_NOW,
      updatedAt: INITIAL_NOW,
    };
  }

  setCustomers(customers: readonly CustomerCandidateReference[]): void {
    this.state = {
      ...this.state,
      customers: customers.map((customer) => ({ ...customer })),
    };
  }

  async readQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    _authority: AgentMissionRealtimeAuthorityProof,
    work: (transaction: AgentMissionReadTransaction) => Promise<T>,
  ): Promise<AgentMissionReadExecution<T>> {
    this.readTransactions += 1;
    const state = this.state;
    const value = await work({
      databaseNow: async () => this.now,
      realtime: {
        realtimeSessionId: REALTIME_SESSION_ID,
        appliedContext: this.appliedContext,
      },
      missions: {
        findActive: async ({ kind }) => this.findActive(state, owner, kind),
        findForeground: async () => (
          this.foregroundOverride !== undefined
            ? this.foregroundOverride
            : this.findForeground(state, owner)
        ),
        findById: async ({ missionId }) => {
          this.findByIdCalls += 1;
          const mission = state.missions.get(missionId) ?? null;
          return mission !== null && sameOwner(owner, mission.toSnapshot())
            ? { status: 'known', mission }
            : null;
        },
      },
    });
    return { status: 'executed', value };
  }

  async runQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    _authority: AgentMissionRealtimeAuthorityProof,
    work: (transaction: AgentMissionTransaction) => Promise<T>,
  ): Promise<AgentMissionWriteExecution<T>> {
    this.writeTransactions += 1;
    if (this.companyUnavailableReason !== null) {
      return {
        status: 'company_unavailable',
        reason: this.companyUnavailableReason,
      };
    }
    if (this.foregroundUnavailableReason !== null) {
      return {
        status: 'foreground_unavailable',
        reason: this.foregroundUnavailableReason,
      };
    }
    const nextState = cloneState(this.state);
    let writeCount = 0;
    let insertConflictObserved = false;
    const beforeWrite = (): void => {
      writeCount += 1;
      if (this.failAtWrite === writeCount) throw new Error(`injected-write-${writeCount}`);
    };
    const scopedSlot = (): AgentMissionQuoteDraftSlot | null => (
      nextState.slot !== null && sameOwner(owner, nextState.slot) ? nextState.slot : null
    );
    const activeQuoteMission = (
      scope: AgentMissionOwner & { readonly missionId: string },
    ): boolean => {
      if (!sameOwner(owner, scope)) return false;
      const mission = nextState.missions.get(scope.missionId);
      if (mission === undefined) return false;
      const snapshot = mission.toSnapshot();
      return sameOwner(owner, snapshot)
        && snapshot.kind === 'quote_creation'
        && snapshot.status === 'active';
    };
    const transaction: AgentMissionTransaction = {
      databaseNow: async () => this.now,
      realtime: {
        realtimeSessionId: REALTIME_SESSION_ID,
        appliedContext: this.appliedContext,
      },
      missions: {
        findActive: async ({ kind }) => this.findActive(nextState, owner, kind),
        findForeground: async () => (
          this.foregroundOverride !== undefined
            ? this.foregroundOverride
            : this.findForeground(nextState, owner)
        ),
        findById: async ({ missionId }) => {
          this.findByIdCalls += 1;
          const mission = nextState.missions.get(missionId) ?? null;
          return mission !== null && sameOwner(owner, mission.toSnapshot())
            ? { status: 'known', mission }
            : null;
        },
        findActiveForUpdate: async ({ kind }) => this.findActive(nextState, owner, kind),
        findForegroundForUpdate: async () => (
          insertConflictObserved && this.insertConflictForeground !== undefined
            ? this.insertConflictForeground
            : this.foregroundOverride !== undefined
              ? this.foregroundOverride
              : this.findForeground(nextState, owner)
        ),
        findByIdForUpdate: async ({ missionId }) => {
          this.findByIdForUpdateCalls += 1;
          const mission = nextState.missions.get(missionId) ?? null;
          return mission !== null && sameOwner(owner, mission.toSnapshot())
            ? { status: 'known', mission }
            : null;
        },
        insert: async (mission) => {
          beforeWrite();
          if (this.insertOutcome === 'conflict') {
            insertConflictObserved = true;
            return 'conflict';
          }
          if (nextState.missions.has(mission.id)) throw new Error('duplicate mission');
          nextState.missions.set(mission.id, mission);
          return 'inserted';
        },
        updateCas: async ({ mission, expectedRevision }) => {
          beforeWrite();
          const current = nextState.missions.get(mission.id);
          if (
            current === undefined
            || !sameOwner(owner, current.toSnapshot())
            || current.revision !== expectedRevision
          ) {
            return 'revision_conflict';
          }
          nextState.missions.set(mission.id, mission);
          return 'updated';
        },
      },
      events: {
        findByCommandId: async ({ commandId }) => {
          this.findByCommandIdCalls += 1;
          if (this.eventLookupOverride !== undefined) {
            return this.eventLookupOverride;
          }
          const event = nextState.events.find((candidate) => {
            const snapshot = candidate.toSnapshot();
            return sameOwner(owner, snapshot) && snapshot.commandId === commandId;
          }) ?? null;
          return event === null ? null : { status: 'known', event };
        },
        append: async (event) => {
          beforeWrite();
          const snapshot = event.toSnapshot();
          if (!sameOwner(owner, snapshot)) throw new Error('cross-owner event');
          if (nextState.events.some((candidate) => {
            const current = candidate.toSnapshot();
            return (
              sameOwner(owner, current)
              && (current.commandId === snapshot.commandId
                || (
                  current.missionId === snapshot.missionId
                  && current.sequence === snapshot.sequence
                ))
            );
          })) {
            throw new Error('duplicate event');
          }
          nextState.events.push(event);
        },
      },
      quoteDrafts: {
        getForUpdate: async () => scopedSlot(),
        create: async ({ payload }) => {
          beforeWrite();
          if (scopedSlot() !== null) return null;
          nextState.slot = {
            ...owner,
            revision: 1,
            payloadVersion: 1,
            payload,
            agentMissionId: null,
            createdAt: this.now,
            updatedAt: this.now,
          };
          return nextState.slot;
        },
        claim: async ({
          missionId,
          expectedSlotRevision,
          expectedDraftSessionId,
        }) => {
          beforeWrite();
          const slot = scopedSlot();
          if (
            slot === null
            || slot.agentMissionId !== null
            || slot.revision !== expectedSlotRevision
            || slot.payload.draft.sessionId !== expectedDraftSessionId
          ) {
            return null;
          }
          nextState.slot = { ...slot, agentMissionId: missionId, updatedAt: this.now };
          return nextState.slot;
        },
        release: async ({ missionId }) => {
          beforeWrite();
          const slot = scopedSlot();
          if (slot === null || slot.agentMissionId !== missionId) return false;
          nextState.slot = { ...slot, agentMissionId: null, updatedAt: this.now };
          return true;
        },
        selectCustomerCas: async ({
          missionId,
          expectedSlotRevision,
          expectedDraftSessionId,
          expectedDraftContentRevision,
          payload,
        }) => {
          beforeWrite();
          const slot = scopedSlot();
          if (
            slot === null
            || slot.agentMissionId !== missionId
            || slot.revision !== expectedSlotRevision
            || slot.payload.draft.sessionId !== expectedDraftSessionId
            || slot.payload.draft.contentRevision !== expectedDraftContentRevision
            || slot.payload.draft.step !== 'client'
            || slot.payload.draft.customer !== null
            || payload.draft.sessionId !== expectedDraftSessionId
            || payload.draft.contentRevision !== expectedDraftContentRevision + 1
            || payload.draft.step !== 'lignes'
            || payload.draft.customer === null
          ) {
            return null;
          }
          nextState.slot = {
            ...slot,
            revision: slot.revision + 1,
            payload,
            updatedAt: this.now,
          };
          return nextState.slot;
        },
      },
      quoteLineWork: {
        listForUpdate: async (scope) => (
          activeQuoteMission(scope)
            ? [...nextState.quoteLineWork.values()]
            .filter((item) => (
              sameOwner(owner, item) && item.missionId === scope.missionId
            ))
            .sort((left, right) => left.ordinal - right.ordinal)
            : []
        ),
        findByIdForUpdate: async (scope) => {
          if (!activeQuoteMission(scope)) return null;
          const { missionId, workItemId } = scope;
          const item = nextState.quoteLineWork.get(workItemId) ?? null;
          return item !== null
            && sameOwner(owner, item)
            && item.missionId === missionId
            ? item
            : null;
        },
        insertMany: async (scope) => {
          const { missionId, workItems } = scope;
          if (workItems.length === 0) return 'inserted';
          if (!activeQuoteMission(scope)) return 'conflict';
          const canonical = workItems.map((item) => {
            const parsed = parseAgentMissionQuoteLineWork(item);
            if (!parsed.ok) {
              throw new Error(
                `AGENT_MISSION_QUOTE_LINE_WORK_INPUT_INVALID:${parsed.error.field}:${
                  parsed.error.reason
                }`,
              );
            }
            return parsed.value;
          });
          if (
            canonical.some((item) => (
            item.missionId !== missionId
            || !sameOwner(owner, item)
              || item.revision !== 1
            ))
            || new Set(canonical.map((item) => item.id)).size !== canonical.length
            || new Set(canonical.map((item) => item.ordinal)).size !== canonical.length
          ) {
            throw new Error('AGENT_MISSION_QUOTE_LINE_WORK_INSERT_SCOPE_INVALID');
          }
          if (canonical.some((item) => (
            nextState.quoteLineWork.has(item.id)
            || [...nextState.quoteLineWork.values()].some((current) => (
              current.missionId === missionId && current.ordinal === item.ordinal
            ))
          ))) {
            return 'conflict';
          }
          beforeWrite();
          for (const item of canonical) nextState.quoteLineWork.set(item.id, item);
          return 'inserted';
        },
        updateCas: async ({ workItem, expectedRevision }) => {
          const parsed = parseAgentMissionQuoteLineWork(workItem);
          if (!parsed.ok) {
            throw new Error(
              `AGENT_MISSION_QUOTE_LINE_WORK_INPUT_INVALID:${parsed.error.field}:${
                parsed.error.reason
              }`,
            );
          }
          const canonical = parsed.value;
          if (
            !Number.isSafeInteger(expectedRevision)
            || expectedRevision < 1
            || canonical.revision !== expectedRevision + 1
          ) {
            throw new Error('AGENT_MISSION_QUOTE_LINE_WORK_CAS_REVISION_INVALID');
          }
          if (!activeQuoteMission({
            companyId: canonical.companyId,
            ownerUserId: canonical.ownerUserId,
            missionId: canonical.missionId,
          })) {
            return 'revision_conflict';
          }
          const current = nextState.quoteLineWork.get(workItem.id);
          if (
            current === undefined
            || !sameOwner(owner, current)
            || current.missionId !== canonical.missionId
            || current.revision !== expectedRevision
          ) {
            return 'revision_conflict';
          }
          beforeWrite();
          nextState.quoteLineWork.set(workItem.id, canonical);
          return 'updated';
        },
        delete: async (scope) => {
          if (!activeQuoteMission(scope)) return 'not_found';
          const { missionId, workItemId, expectedRevision } = scope;
          const current = nextState.quoteLineWork.get(workItemId);
          if (
            current === undefined
            || !sameOwner(owner, current)
            || current.missionId !== missionId
          ) {
            return 'not_found';
          }
          if (current.revision !== expectedRevision) return 'revision_conflict';
          beforeWrite();
          nextState.quoteLineWork.delete(workItemId);
          return 'deleted';
        },
        deleteAll: async (scope) => {
          if (!activeQuoteMission(scope)) return 0;
          const { missionId } = scope;
          beforeWrite();
          let deleted = 0;
          for (const [id, item] of nextState.quoteLineWork) {
            if (sameOwner(owner, item) && item.missionId === missionId) {
              nextState.quoteLineWork.delete(id);
              deleted += 1;
            }
          }
          return deleted;
        },
      },
      quoteScreen: {
        observeForUpdate: async () => this.screenObservation,
      },
      customers: {
        search: async ({ query, limit }) => {
          this.customerSearches += 1;
          const normalizedQuery = query.normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .toLocaleLowerCase('fr-FR');
          return nextState.customers
            .map((customer) => {
              const normalizedName = customer.canonicalName.normalize('NFD')
                .replace(/\p{Diacritic}/gu, '')
                .toLocaleLowerCase('fr-FR');
              const exact = normalizedName === normalizedQuery;
              const fuzzy = normalizedName.includes(normalizedQuery)
                || normalizedQuery.includes(normalizedName);
              if (!exact && !fuzzy) return null;
              return {
                ...customer,
                matchKind: exact ? 'exact' as const : 'fuzzy' as const,
                score: exact ? 1 : 0.8,
              };
            })
            .filter((candidate) => candidate !== null)
            .sort((left, right) => (
              Number(right.matchKind === 'exact') - Number(left.matchKind === 'exact')
              || right.score - left.score
              || left.canonicalName.localeCompare(right.canonicalName, 'fr')
              || left.customerId.localeCompare(right.customerId)
            ))
            .slice(0, limit);
        },
        findById: async ({ customerId }) => (
          this.customerByIdOverride !== undefined
            ? this.customerByIdOverride
            : nextState.customers.find(
                (customer) => customer.customerId === customerId,
              ) ?? null
        ),
        findByIds: async ({ customerIds }) => {
          if (this.customersByIdsOverride !== undefined) {
            return this.customersByIdsOverride;
          }
          const ids = new Set(customerIds);
          return nextState.customers.filter((customer) => ids.has(customer.customerId));
        },
      },
    };
    const output = await work(transaction);
    this.state = nextState;
    return { status: 'executed', value: output };
  }

  private findActive(
    state: MemoryState,
    owner: AgentMissionOwner,
    kind: AgentMissionKind,
  ): AgentMission | null {
    return [...state.missions.values()].find((mission) => {
      const snapshot = mission.toSnapshot();
      return sameOwner(owner, snapshot) && snapshot.kind === kind && snapshot.status === 'active';
    }) ?? null;
  }

  private findForeground(
    state: MemoryState,
    owner: AgentMissionOwner,
  ): AgentMissionForeground | null {
    const mission = [...state.missions.values()].find((candidate) => {
      const snapshot = candidate.toSnapshot();
      return sameOwner(owner, snapshot) && snapshot.status === 'active';
    });
    return mission === undefined ? null : { status: 'known', mission };
  }
}

function useCases(unitOfWork = new MemoryAgentMissionUnitOfWork()) {
  const deps = {
    unitOfWork,
    fingerprints: FINGERPRINTS,
    ids: new SequenceIds(),
  };
  const start = new StartQuoteAgentMission(deps);
  const get = new GetActiveAgentMission({ unitOfWork });
  const cancel = new CancelQuoteAgentMission(deps);
  const acknowledge = new AcknowledgeQuoteScreen(deps);
  const advance = new AdvanceQuoteAgentMission(deps);
  const decide = new DecideQuoteAgentMission(deps);
  return {
    unitOfWork,
    start: {
      execute: (
        input: Omit<
          StartQuoteAgentMissionCommand,
          'authority' | 'origin' | 'customerReference'
        > & Partial<Pick<StartQuoteAgentMissionCommand, 'origin' | 'customerReference'>>,
      ) => start.execute({
        ...input,
        authority: AUTHORITY,
        origin: input.origin ?? { actor: 'user_tap', correlation: null },
        customerReference: input.customerReference ?? null,
      }),
    },
    get: {
      execute: (owner: AgentMissionOwner) => get.execute(owner, AUTHORITY),
    },
    cancel: {
      execute: (
        input: Omit<CancelQuoteAgentMissionInput, 'authority'>,
      ) => cancel.execute({ ...input, authority: AUTHORITY }),
    },
    acknowledge: {
      execute: (
        input: Omit<AcknowledgeQuoteScreenInput, 'authority'>,
      ) => acknowledge.execute({ ...input, authority: AUTHORITY }),
    },
    advance: {
      execute: (
        input: Omit<AdvanceQuoteAgentMissionInput, 'authority'>,
      ) => advance.execute({ ...input, authority: AUTHORITY }),
    },
    decide: {
      execute: (
        input: Omit<DecideQuoteAgentMissionInput, 'authority'>,
      ) => decide.execute({ ...input, authority: AUTHORITY }),
    },
  };
}

async function preparedCustomerDecisionMission(input: {
  readonly customers: readonly CustomerCandidateReference[];
  readonly customerReference: string | null;
}) {
  const suite = useCases();
  suite.unitOfWork.setCustomers(input.customers);
  const started = await suite.start.execute({
    ...OWNER,
    commandId: START_COMMAND,
    customerReference: input.customerReference,
  });
  if (!started.ok || started.value.mission.payload.draft === null) {
    throw new Error('customer decision fixture start failed');
  }
  const draft = started.value.mission.payload.draft;
  const contextRevision = 7;
  const contextDigest = 'd'.repeat(64);
  suite.unitOfWork.appliedContext = { revision: contextRevision, digest: contextDigest };
  suite.unitOfWork.screenObservation = {
    status: 'ready',
    realtimeSessionId: REALTIME_SESSION_ID,
    contextRevision,
    contextDigest,
    screenInstanceId: 'quote-wizard-instance-decision',
    draft,
    draftHasCustomer: false,
  };
  const acknowledged = await suite.acknowledge.execute({
    ...OWNER,
    missionId: started.value.mission.id,
    commandId: ACK_COMMAND,
    expectedMissionRevision: started.value.mission.revision,
    realtimeSessionId: REALTIME_SESSION_ID,
    contextRevision,
    contextDigest,
    draftSessionId: draft.sessionId,
    expectedDraftSlotRevision: draft.slotRevision,
    expectedDraftContentRevision: draft.contentRevision,
  });
  if (!acknowledged.ok) throw new Error('customer decision fixture ACK failed');
  if (input.customerReference === null) {
    return {
      ...suite,
      mission: acknowledged.value.mission,
      contextRevision,
      contextDigest,
    };
  }
  const advanced = await suite.advance.execute({
    ...OWNER,
    missionId: started.value.mission.id,
    acknowledgementCommandId: ACK_COMMAND,
  });
  if (!advanced.ok) throw new Error('customer decision fixture advance failed');
  return {
    ...suite,
    mission: advanced.value.mission,
    contextRevision,
    contextDigest,
  };
}

describe('AgentMission application M1-A', () => {
  it('dérive une commande système stable depuis la deadline persistée, pas depuis le retry', () => {
    const input = {
      operation: 'expire_quote_creation' as const,
      ...OWNER,
      missionId: '20000000-0000-4000-8000-000000000001',
      missionRevision: 1,
      effectiveReason: 'idle_ttl' as const,
      effectiveExpiresAt: '2026-07-27T10:00:00.000Z',
    };
    const commandId = deriveAgentMissionSystemCommandId(input);
    expect(commandId).toBe(deriveAgentMissionSystemCommandId({ ...input }));
    expect(commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(new Set([
      commandId,
      deriveAgentMissionSystemCommandId({ ...input, ownerUserId: 'owner-2' }),
      deriveAgentMissionSystemCommandId({ ...input, missionRevision: 2 }),
      deriveAgentMissionSystemCommandId({ ...input, effectiveReason: 'hard_ttl' }),
      deriveAgentMissionSystemCommandId({
        ...input,
        effectiveExpiresAt: '2026-07-27T10:00:00.001Z',
      }),
    ])).toHaveLength(5);
  });

  it('réserve UUID v8 au système et refuse sa collision aux commandes utilisateur', async () => {
    const { unitOfWork, start, cancel } = useCases();
    const systemCommandId = deriveAgentMissionSystemCommandId({
      operation: 'expire_quote_creation',
      ...OWNER,
      missionId: '20000000-0000-4000-8000-000000000001',
      missionRevision: 1,
      effectiveReason: 'idle_ttl',
      effectiveExpiresAt: '2026-07-27T10:00:00.000Z',
    });

    expect(await start.execute({ ...OWNER, commandId: systemCommandId })).toMatchObject({
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'commandId' }] },
    });
    expect(await cancel.execute({
      ...OWNER,
      missionId: '20000000-0000-4000-8000-000000000001',
      commandId: systemCommandId,
      expectedRevision: 1,
      reason: 'user_cancelled',
      actor: 'user_tap',
    })).toMatchObject({
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'commandId' }] },
    });
    expect(unitOfWork.writeTransactions).toBe(0);
    expect(unitOfWork.snapshot().events).toHaveLength(0);
  });

  it.each([
    ['closed', { kind: 'forbidden', reason: 'company_closed' }],
    ['missing', { kind: 'not_found', entity: 'company', id: 'current' }],
  ] as const)(
    'refuse start et cancel sans appeler le writer quand la société est %s',
    async (reason, expectedError) => {
      const { unitOfWork, start, cancel } = useCases();
      unitOfWork.companyUnavailableReason = reason;

      expect(await start.execute({ ...OWNER, commandId: START_COMMAND })).toEqual({
        ok: false,
        error: expectedError,
      });
      expect(await cancel.execute({
        ...OWNER,
        missionId: '20000000-0000-4000-8000-000000000001',
        commandId: CANCEL_COMMAND,
        expectedRevision: 1,
        reason: 'user_cancelled',
        actor: 'user_tap',
      })).toEqual({
        ok: false,
        error: expectedError,
      });
      const state = unitOfWork.snapshot();
      expect(state.missions.size).toBe(0);
      expect(state.events).toHaveLength(0);
      expect(state.slot).toBeNull();
    },
  );

  it.each(['lock_timeout', 'query_canceled', 'transaction_timeout'] as const)(
    'rend une contention foreground %s retentable sans état partiel',
    async (reason) => {
      const { unitOfWork, start } = useCases();
      unitOfWork.foregroundUnavailableReason = reason;

      await expect(
        start.execute({ ...OWNER, commandId: START_COMMAND }),
      ).resolves.toEqual({
        ok: false,
        error: {
          kind: 'unavailable',
          service: 'agent_mission_foreground',
          retryAfterSeconds: 1,
        },
      });
      const state = unitOfWork.snapshot();
      expect(state.missions.size).toBe(0);
      expect(state.events).toHaveLength(0);
      expect(state.slot).toBeNull();
    },
  );

  it('refuse un foreground de kind futur sans le parser comme un devis', async () => {
    const { unitOfWork, start, get } = useCases();
    unitOfWork.foregroundOverride = {
      status: 'unsupported_kind',
      missionId: '90000000-0000-4000-8000-000000000001',
      kind: 'maintenance_contract@1',
    };

    await expect(get.execute(OWNER)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_foreground',
        reason: 'active_mission_exists',
      },
    });
    await expect(
      start.execute({ ...OWNER, commandId: START_COMMAND }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_foreground',
        reason: 'active_mission_exists',
      },
    });
    const state = unitOfWork.snapshot();
    expect(state.missions.size).toBe(0);
    expect(state.events).toHaveLength(0);
    expect(state.slot).toBeNull();
  });

  it('refuse les commandes devis neuves sous un futur foreground avant la lecture quote-only', async () => {
    const futureForeground = {
      status: 'unsupported_kind',
      missionId: '90000000-0000-4000-8000-000000000001',
      kind: 'maintenance_contract@1',
    } as const;
    const expectedConflict = {
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_foreground',
        reason: 'active_mission_exists',
      },
    } as const;

    {
      const suite = useCases();
      const started = await suite.start.execute({ ...OWNER, commandId: START_COMMAND });
      if (!started.ok) throw new Error('cancel future foreground fixture failed');
      suite.unitOfWork.foregroundOverride = futureForeground;
      const before = suite.unitOfWork.snapshot();

      expect(await suite.cancel.execute({
        ...OWNER,
        missionId: started.value.mission.id,
        commandId: CANCEL_COMMAND,
        expectedRevision: started.value.mission.revision,
        reason: 'user_cancelled',
        actor: 'user_tap',
      })).toEqual(expectedConflict);
      expect(suite.unitOfWork.findByIdForUpdateCalls).toBe(0);
      expect(suite.unitOfWork.snapshot()).toEqual(before);
    }

    {
      const suite = useCases();
      const started = await suite.start.execute({ ...OWNER, commandId: START_COMMAND });
      if (!started.ok || started.value.mission.payload.draft === null) {
        throw new Error('ack future foreground fixture failed');
      }
      const draft = started.value.mission.payload.draft;
      suite.unitOfWork.foregroundOverride = futureForeground;
      const before = suite.unitOfWork.snapshot();

      expect(await suite.acknowledge.execute({
        ...OWNER,
        missionId: started.value.mission.id,
        commandId: ACK_COMMAND,
        expectedMissionRevision: started.value.mission.revision,
        realtimeSessionId: REALTIME_SESSION_ID,
        contextRevision: 1,
        contextDigest: 'd'.repeat(64),
        draftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
      })).toEqual(expectedConflict);
      expect(suite.unitOfWork.findByIdForUpdateCalls).toBe(0);
      expect(suite.unitOfWork.snapshot()).toEqual(before);
    }

    {
      const suite = await preparedCustomerDecisionMission({
        customers: [{
          customerId: 'customer-camping',
          canonicalName: 'Camping les Pins',
        }],
        customerReference: null,
      });
      const draft = suite.mission.payload.draft;
      if (draft === null) throw new Error('decision future foreground fixture failed');
      suite.unitOfWork.foregroundOverride = futureForeground;
      const before = suite.unitOfWork.snapshot();

      expect(await suite.decide.execute({
        ...OWNER,
        missionId: suite.mission.id,
        commandId: DECISION_COMMAND,
        expectedMissionRevision: suite.mission.revision,
        expectedDraftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
        origin: { actor: 'user_tap', correlation: null },
        decision: {
          action: 'select_screen_customer',
          customerId: 'customer-camping',
        },
      })).toEqual(expectedConflict);
      expect(suite.unitOfWork.findByIdForUpdateCalls).toBe(0);
      expect(suite.unitOfWork.snapshot()).toEqual(before);
    }

    {
      const suite = useCases();
      suite.unitOfWork.setCustomers([{
        customerId: 'customer-camping',
        canonicalName: 'Camping les Pins',
      }]);
      const started = await suite.start.execute({
        ...OWNER,
        commandId: START_COMMAND,
        customerReference: 'Camping les Pins',
      });
      if (!started.ok || started.value.mission.payload.draft === null) {
        throw new Error('advance future foreground fixture failed');
      }
      const draft = started.value.mission.payload.draft;
      suite.unitOfWork.screenObservation = {
        status: 'ready',
        realtimeSessionId: REALTIME_SESSION_ID,
        contextRevision: 1,
        contextDigest: 'd'.repeat(64),
        screenInstanceId: 'quote-wizard-instance-future-foreground',
        draft,
        draftHasCustomer: false,
      };
      expect(await suite.acknowledge.execute({
        ...OWNER,
        missionId: started.value.mission.id,
        commandId: ACK_COMMAND,
        expectedMissionRevision: started.value.mission.revision,
        realtimeSessionId: REALTIME_SESSION_ID,
        contextRevision: 1,
        contextDigest: 'd'.repeat(64),
        draftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
      })).toMatchObject({ ok: true, value: { outcome: 'acknowledged' } });
      suite.unitOfWork.foregroundOverride = futureForeground;
      const before = suite.unitOfWork.snapshot();

      expect(await suite.advance.execute({
        ...OWNER,
        missionId: started.value.mission.id,
        acknowledgementCommandId: ACK_COMMAND,
      })).toEqual(expectedConflict);
      expect(suite.unitOfWork.findByIdForUpdateCalls).toBe(0);
      expect(suite.unitOfWork.snapshot()).toEqual(before);
    }
  });

  it.each([
    {
      command: 'start',
      execute: (suite: ReturnType<typeof useCases>) => suite.start.execute({
        ...OWNER,
        commandId: START_COMMAND,
      }),
    },
    {
      command: 'cancel',
      execute: (suite: ReturnType<typeof useCases>) => suite.cancel.execute({
        ...OWNER,
        missionId: '20000000-0000-4000-8000-000000000001',
        commandId: CANCEL_COMMAND,
        expectedRevision: 1,
        reason: 'user_cancelled',
        actor: 'user_tap',
      }),
    },
    {
      command: 'screen ACK',
      execute: (suite: ReturnType<typeof useCases>) => suite.acknowledge.execute({
        ...OWNER,
        missionId: '20000000-0000-4000-8000-000000000001',
        commandId: ACK_COMMAND,
        expectedMissionRevision: 1,
        realtimeSessionId: REALTIME_SESSION_ID,
        contextRevision: 1,
        contextDigest: 'd'.repeat(64),
        draftSessionId: 'draft-session-future-event',
        expectedDraftSlotRevision: 1,
        expectedDraftContentRevision: 0,
      }),
    },
    {
      command: 'decision',
      execute: (suite: ReturnType<typeof useCases>) => suite.decide.execute({
        ...OWNER,
        missionId: '20000000-0000-4000-8000-000000000001',
        commandId: DECISION_COMMAND,
        expectedMissionRevision: 1,
        expectedDraftSessionId: 'draft-session-future-event',
        expectedDraftSlotRevision: 1,
        expectedDraftContentRevision: 0,
        origin: { actor: 'user_tap', correlation: null },
        decision: {
          action: 'select_screen_customer',
          customerId: 'customer-future-event',
        },
      }),
    },
    {
      command: 'advance ACK',
      execute: (suite: ReturnType<typeof useCases>) => suite.advance.execute({
        ...OWNER,
        missionId: '20000000-0000-4000-8000-000000000001',
        acknowledgementCommandId: ACK_COMMAND,
      }),
    },
  ])(
    'refuse le replay $command d’un event futur sans parser mission/payload ni écrire',
    async ({ execute }) => {
      const suite = useCases();
      suite.unitOfWork.eventLookupOverride = {
        status: 'unsupported_kind',
        missionId: '90000000-0000-4000-8000-000000000010',
        kind: 'equipment_maintenance@1',
      };
      const before = suite.unitOfWork.snapshot();

      await expect(execute(suite)).resolves.toEqual({
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission_kind',
          reason: 'unsupported_kind',
        },
      });

      expect(suite.unitOfWork.findByCommandIdCalls).toBe(1);
      expect(suite.unitOfWork.findByIdCalls).toBe(0);
      expect(suite.unitOfWork.findByIdForUpdateCalls).toBe(0);
      expect(suite.unitOfWork.snapshot()).toEqual(before);
    },
  );

  it('traduit un conflit d’insert sans foreground relisible en dépendance fermée', async () => {
    const { unitOfWork, start } = useCases();
    unitOfWork.insertOutcome = 'conflict';
    unitOfWork.insertConflictForeground = null;

    await expect(
      start.execute({ ...OWNER, commandId: START_COMMAND }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'agent_mission_repository',
        cause: 'insert_conflict_without_active_foreground',
      },
    });
    const state = unitOfWork.snapshot();
    expect(state.missions.size).toBe(0);
    expect(state.events).toHaveLength(0);
    expect(state.slot).toBeNull();
  });

  it('traduit un conflit d’insert avec foreground relisible en conflit métier', async () => {
    const { unitOfWork, start } = useCases();
    unitOfWork.insertOutcome = 'conflict';
    unitOfWork.insertConflictForeground = {
      status: 'unsupported_kind',
      missionId: '90000000-0000-4000-8000-000000000002',
      kind: 'maintenance_contract@1',
    };

    await expect(
      start.execute({ ...OWNER, commandId: START_COMMAND }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_foreground',
        reason: 'active_mission_exists',
      },
    });
    const state = unitOfWork.snapshot();
    expect(state.missions.size).toBe(0);
    expect(state.events).toHaveLength(0);
    expect(state.slot).toBeNull();
  });

  it('crée atomiquement le vrai brouillon, la mission et son événement initial', async () => {
    const { unitOfWork, start } = useCases();

    const result = await start.execute({ ...OWNER, commandId: START_COMMAND });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      outcome: 'created',
      startOutcome: 'no_slot',
      mission: {
        status: 'active',
        actionable: true,
        phase: 'awaiting_quote_screen',
        revision: 1,
      },
    });
    const state = unitOfWork.snapshot();
    expect(state.missions).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    expect(state.slot).toMatchObject({
      revision: 1,
      agentMissionId: result.value.mission.id,
      payload: { draft: { contentRevision: 0, step: 'client' } },
    });
    expect(state.events[0]?.toSnapshot()).toMatchObject({
      missionId: result.value.mission.id,
      commandId: START_COMMAND,
      actor: 'user_tap',
      eventType: 'mission_started',
      missionRevisionBefore: 0,
      missionRevisionAfter: 1,
      draftSlotRevisionBefore: null,
      draftSlotRevisionAfter: 1,
    });
  });

  it('journalise le join puis lie son replay à la mission d’origine après terminalisation', async () => {
    const { unitOfWork, start, cancel } = useCases();
    const created = await start.execute({ ...OWNER, commandId: START_COMMAND });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const afterCreation = unitOfWork.snapshot();

    const replayed = await start.execute({ ...OWNER, commandId: START_COMMAND });
    const joined = await start.execute({ ...OWNER, commandId: SECOND_START_COMMAND });

    expect(replayed).toMatchObject({ ok: true, value: { outcome: 'replayed' } });
    expect(joined).toMatchObject({
      ok: true,
      value: {
        outcome: 'joined_active',
        mission: { id: created.value.mission.id, revision: 2 },
      },
    });
    const afterJoin = unitOfWork.snapshot();
    expect(afterJoin.missions.size).toBe(afterCreation.missions.size);
    expect(afterJoin.events).toHaveLength(afterCreation.events.length + 1);
    expect(afterJoin.events.at(-1)?.toSnapshot()).toMatchObject({
      eventType: 'mission_joined',
      commandId: SECOND_START_COMMAND,
      missionId: created.value.mission.id,
      missionRevisionBefore: 1,
      missionRevisionAfter: 2,
    });
    expect(afterJoin.slot).toEqual(afterCreation.slot);

    const joinedReplay = await start.execute({ ...OWNER, commandId: SECOND_START_COMMAND });
    expect(joinedReplay).toMatchObject({
      ok: true,
      value: {
        outcome: 'replayed',
        mission: { id: created.value.mission.id, revision: 2 },
      },
    });
    expect(unitOfWork.snapshot().events).toHaveLength(afterJoin.events.length);

    expect(await cancel.execute({
      ...OWNER,
      missionId: created.value.mission.id,
      commandId: CANCEL_COMMAND,
      expectedRevision: 2,
      reason: 'user_cancelled',
      actor: 'user_tap',
    })).toMatchObject({ ok: true, value: { outcome: 'cancelled' } });
    const afterCancel = unitOfWork.snapshot();
    const replayAfterTerminal = await start.execute({
      ...OWNER,
      commandId: SECOND_START_COMMAND,
    });
    expect(replayAfterTerminal).toMatchObject({
      ok: true,
      value: {
        outcome: 'replayed',
        mission: { id: created.value.mission.id, status: 'cancelled' },
      },
    });
    expect(unitOfWork.snapshot().missions).toHaveLength(1);
    expect(unitOfWork.snapshot().events).toHaveLength(afterCancel.events.length);
  });

  it('refuse le replay historique si un autre kind possède désormais le foreground', async () => {
    const { unitOfWork, start, cancel } = useCases();
    const created = await start.execute({ ...OWNER, commandId: START_COMMAND });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await cancel.execute({
      ...OWNER,
      missionId: created.value.mission.id,
      commandId: CANCEL_COMMAND,
      expectedRevision: 1,
      reason: 'user_cancelled',
      actor: 'user_tap',
    })).toMatchObject({ ok: true, value: { outcome: 'cancelled' } });

    unitOfWork.foregroundOverride = {
      status: 'unsupported_kind',
      missionId: '90000000-0000-4000-8000-000000000099',
      kind: 'maintenance_contract',
    };
    const beforeReplay = unitOfWork.snapshot();

    const replayed = await start.execute({ ...OWNER, commandId: START_COMMAND });

    expect(replayed).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_foreground',
        reason: 'active_mission_exists',
      },
    });
    expect(unitOfWork.snapshot()).toEqual(beforeReplay);
  });

  it('présente un conflit réel sans modifier ni réclamer le brouillon significatif', async () => {
    const { unitOfWork, start } = useCases();
    const base = emptyPayload('existing-draft');
    const significant: QuoteDraftPayloadV1 = {
      ...base,
      draft: {
        ...base.draft,
        lineForm: { ...base.draft.lineForm, label: 'Main-d’œuvre plomberie' },
      },
    };
    unitOfWork.setSlot(significant, 7);
    const before = unitOfWork.snapshot().slot;

    const result = await start.execute({ ...OWNER, commandId: START_COMMAND });

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: 'created',
        startOutcome: 'draft_conflict',
        mission: { phase: 'awaiting_draft_decision' },
      },
    });
    const after = unitOfWork.snapshot();
    expect(after.slot).toEqual(before);
    expect(after.slot?.agentMissionId).toBeNull();
    expect(after.events[0]?.toSnapshot()).toMatchObject({
      draftSlotRevisionBefore: 7,
      draftSlotRevisionAfter: 7,
      draftContentRevisionBefore: 0,
      draftContentRevisionAfter: 0,
    });
  });

  it('terminalise une mission expirée une fois, libère son slot puis démarre la suivante', async () => {
    const { unitOfWork, start } = useCases();
    const first = await start.execute({ ...OWNER, commandId: START_COMMAND });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    unitOfWork.now = new Date(
      Date.parse(INITIAL_NOW) + AGENT_MISSION_IDLE_TTL_MS,
    ).toISOString();

    const second = await start.execute({ ...OWNER, commandId: SECOND_START_COMMAND });

    expect(second).toMatchObject({
      ok: true,
      value: {
        outcome: 'created',
        startOutcome: 'empty_slot_adopted',
      },
    });
    const state = unitOfWork.snapshot();
    const firstMission = state.missions.get(first.value.mission.id);
    expect(firstMission?.status).toBe('expired');
    expect(state.events.map((event) => event.toSnapshot().eventType)).toEqual([
      'mission_started',
      'mission_expired',
      'mission_started',
    ]);
    expect(state.slot?.agentMissionId).toBe(
      second.ok ? second.value.mission.id : 'unreachable',
    );
  });

  it(
    'terminalise une annulation utilisateur et libère le brouillon atomiquement',
    async () => {
      const reason = 'user_cancelled' as const;
      const { unitOfWork, start, cancel } = useCases();
      const started = await start.execute({ ...OWNER, commandId: START_COMMAND });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const beforePayload = unitOfWork.snapshot().slot?.payload;

      const result = await cancel.execute({
        ...OWNER,
        missionId: started.value.mission.id,
        commandId: CANCEL_COMMAND,
        expectedRevision: 1,
        reason,
        actor: 'user_tap',
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          outcome: 'cancelled',
          mission: { status: 'cancelled', actionable: false, revision: 2 },
        },
      });
      const state = unitOfWork.snapshot();
      expect(state.slot?.agentMissionId).toBeNull();
      expect(state.slot?.payload).toEqual(beforePayload);
      expect(state.events.at(-1)?.toSnapshot()).toMatchObject({
        eventType: 'mission_cancelled',
        data: { kind: 'mission_cancelled', reason },
      });

      const eventCount = state.events.length;
      const replayed = await cancel.execute({
        ...OWNER,
        missionId: started.value.mission.id,
        commandId: CANCEL_COMMAND,
        expectedRevision: 1,
        reason,
        actor: 'user_tap',
      });
      expect(replayed).toMatchObject({ ok: true, value: { outcome: 'replayed' } });
      expect(unitOfWork.snapshot().events).toHaveLength(eventCount);

      unitOfWork.foregroundOverride = {
        status: 'unsupported_kind',
        missionId: '90000000-0000-4000-8000-000000000099',
        kind: 'maintenance_contract',
      };
      const beforeBlockedReplay = unitOfWork.snapshot();
      expect(await cancel.execute({
        ...OWNER,
        missionId: started.value.mission.id,
        commandId: CANCEL_COMMAND,
        expectedRevision: 1,
        reason,
        actor: 'user_tap',
      })).toMatchObject({
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission_foreground',
          reason: 'active_mission_exists',
        },
      });
      expect(unitOfWork.snapshot()).toEqual(beforeBlockedReplay);
    },
  );

  it('autorise manual_handoff seulement après la sélection client et conserve le brouillon', async () => {
    const suite = await preparedCustomerDecisionMission({
      customers: [{
        customerId: 'customer-handoff',
        canonicalName: 'Client passation',
      }],
      customerReference: null,
    });
    const draft = suite.mission.payload.draft;
    if (draft === null) throw new Error('draft absent');
    const selected = await suite.decide.execute({
      ...OWNER,
      missionId: suite.mission.id,
      commandId: DECISION_COMMAND,
      expectedMissionRevision: suite.mission.revision,
      expectedDraftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
      origin: { actor: 'user_tap', correlation: null },
      decision: {
        action: 'select_screen_customer',
        customerId: 'customer-handoff',
      },
    });
    expect(selected).toMatchObject({
      ok: true,
      value: { outcome: 'selected', mission: { phase: 'awaiting_lines' } },
    });
    if (!selected.ok) return;
    const before = suite.unitOfWork.snapshot();

    const cancelled = await suite.cancel.execute({
      ...OWNER,
      missionId: selected.value.mission.id,
      commandId: CANCEL_COMMAND,
      expectedRevision: selected.value.mission.revision,
      reason: 'manual_handoff',
      actor: 'user_tap',
    });

    expect(cancelled).toMatchObject({
      ok: true,
      value: {
        outcome: 'cancelled',
        mission: {
          status: 'cancelled',
          actionable: false,
          revision: selected.value.mission.revision + 1,
        },
      },
    });
    const after = suite.unitOfWork.snapshot();
    expect(after.slot).toMatchObject({
      agentMissionId: null,
      revision: before.slot?.revision,
      payload: before.slot?.payload,
    });
    expect(after.events.at(-1)?.toSnapshot()).toMatchObject({
      eventType: 'mission_cancelled',
      data: { kind: 'mission_cancelled', reason: 'manual_handoff' },
    });

    expect(await suite.cancel.execute({
      ...OWNER,
      missionId: selected.value.mission.id,
      commandId: CANCEL_COMMAND,
      expectedRevision: selected.value.mission.revision,
      reason: 'manual_handoff',
      actor: 'user_tap',
    })).toMatchObject({
      ok: true,
      value: { outcome: 'replayed' },
    });
    expect(suite.unitOfWork.snapshot().events).toHaveLength(after.events.length);
  });

  it.each([2, 3])(
    'rollbacke mission, slot et événement si manual_handoff échoue au write %s',
    async (failureWrite) => {
      const suite = await preparedCustomerDecisionMission({
        customers: [{
          customerId: 'customer-handoff-rollback',
          canonicalName: 'Client rollback',
        }],
        customerReference: null,
      });
      const draft = suite.mission.payload.draft;
      if (draft === null) throw new Error('draft absent');
      const selected = await suite.decide.execute({
        ...OWNER,
        missionId: suite.mission.id,
        commandId: DECISION_COMMAND,
        expectedMissionRevision: suite.mission.revision,
        expectedDraftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
        origin: { actor: 'user_tap', correlation: null },
        decision: {
          action: 'select_screen_customer',
          customerId: 'customer-handoff-rollback',
        },
      });
      if (!selected.ok) throw new Error('selection failed');
      const before = suite.unitOfWork.snapshot();
      suite.unitOfWork.failAtWrite = failureWrite;

      await expect(suite.cancel.execute({
        ...OWNER,
        missionId: selected.value.mission.id,
        commandId: CANCEL_COMMAND,
        expectedRevision: selected.value.mission.revision,
        reason: 'manual_handoff',
        actor: 'user_tap',
      })).rejects.toThrow(`injected-write-${failureWrite}`);

      expect(suite.unitOfWork.snapshot()).toEqual(before);
    },
  );

  it('terminalise par expiration avant de refuser une annulation trop tardive', async () => {
    const { unitOfWork, start, cancel } = useCases();
    const started = await start.execute({ ...OWNER, commandId: START_COMMAND });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    unitOfWork.now = new Date(
      Date.parse(INITIAL_NOW) + AGENT_MISSION_IDLE_TTL_MS,
    ).toISOString();

    const result = await cancel.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      commandId: CANCEL_COMMAND,
      expectedRevision: 1,
      reason: 'user_cancelled',
      actor: 'user_tap',
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'agent_mission', reason: 'expired' },
    });
    const state = unitOfWork.snapshot();
    expect(state.missions.get(started.value.mission.id)?.status).toBe('expired');
    expect(state.slot?.agentMissionId).toBeNull();
    expect(state.events.map((event) => event.toSnapshot().eventType)).toEqual([
      'mission_started',
      'mission_expired',
    ]);

    const retried = await cancel.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      commandId: CANCEL_COMMAND,
      expectedRevision: 1,
      reason: 'user_cancelled',
      actor: 'user_tap',
    });
    expect(retried).toEqual(result);
    expect(unitOfWork.snapshot().events.map((event) => event.toSnapshot().eventType)).toEqual([
      'mission_started',
      'mission_expired',
    ]);
  });

  it('lit sans écrire, ne fuit pas un autre owner et projette une expiration sans mutation', async () => {
    const { unitOfWork, start, get } = useCases();
    const started = await start.execute({ ...OWNER, commandId: START_COMMAND });
    expect(started.ok).toBe(true);
    const eventCount = unitOfWork.snapshot().events.length;

    const visible = await get.execute(OWNER);
    const hidden = await get.execute(OTHER_OWNER);
    unitOfWork.now = new Date(
      Date.parse(INITIAL_NOW) + AGENT_MISSION_IDLE_TTL_MS,
    ).toISOString();
    const expiredProjection = await get.execute(OWNER);

    expect(visible).toMatchObject({ ok: true, value: { status: 'active', actionable: true } });
    expect(hidden).toEqual({ ok: true, value: null });
    expect(expiredProjection).toMatchObject({
      ok: true,
      value: { status: 'expired', actionable: false },
    });
    expect(unitOfWork.writeTransactions).toBe(1);
    expect(unitOfWork.readTransactions).toBe(3);
    expect(unitOfWork.snapshot().events).toHaveLength(eventCount);
    expect(
      started.ok
        ? unitOfWork.snapshot().missions.get(started.value.mission.id)?.status
        : 'unreachable',
    ).toBe('active');
  });

  it('ACK écran consomme le commandId v4, emploie les faits autoritaires et se rejoue sans écrire', async () => {
    const { unitOfWork, start, acknowledge } = useCases();
    const started = await start.execute({ ...OWNER, commandId: START_COMMAND });
    expect(started.ok).toBe(true);
    if (!started.ok || started.value.mission.payload.draft === null) return;
    const draft = started.value.mission.payload.draft;
    const contextDigest = 'd'.repeat(64);
    unitOfWork.screenObservation = {
      status: 'ready',
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 7,
      contextDigest,
      screenInstanceId: 'quote-wizard-instance-1',
      draft,
      draftHasCustomer: false,
    };
    const command = {
      ...OWNER,
      missionId: started.value.mission.id,
      commandId: ACK_COMMAND,
      expectedMissionRevision: started.value.mission.revision,
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 7,
      contextDigest,
      draftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
    };

    const acknowledged = await acknowledge.execute(command);
    expect(acknowledged).toMatchObject({
      ok: true,
      value: {
        outcome: 'acknowledged',
        mission: {
          phase: 'awaiting_customer',
          currentBinding: {
            realtimeSessionId: REALTIME_SESSION_ID,
            contextRevision: 7,
            contextDigest,
          },
        },
      },
    });
    const afterFirst = unitOfWork.snapshot();
    const ackEvent = afterFirst.events.at(-1)?.toSnapshot();
    expect(ackEvent).toMatchObject({
      eventType: 'screen_acknowledged',
      actor: 'system',
      commandId: ACK_COMMAND,
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 7,
      contextDigest,
    });
    const eventCount = afterFirst.events.length;

    const replayed = await acknowledge.execute(command);
    expect(replayed).toMatchObject({ ok: true, value: { outcome: 'replayed' } });
    expect(unitOfWork.snapshot().events).toHaveLength(eventCount);
  });

  it('ACK écran refuse une session différente de la lease avant toute mutation mission', async () => {
    const { unitOfWork, start, acknowledge } = useCases();
    const started = await start.execute({ ...OWNER, commandId: START_COMMAND });
    expect(started.ok).toBe(true);
    if (!started.ok || started.value.mission.payload.draft === null) return;
    const draft = started.value.mission.payload.draft;
    const revisionBefore = started.value.mission.revision;
    const eventCount = unitOfWork.snapshot().events.length;

    const rejected = await acknowledge.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      commandId: ACK_COMMAND,
      expectedMissionRevision: revisionBefore,
      realtimeSessionId: '30000000-0000-4000-8000-000000000099',
      contextRevision: 1,
      contextDigest: 'e'.repeat(64),
      draftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
    });

    expect(rejected).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_screen_ack',
        reason: 'context_stale',
      },
    });
    expect(unitOfWork.snapshot().missions.get(started.value.mission.id)?.revision)
      .toBe(revisionBefore);
    expect(unitOfWork.snapshot().events).toHaveLength(eventCount);
  });

  it('lie la référence et la provenance voix au start, sans rechercher au replay', async () => {
    const { unitOfWork, start } = useCases();
    unitOfWork.setCustomers([
      { customerId: 'customer-camping', canonicalName: 'Camping les Pins' },
      { customerId: 'customer-ratp', canonicalName: 'RATP' },
    ]);
    const origin = {
      actor: 'user_voice',
      correlation: {
        realtimeSessionId: REALTIME_SESSION_ID,
        turnId: TURN_ID,
        contextRevision: 4,
        contextDigest: 'f'.repeat(64),
      },
    } as const;
    const command = {
      ...OWNER,
      commandId: START_COMMAND,
      origin,
      customerReference: 'Camping les Pins',
    };

    const started = await start.execute(command);
    expect(started).toMatchObject({
      ok: true,
      value: {
        outcome: 'created',
        mission: {
          payload: {
            stagedCustomerResolution: {
              kind: 'exact',
              customerId: 'customer-camping',
            },
          },
        },
      },
    });
    expect(unitOfWork.customerSearches).toBe(1);
    expect(unitOfWork.snapshot().events[0]?.toSnapshot()).toMatchObject({
      actor: 'user_voice',
      realtimeSessionId: REALTIME_SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
    });

    expect(await start.execute(command)).toMatchObject({
      ok: true,
      value: { outcome: 'replayed' },
    });
    expect(unitOfWork.customerSearches).toBe(1);

    expect(await start.execute({
      ...command,
      customerReference: 'RATP',
    })).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_command',
        reason: 'fingerprint_mismatch',
      },
    });
    expect(unitOfWork.customerSearches).toBe(1);
  });

  it('refuse une provenance de session croisée avant recherche et écriture', async () => {
    const { unitOfWork, start } = useCases();
    unitOfWork.setCustomers([
      { customerId: 'customer-camping', canonicalName: 'Camping les Pins' },
    ]);

    const result = await start.execute({
      ...OWNER,
      commandId: START_COMMAND,
      customerReference: 'Camping les Pins',
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: '30000000-0000-4000-8000-000000000099',
          turnId: TURN_ID,
          contextRevision: 1,
          contextDigest: 'f'.repeat(64),
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_command',
        reason: 'context_stale',
      },
    });
    expect(unitOfWork.customerSearches).toBe(0);
    expect(unitOfWork.snapshot()).toMatchObject({
      events: [],
      slot: null,
    });
    expect(unitOfWork.snapshot().missions.size).toBe(0);
  });

  it.each([
    ['non appliqué', null],
    ['révision périmée', { revision: 3, digest: 'f'.repeat(64) }],
    ['digest périmé', { revision: 4, digest: 'e'.repeat(64) }],
  ] as const)(
    'refuse un contexte voix %s dans la transaction avant toute recherche',
    async (_label, appliedContext) => {
      const { unitOfWork, start } = useCases();
      unitOfWork.appliedContext = appliedContext;
      unitOfWork.setCustomers([
        { customerId: 'customer-camping', canonicalName: 'Camping les Pins' },
      ]);

      const result = await start.execute({
        ...OWNER,
        commandId: START_COMMAND,
        customerReference: 'Camping les Pins',
        origin: {
          actor: 'user_voice',
          correlation: {
            realtimeSessionId: REALTIME_SESSION_ID,
            turnId: TURN_ID,
            contextRevision: 4,
            contextDigest: 'f'.repeat(64),
          },
        },
      });

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission_command',
          reason: 'context_stale',
        },
      });
      expect(unitOfWork.customerSearches).toBe(0);
      expect(unitOfWork.snapshot()).toMatchObject({ events: [], slot: null });
      expect(unitOfWork.snapshot().missions.size).toBe(0);
    },
  );

  it('enchaîne exact staged → ACK réel → sélection client atomique et rejouable', async () => {
    const { unitOfWork, start, acknowledge, advance, cancel } = useCases();
    unitOfWork.setCustomers([
      { customerId: 'customer-camping', canonicalName: 'Camping les Pins' },
    ]);
    const started = await start.execute({
      ...OWNER,
      commandId: START_COMMAND,
      customerReference: 'Camping les Pins',
    });
    expect(started.ok).toBe(true);
    if (!started.ok || started.value.mission.payload.draft === null) return;
    const draft = started.value.mission.payload.draft;
    const contextDigest = 'd'.repeat(64);
    unitOfWork.screenObservation = {
      status: 'ready',
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 7,
      contextDigest,
      screenInstanceId: 'quote-wizard-instance-1',
      draft,
      draftHasCustomer: false,
    };
    const ackCommand = {
      ...OWNER,
      missionId: started.value.mission.id,
      commandId: ACK_COMMAND,
      expectedMissionRevision: started.value.mission.revision,
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 7,
      contextDigest,
      draftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
    };
    const acknowledged = await acknowledge.execute(ackCommand);
    expect(acknowledged).toMatchObject({
      ok: true,
      value: {
        outcome: 'acknowledged',
        receipt: {
          ackCommandId: ACK_COMMAND,
          missionId: started.value.mission.id,
          missionRevisionAfter: 2,
          realtimeSessionId: REALTIME_SESSION_ID,
          contextRevision: 7,
          contextDigest,
          occurredAt: INITIAL_NOW,
        },
        mission: {
          phase: 'awaiting_customer',
          payload: {
            stagedCustomerResolution: {
              kind: 'exact',
              customerId: 'customer-camping',
            },
          },
        },
      },
    });

    const advanced = await advance.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      acknowledgementCommandId: ACK_COMMAND,
    });
    expect(advanced).toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        mission: {
          phase: 'awaiting_lines',
          revision: 3,
          payload: { stagedCustomerResolution: null },
        },
      },
    });
    const afterAdvance = unitOfWork.snapshot();
    expect(afterAdvance.slot).toMatchObject({
      revision: 2,
      agentMissionId: started.value.mission.id,
      payload: {
        draft: {
          contentRevision: 1,
          step: 'lignes',
          customer: {
            id: 'customer-camping',
            name: 'Camping les Pins',
          },
        },
      },
    });
    const continuation = afterAdvance.events.at(-1)?.toSnapshot();
    expect(continuation).toMatchObject({
      eventType: 'customer_selected',
      actor: 'system',
      missionRevisionBefore: 2,
      missionRevisionAfter: 3,
      draftSlotRevisionBefore: 1,
      draftSlotRevisionAfter: 2,
      draftContentRevisionBefore: 0,
      draftContentRevisionAfter: 1,
      realtimeSessionId: REALTIME_SESSION_ID,
      turnId: null,
      contextRevision: 7,
      contextDigest,
      data: {
        kind: 'customer_selected',
        customerId: 'customer-camping',
        source: 'exact_match',
      },
    });
    expect(continuation?.commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    const replayedAdvance = await advance.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      acknowledgementCommandId: ACK_COMMAND,
    });
    expect(replayedAdvance).toMatchObject({
      ok: true,
      value: { outcome: 'replayed', mission: { revision: 3 } },
    });
    expect(unitOfWork.snapshot().events).toHaveLength(afterAdvance.events.length);

    const replayedAck = await acknowledge.execute(ackCommand);
    expect(replayedAck).toMatchObject({
      ok: true,
      value: {
        outcome: 'replayed',
        receipt: acknowledged.ok ? acknowledged.value.receipt : {},
        mission: { revision: 3 },
      },
    });

    expect(await cancel.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      commandId: CANCEL_COMMAND,
      expectedRevision: 3,
      reason: 'user_cancelled',
      actor: 'user_tap',
    })).toMatchObject({ ok: true, value: { outcome: 'cancelled' } });
    unitOfWork.foregroundOverride = {
      status: 'unsupported_kind',
      missionId: '90000000-0000-4000-8000-000000000099',
      kind: 'maintenance_contract',
    };
    const beforeBlockedReplays = unitOfWork.snapshot();
    expect(await advance.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      acknowledgementCommandId: ACK_COMMAND,
    })).toMatchObject({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_foreground',
        reason: 'active_mission_exists',
      },
    });
    expect(await acknowledge.execute(ackCommand)).toMatchObject({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_foreground',
        reason: 'active_mission_exists',
      },
    });
    expect(unitOfWork.snapshot()).toEqual(beforeBlockedReplays);
  });

  it('refuse une relecture client substituée par un adapter sans aucune écriture', async () => {
    const { unitOfWork, start, acknowledge, advance } = useCases();
    unitOfWork.setCustomers([
      { customerId: 'customer-camping', canonicalName: 'Camping les Pins' },
    ]);
    const started = await start.execute({
      ...OWNER,
      commandId: START_COMMAND,
      customerReference: 'Camping les Pins',
    });
    expect(started.ok).toBe(true);
    if (!started.ok || started.value.mission.payload.draft === null) return;
    const draft = started.value.mission.payload.draft;
    unitOfWork.screenObservation = {
      status: 'ready',
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      screenInstanceId: 'quote-wizard-instance-1',
      draft,
      draftHasCustomer: false,
    };
    expect(await acknowledge.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      commandId: ACK_COMMAND,
      expectedMissionRevision: started.value.mission.revision,
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      draftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
    })).toMatchObject({ ok: true });
    const before = unitOfWork.snapshot();
    unitOfWork.customerByIdOverride = {
      customerId: 'customer-substituted',
      canonicalName: 'Client substitué',
    };

    await expect(advance.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      acknowledgementCommandId: ACK_COMMAND,
    })).resolves.toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'customer_candidate_search',
        cause: 'invalid_customer_read',
      },
    });
    expect(unitOfWork.snapshot()).toEqual(before);
  });

  it('conserve un choix explicite après suppression concurrente de candidats', async () => {
    const { unitOfWork, start, acknowledge, advance } = useCases();
    unitOfWork.setCustomers([
      { customerId: 'customer-one', canonicalName: 'Camping Nord' },
      { customerId: 'customer-two', canonicalName: 'Camping Sud' },
    ]);
    const started = await start.execute({
      ...OWNER,
      commandId: START_COMMAND,
      customerReference: 'Camping',
    });
    expect(started.ok).toBe(true);
    if (!started.ok || started.value.mission.payload.draft === null) return;
    const draft = started.value.mission.payload.draft;
    const staged = started.value.mission.payload.stagedCustomerResolution;
    expect(staged?.kind).toBe('choices');
    unitOfWork.screenObservation = {
      status: 'ready',
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      screenInstanceId: 'quote-wizard-instance-1',
      draft,
      draftHasCustomer: false,
    };
    const acknowledged = await acknowledge.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      commandId: ACK_COMMAND,
      expectedMissionRevision: started.value.mission.revision,
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      draftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
    });
    expect(acknowledged.ok).toBe(true);
    unitOfWork.setCustomers([
      { customerId: 'customer-two', canonicalName: 'Camping Sud' },
    ]);

    const advanced = await advance.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      acknowledgementCommandId: ACK_COMMAND,
    });

    expect(advanced).toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        mission: {
          phase: 'awaiting_customer_choice',
          payload: {
            decision: {
              kind: 'customer',
              candidates: [{
                customerId: 'customer-two',
              }],
            },
            stagedCustomerResolution: null,
          },
        },
      },
    });
    if (staged?.kind === 'choices' && advanced.ok) {
      expect(advanced.value.mission.payload.decision).toMatchObject({
        candidates: [{
          choiceId: staged.candidates[1]?.choiceId,
          customerId: 'customer-two',
        }],
      });
    }
    expect(unitOfWork.snapshot().slot).toMatchObject({
      revision: 1,
      payload: { draft: { step: 'client', customer: null, contentRevision: 0 } },
    });
  });

  it('refuse qu’un adapter injecte un client hors du jeu staged', async () => {
    const { unitOfWork, start, acknowledge, advance } = useCases();
    unitOfWork.setCustomers([
      { customerId: 'customer-one', canonicalName: 'Camping Nord' },
      { customerId: 'customer-two', canonicalName: 'Camping Sud' },
    ]);
    const started = await start.execute({
      ...OWNER,
      commandId: START_COMMAND,
      customerReference: 'Camping',
    });
    expect(started.ok).toBe(true);
    if (!started.ok || started.value.mission.payload.draft === null) return;
    const draft = started.value.mission.payload.draft;
    unitOfWork.screenObservation = {
      status: 'ready',
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      screenInstanceId: 'quote-wizard-instance-1',
      draft,
      draftHasCustomer: false,
    };
    expect(await acknowledge.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      commandId: ACK_COMMAND,
      expectedMissionRevision: started.value.mission.revision,
      realtimeSessionId: REALTIME_SESSION_ID,
      contextRevision: 1,
      contextDigest: 'd'.repeat(64),
      draftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
    })).toMatchObject({ ok: true });
    const before = unitOfWork.snapshot();
    unitOfWork.customersByIdsOverride = [{
      customerId: 'customer-injected',
      canonicalName: 'Client injecté',
    }];

    await expect(advance.execute({
      ...OWNER,
      missionId: started.value.mission.id,
      acknowledgementCommandId: ACK_COMMAND,
    })).resolves.toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'customer_candidate_search',
        cause: 'invalid_customer_read',
      },
    });
    expect(unitOfWork.snapshot()).toEqual(before);
  });

  it('sélectionne au tap un client réel par une seule commande durable et rejouable', async () => {
    const suite = await preparedCustomerDecisionMission({
      customers: [{
        customerId: 'customer-camping',
        canonicalName: 'Camping les Pins — nom DB',
      }],
      customerReference: null,
    });
    const draft = suite.mission.payload.draft;
    expect(suite.mission.phase).toBe('awaiting_customer');
    if (draft === null) return;
    const command = {
      ...OWNER,
      missionId: suite.mission.id,
      commandId: DECISION_COMMAND,
      expectedMissionRevision: suite.mission.revision,
      expectedDraftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
      origin: { actor: 'user_tap', correlation: null },
      decision: {
        action: 'select_screen_customer',
        customerId: 'customer-camping',
      },
    } as const;

    const selected = await suite.decide.execute(command);

    expect(selected).toMatchObject({
      ok: true,
      value: {
        outcome: 'selected',
        mission: {
          phase: 'awaiting_lines',
          revision: suite.mission.revision + 1,
          payload: {
            draft: {
              sessionId: draft.sessionId,
              slotRevision: draft.slotRevision + 1,
              contentRevision: draft.contentRevision + 1,
            },
          },
        },
      },
    });
    const after = suite.unitOfWork.snapshot();
    expect(after.slot).toMatchObject({
      revision: draft.slotRevision + 1,
      payload: {
        draft: {
          step: 'lignes',
          contentRevision: draft.contentRevision + 1,
          customer: {
            id: 'customer-camping',
            name: 'Camping les Pins — nom DB',
          },
        },
      },
    });
    expect(after.events.at(-1)?.toSnapshot()).toMatchObject({
      eventType: 'customer_selected',
      actor: 'user_tap',
      commandId: DECISION_COMMAND,
      realtimeSessionId: REALTIME_SESSION_ID,
      turnId: null,
      contextRevision: suite.contextRevision,
      contextDigest: suite.contextDigest,
      data: {
        kind: 'customer_selected',
        source: 'screen_selection',
        customerId: 'customer-camping',
      },
    });

    expect(await suite.decide.execute(command)).toMatchObject({
      ok: true,
      value: { outcome: 'replayed' },
    });
    expect(suite.unitOfWork.snapshot().events).toHaveLength(after.events.length);
    expect(await suite.decide.execute({
      ...command,
      decision: {
        action: 'select_screen_customer',
        customerId: 'customer-other',
      },
    })).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_command',
        reason: 'fingerprint_mismatch',
      },
    });

    if (!selected.ok) return;
    expect(await suite.cancel.execute({
      ...OWNER,
      missionId: suite.mission.id,
      commandId: CANCEL_COMMAND,
      expectedRevision: selected.value.mission.revision,
      reason: 'user_cancelled',
      actor: 'user_tap',
    })).toMatchObject({ ok: true, value: { outcome: 'cancelled' } });
    suite.unitOfWork.foregroundOverride = {
      status: 'unsupported_kind',
      missionId: '90000000-0000-4000-8000-000000000099',
      kind: 'maintenance_contract',
    };
    const beforeBlockedReplay = suite.unitOfWork.snapshot();
    expect(await suite.decide.execute(command)).toMatchObject({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_foreground',
        reason: 'active_mission_exists',
      },
    });
    expect(suite.unitOfWork.snapshot()).toEqual(beforeBlockedReplay);
  });

  it('résout une référence vocale contre la BDD et sélectionne le nom canonique dans la même commande', async () => {
    const suite = await preparedCustomerDecisionMission({
      customers: [{
        customerId: 'customer-camping',
        canonicalName: 'Camping les Pins — nom DB',
      }],
      customerReference: null,
    });
    const draft = suite.mission.payload.draft;
    if (draft === null) return;
    const command = {
      ...OWNER,
      missionId: suite.mission.id,
      commandId: TURN_ID,
      expectedMissionRevision: suite.mission.revision,
      expectedDraftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: REALTIME_SESSION_ID,
          turnId: TURN_ID,
          contextRevision: suite.contextRevision,
          contextDigest: suite.contextDigest,
        },
      },
      decision: {
        action: 'resolve_customer_reference',
        customerReference: 'camping les pins — nom db',
      },
    } as const;

    expect(await suite.decide.execute(command)).toMatchObject({
      ok: true,
      value: {
        outcome: 'selected',
        mission: { phase: 'awaiting_lines' },
      },
    });
    const after = suite.unitOfWork.snapshot();
    expect(after.slot).toMatchObject({
      payload: {
        draft: {
          step: 'lignes',
          customer: {
            id: 'customer-camping',
            name: 'Camping les Pins — nom DB',
          },
        },
      },
    });
    expect(after.events.at(-1)?.toSnapshot()).toMatchObject({
      eventType: 'customer_selected',
      actor: 'user_voice',
      commandId: TURN_ID,
      turnId: TURN_ID,
      data: {
        kind: 'customer_selected',
        source: 'exact_match',
        customerId: 'customer-camping',
      },
    });
    expect(JSON.stringify(after.events.at(-1)?.toSnapshot())).not.toContain(
      'camping les pins — nom db',
    );
    expect(await suite.decide.execute(command)).toMatchObject({
      ok: true,
      value: { outcome: 'replayed' },
    });
    expect(suite.unitOfWork.snapshot().events).toHaveLength(after.events.length);
  });

  it('présente 1–5 choix réels puis remplace ce jeu par une nouvelle référence vocale exacte', async () => {
    const suite = await preparedCustomerDecisionMission({
      customers: [
        { customerId: 'customer-north', canonicalName: 'Camping Nord' },
        { customerId: 'customer-south', canonicalName: 'Camping Sud' },
      ],
      customerReference: null,
    });
    const draft = suite.mission.payload.draft;
    if (draft === null) return;
    const voiceOrigin = (turnId: string) => ({
      actor: 'user_voice' as const,
      correlation: {
        realtimeSessionId: REALTIME_SESSION_ID,
        turnId,
        contextRevision: suite.contextRevision,
        contextDigest: suite.contextDigest,
      },
    });
    const presented = await suite.decide.execute({
      ...OWNER,
      missionId: suite.mission.id,
      commandId: TURN_ID,
      expectedMissionRevision: suite.mission.revision,
      expectedDraftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
      origin: voiceOrigin(TURN_ID),
      decision: {
        action: 'resolve_customer_reference',
        customerReference: 'Camping',
      },
    });
    expect(presented).toMatchObject({
      ok: true,
      value: {
        outcome: 'presented',
        mission: {
          phase: 'awaiting_customer_choice',
          payload: {
            decision: {
              kind: 'customer',
              candidates: [
                { customerId: 'customer-north' },
                { customerId: 'customer-south' },
              ],
            },
          },
        },
      },
    });
    if (!presented.ok) return;

    const selected = await suite.decide.execute({
      ...OWNER,
      missionId: suite.mission.id,
      commandId: SECOND_TURN_ID,
      expectedMissionRevision: presented.value.mission.revision,
      expectedDraftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
      origin: voiceOrigin(SECOND_TURN_ID),
      decision: {
        action: 'resolve_customer_reference',
        customerReference: 'Camping Sud',
      },
    });
    expect(selected).toMatchObject({
      ok: true,
      value: {
        outcome: 'selected',
        mission: {
          phase: 'awaiting_lines',
          payload: { decision: null },
        },
      },
    });
    expect(suite.unitOfWork.snapshot().slot).toMatchObject({
      payload: {
        draft: {
          customer: { id: 'customer-south', name: 'Camping Sud' },
        },
      },
    });
    expect(suite.unitOfWork.snapshot().events.at(-1)?.toSnapshot()).toMatchObject({
      eventType: 'customer_selected',
      data: {
        kind: 'customer_selected',
        source: 'presented_choice',
      },
    });
  });

  it('journalise zéro et trop de résultats sans modifier le brouillon ni persister la requête', async () => {
    for (const testCase of [
      { reference: 'Introuvable', customers: [] },
      {
        reference: 'Camping',
        customers: Array.from({ length: 6 }, (_, index) => ({
          customerId: `customer-${index}`,
          canonicalName: `Camping ${index}`,
        })),
      },
    ] as const) {
      const suite = await preparedCustomerDecisionMission({
        customers: testCase.customers,
        customerReference: null,
      });
      const draft = suite.mission.payload.draft;
      if (draft === null) continue;
      const before = suite.unitOfWork.snapshot();
      const result = await suite.decide.execute({
        ...OWNER,
        missionId: suite.mission.id,
        commandId: TURN_ID,
        expectedMissionRevision: suite.mission.revision,
        expectedDraftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
        origin: {
          actor: 'user_voice',
          correlation: {
            realtimeSessionId: REALTIME_SESSION_ID,
            turnId: TURN_ID,
            contextRevision: suite.contextRevision,
            contextDigest: suite.contextDigest,
          },
        },
        decision: {
          action: 'resolve_customer_reference',
          customerReference: testCase.reference,
        },
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          outcome: 'not_found',
          mission: { phase: 'awaiting_customer', payload: { decision: null } },
        },
      });
      const after = suite.unitOfWork.snapshot();
      expect(after.slot).toEqual(before.slot);
      expect(after.events.at(-1)?.toSnapshot()).toMatchObject({
        eventType: 'customer_not_found',
        actor: 'user_voice',
      });
      expect(JSON.stringify(after.events.at(-1)?.toSnapshot())).not.toContain(
        testCase.reference,
      );
    }
  });

  it('relit les choix vocaux avant de les présenter et refuse toute substitution adapter', async () => {
    const buildSuite = () => preparedCustomerDecisionMission({
      customers: [
        { customerId: 'customer-north', canonicalName: 'Camping Nord' },
        { customerId: 'customer-south', canonicalName: 'Camping Sud' },
      ],
      customerReference: null,
    });
    const commandFor = (
      suite: Awaited<ReturnType<typeof buildSuite>>,
      draft: NonNullable<typeof suite.mission.payload.draft>,
    ) => ({
      ...OWNER,
      missionId: suite.mission.id,
      commandId: TURN_ID,
      expectedMissionRevision: suite.mission.revision,
      expectedDraftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
      origin: {
        actor: 'user_voice' as const,
        correlation: {
          realtimeSessionId: REALTIME_SESSION_ID,
          turnId: TURN_ID,
          contextRevision: suite.contextRevision,
          contextDigest: suite.contextDigest,
        },
      },
      decision: {
        action: 'resolve_customer_reference' as const,
        customerReference: 'Camping',
      },
    });

    const filtered = await buildSuite();
    const filteredDraft = filtered.mission.payload.draft;
    if (filteredDraft === null) return;
    filtered.unitOfWork.customersByIdsOverride = [{
      customerId: 'customer-south',
      canonicalName: 'Camping Sud',
    }];
    expect(await filtered.decide.execute(commandFor(filtered, filteredDraft)))
      .toMatchObject({
        ok: true,
        value: {
          outcome: 'presented',
          mission: {
            payload: {
              decision: {
                kind: 'customer',
                candidates: [{ customerId: 'customer-south' }],
              },
            },
          },
        },
      });

    const injected = await buildSuite();
    const injectedDraft = injected.mission.payload.draft;
    if (injectedDraft === null) return;
    injected.unitOfWork.customersByIdsOverride = [{
      customerId: 'customer-injected',
      canonicalName: 'Client injecté',
    }];
    const before = injected.unitOfWork.snapshot();
    expect(await injected.decide.execute(commandFor(injected, injectedDraft))).toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'customer_candidate_search',
        cause: 'invalid_customer_read',
      },
    });
    expect(injected.unitOfWork.snapshot()).toEqual(before);
  });

  it('donne exactement la même transition au choix présenté vocal et tactile', async () => {
    const customers = [
      { customerId: 'customer-one', canonicalName: 'Camping Nord' },
      { customerId: 'customer-two', canonicalName: 'Camping Sud' },
    ] as const;
    const tactile = await preparedCustomerDecisionMission({
      customers,
      customerReference: 'Camping',
    });
    const vocal = await preparedCustomerDecisionMission({
      customers,
      customerReference: 'Camping',
    });
    const tactileDraft = tactile.mission.payload.draft;
    const vocalDraft = vocal.mission.payload.draft;
    const tactileDecision = tactile.mission.payload.decision;
    const vocalDecision = vocal.mission.payload.decision;
    expect(tactile.mission.phase).toBe('awaiting_customer_choice');
    expect(vocal.mission).toEqual(tactile.mission);
    if (
      tactileDraft === null
      || vocalDraft === null
      || tactileDecision?.kind !== 'customer'
      || vocalDecision?.kind !== 'customer'
      || tactileDecision.candidates[1] === undefined
      || vocalDecision.candidates[1] === undefined
    ) return;
    const tactileChoice = tactileDecision.candidates[1];
    const vocalChoice = vocalDecision.candidates[1];

    const tactileResult = await tactile.decide.execute({
      ...OWNER,
      missionId: tactile.mission.id,
      commandId: DECISION_COMMAND,
      expectedMissionRevision: tactile.mission.revision,
      expectedDraftSessionId: tactileDraft.sessionId,
      expectedDraftSlotRevision: tactileDraft.slotRevision,
      expectedDraftContentRevision: tactileDraft.contentRevision,
      origin: { actor: 'user_tap', correlation: null },
      decision: {
        action: 'choose_presented_option',
        decisionId: tactileDecision.decisionId,
        choiceSetRevision: tactileDecision.choiceSetRevision,
        choiceId: tactileChoice.choiceId,
      },
    });
    const vocalResult = await vocal.decide.execute({
      ...OWNER,
      missionId: vocal.mission.id,
      commandId: TURN_ID,
      expectedMissionRevision: vocal.mission.revision,
      expectedDraftSessionId: vocalDraft.sessionId,
      expectedDraftSlotRevision: vocalDraft.slotRevision,
      expectedDraftContentRevision: vocalDraft.contentRevision,
      origin: {
        actor: 'user_voice',
        correlation: {
          realtimeSessionId: REALTIME_SESSION_ID,
          turnId: TURN_ID,
          contextRevision: vocal.contextRevision,
          contextDigest: vocal.contextDigest,
        },
      },
      decision: {
        action: 'choose_presented_option',
        decisionId: vocalDecision.decisionId,
        choiceSetRevision: vocalDecision.choiceSetRevision,
        choiceId: vocalChoice.choiceId,
      },
    });

    expect(tactileResult).toMatchObject({
      ok: true,
      value: { outcome: 'selected', mission: { phase: 'awaiting_lines' } },
    });
    expect(vocalResult).toMatchObject({
      ok: true,
      value: { outcome: 'selected', mission: { phase: 'awaiting_lines' } },
    });
    if (!tactileResult.ok || !vocalResult.ok) return;
    expect(vocalResult.value.mission).toEqual(tactileResult.value.mission);
    expect(vocal.unitOfWork.snapshot().slot).toEqual(tactile.unitOfWork.snapshot().slot);
    expect(tactile.unitOfWork.snapshot().events.at(-1)?.toSnapshot()).toMatchObject({
      actor: 'user_tap',
      data: {
        kind: 'customer_selected',
        source: 'presented_choice',
        choiceId: tactileChoice.choiceId,
      },
    });
    expect(vocal.unitOfWork.snapshot().events.at(-1)?.toSnapshot()).toMatchObject({
      actor: 'user_voice',
      realtimeSessionId: REALTIME_SESSION_ID,
      turnId: TURN_ID,
      contextRevision: vocal.contextRevision,
      contextDigest: vocal.contextDigest,
      data: {
        kind: 'customer_selected',
        source: 'presented_choice',
        choiceId: vocalChoice.choiceId,
      },
    });
  });

  it('invalide sous CAS un choix supprimé sans toucher au brouillon', async () => {
    const suite = await preparedCustomerDecisionMission({
      customers: [
        { customerId: 'customer-one', canonicalName: 'Camping Nord' },
        { customerId: 'customer-two', canonicalName: 'Camping Sud' },
      ],
      customerReference: 'Camping',
    });
    const draft = suite.mission.payload.draft;
    const decision = suite.mission.payload.decision;
    if (
      draft === null
      || decision?.kind !== 'customer'
      || decision.candidates[0] === undefined
    ) return;
    const removedChoice = decision.candidates[0];
    suite.unitOfWork.setCustomers([
      { customerId: 'customer-two', canonicalName: 'Camping Sud' },
    ]);
    const before = suite.unitOfWork.snapshot();
    const command = {
      ...OWNER,
      missionId: suite.mission.id,
      commandId: DECISION_COMMAND,
      expectedMissionRevision: suite.mission.revision,
      expectedDraftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
      origin: { actor: 'user_tap', correlation: null },
      decision: {
        action: 'choose_presented_option',
        decisionId: decision.decisionId,
        choiceSetRevision: decision.choiceSetRevision,
        choiceId: removedChoice.choiceId,
      },
    } as const;

    expect(await suite.decide.execute(command)).toMatchObject({
      ok: true,
      value: {
        outcome: 'invalidated',
        mission: {
          phase: 'awaiting_customer',
          payload: { decision: null },
        },
      },
    });
    const after = suite.unitOfWork.snapshot();
    expect(after.slot).toEqual(before.slot);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(after.events.at(-1)?.toSnapshot()).toMatchObject({
      eventType: 'decision_invalidated',
      actor: 'user_tap',
      draftSlotRevisionBefore: draft.slotRevision,
      draftSlotRevisionAfter: draft.slotRevision,
      draftContentRevisionBefore: draft.contentRevision,
      draftContentRevisionAfter: draft.contentRevision,
      data: {
        kind: 'decision_invalidated',
        reason: 'candidate_unavailable',
      },
    });
    expect(await suite.decide.execute(command)).toMatchObject({
      ok: true,
      value: { outcome: 'replayed' },
    });
    expect(suite.unitOfWork.snapshot().events).toHaveLength(after.events.length);
  });

  it('refuse un client direct supprimé ou substitué sans aucune écriture', async () => {
    const suite = await preparedCustomerDecisionMission({
      customers: [{
        customerId: 'customer-camping',
        canonicalName: 'Camping les Pins',
      }],
      customerReference: null,
    });
    const draft = suite.mission.payload.draft;
    if (draft === null) return;
    const command = {
      ...OWNER,
      missionId: suite.mission.id,
      commandId: DECISION_COMMAND,
      expectedMissionRevision: suite.mission.revision,
      expectedDraftSessionId: draft.sessionId,
      expectedDraftSlotRevision: draft.slotRevision,
      expectedDraftContentRevision: draft.contentRevision,
      origin: { actor: 'user_tap', correlation: null },
      decision: {
        action: 'select_screen_customer',
        customerId: 'customer-camping',
      },
    } as const;
    suite.unitOfWork.setCustomers([]);
    const beforeMissing = suite.unitOfWork.snapshot();
    expect(await suite.decide.execute(command)).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_customer',
        reason: 'unavailable',
      },
    });
    expect(suite.unitOfWork.snapshot()).toEqual(beforeMissing);

    suite.unitOfWork.customerByIdOverride = {
      customerId: 'customer-substituted',
      canonicalName: 'Client substitué',
    };
    const beforeSubstitution = suite.unitOfWork.snapshot();
    expect(await suite.decide.execute(command)).toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'customer_candidate_search',
        cause: 'invalid_customer_read',
      },
    });
    expect(suite.unitOfWork.snapshot()).toEqual(beforeSubstitution);
  });

  it.each([1, 2, 3])(
    'rollbacke la décision client entière si la faute %s survient',
    async (failAtWrite) => {
      const suite = await preparedCustomerDecisionMission({
        customers: [{
          customerId: 'customer-camping',
          canonicalName: 'Camping les Pins',
        }],
        customerReference: null,
      });
      const draft = suite.mission.payload.draft;
      if (draft === null) return;
      const before = suite.unitOfWork.snapshot();
      suite.unitOfWork.failAtWrite = failAtWrite;

      await expect(suite.decide.execute({
        ...OWNER,
        missionId: suite.mission.id,
        commandId: DECISION_COMMAND,
        expectedMissionRevision: suite.mission.revision,
        expectedDraftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
        origin: { actor: 'user_tap', correlation: null },
        decision: {
          action: 'select_screen_customer',
          customerId: 'customer-camping',
        },
      })).rejects.toThrow(`injected-write-${failAtWrite}`);
      expect(suite.unitOfWork.snapshot()).toEqual(before);
    },
  );

  it.each([1, 2, 3])(
    'rollbacke brouillon, mission et événement si la faute %s survient dans Advance',
    async (failAtWrite) => {
      const { unitOfWork, start, acknowledge, advance } = useCases();
      unitOfWork.setCustomers([
        { customerId: 'customer-camping', canonicalName: 'Camping les Pins' },
      ]);
      const started = await start.execute({
        ...OWNER,
        commandId: START_COMMAND,
        customerReference: 'Camping les Pins',
      });
      expect(started.ok).toBe(true);
      if (!started.ok || started.value.mission.payload.draft === null) return;
      const draft = started.value.mission.payload.draft;
      unitOfWork.screenObservation = {
        status: 'ready',
        realtimeSessionId: REALTIME_SESSION_ID,
        contextRevision: 1,
        contextDigest: 'd'.repeat(64),
        screenInstanceId: 'quote-wizard-instance-1',
        draft,
        draftHasCustomer: false,
      };
      expect(await acknowledge.execute({
        ...OWNER,
        missionId: started.value.mission.id,
        commandId: ACK_COMMAND,
        expectedMissionRevision: 1,
        realtimeSessionId: REALTIME_SESSION_ID,
        contextRevision: 1,
        contextDigest: 'd'.repeat(64),
        draftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
      })).toMatchObject({ ok: true });
      const before = unitOfWork.snapshot();
      unitOfWork.failAtWrite = failAtWrite;

      await expect(advance.execute({
        ...OWNER,
        missionId: started.value.mission.id,
        acknowledgementCommandId: ACK_COMMAND,
      })).rejects.toThrow(`injected-write-${failAtWrite}`);

      expect(unitOfWork.snapshot()).toEqual(before);
    },
  );

  it.each([1, 2, 3, 4])(
    'rollbacke toutes les écritures si la faute %s survient dans la transaction de start',
    async (failAtWrite) => {
      const { unitOfWork, start } = useCases();
      unitOfWork.failAtWrite = failAtWrite;

      await expect(
        start.execute({ ...OWNER, commandId: START_COMMAND }),
      ).rejects.toThrow(`injected-write-${failAtWrite}`);

      const state = unitOfWork.snapshot();
      expect(state.missions.size).toBe(0);
      expect(state.events).toHaveLength(0);
      expect(state.slot).toBeNull();
    },
  );

  it('garde le double mémoire strictement aligné sur insert/savepoint/scope/CAS PostgreSQL', async () => {
    const suite = useCases();
    const started = await suite.start.execute({
      ...OWNER,
      commandId: START_COMMAND,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const missionId = started.value.mission.id;
    const workItem: AgentMissionQuoteLineWork = {
      id: '90000000-0000-4000-8000-000000000001',
      ...OWNER,
      missionId,
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
      catalogueItemId: null,
      expectedCatalogueRevision: null,
      proposalId: null,
      proposalRevision: null,
      proposalDiffHash: null,
      createdAt: INITIAL_NOW,
      updatedAt: INITIAL_NOW,
    };
    const run = async <T>(
      work: (transaction: AgentMissionTransaction) => Promise<T>,
    ): Promise<T> => {
      const result = await suite.unitOfWork.runQuoteCreationOwner(
        OWNER,
        AUTHORITY,
        work,
      );
      if (result.status !== 'executed') {
        throw new Error(`memory quote line work rejected:${result.status}`);
      }
      return result.value;
    };

    expect(await run((transaction) => transaction.quoteLineWork.insertMany({
      ...OWNER,
      missionId,
      workItems: [workItem],
    }))).toBe('inserted');

    const duplicateId = {
      ...workItem,
      ordinal: 2,
    };
    await expect(run((transaction) => transaction.quoteLineWork.insertMany({
      ...OWNER,
      missionId,
      workItems: [
        duplicateId,
        { ...duplicateId, ordinal: 3 },
      ],
    }))).rejects.toThrow('AGENT_MISSION_QUOTE_LINE_WORK_INSERT_SCOPE_INVALID');

    await expect(run((transaction) => transaction.quoteLineWork.insertMany({
      ...OWNER,
      missionId,
      workItems: [
        {
          ...workItem,
          id: '90000000-0000-4000-8000-000000000002',
          ordinal: 2,
        },
        {
          ...workItem,
          id: '90000000-0000-4000-8000-000000000003',
          ordinal: 2,
        },
      ],
    }))).rejects.toThrow('AGENT_MISSION_QUOTE_LINE_WORK_INSERT_SCOPE_INVALID');

    await expect(run((transaction) => transaction.quoteLineWork.insertMany({
      ...OWNER,
      missionId,
      workItems: [{ ...workItem, revision: 2, ordinal: 2 }],
    }))).rejects.toThrow('AGENT_MISSION_QUOTE_LINE_WORK_INSERT_SCOPE_INVALID');

    await expect(run((transaction) => transaction.quoteLineWork.updateCas({
      workItem: { ...workItem, revision: 3 },
      expectedRevision: 1,
    }))).rejects.toThrow('AGENT_MISSION_QUOTE_LINE_WORK_CAS_REVISION_INVALID');

    expect(await run((transaction) => transaction.quoteLineWork.updateCas({
      workItem: {
        ...workItem,
        ownerUserId: OTHER_OWNER.ownerUserId,
        revision: 2,
      },
      expectedRevision: 1,
    }))).toBe('revision_conflict');

    const revised: AgentMissionQuoteLineWork = {
      ...workItem,
      revision: 2,
      state: 'awaiting_details',
      requiredFact: 'vat_rate',
      updatedAt: '2026-07-26T10:00:01.000Z',
    };
    expect(await run((transaction) => transaction.quoteLineWork.updateCas({
      workItem: revised,
      expectedRevision: 1,
    }))).toBe('updated');
    expect(await run((transaction) => transaction.quoteLineWork.updateCas({
      workItem: revised,
      expectedRevision: 1,
    }))).toBe('revision_conflict');
    expect(suite.unitOfWork.snapshot().quoteLineWork.get(workItem.id)).toEqual(revised);
  });
});
