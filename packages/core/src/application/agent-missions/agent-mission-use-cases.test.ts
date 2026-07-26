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
  type AgentMissionOwner,
  type AgentMissionQuoteDraftSlot,
} from '../ports/agent-mission-repository';
import {
  type AgentMissionReadTransaction,
  type AgentMissionTransaction,
  type AgentMissionUnitOfWorkPort,
  type AgentMissionWriteExecution,
} from '../ports/agent-mission-unit-of-work';
import { type IdGeneratorPort } from '../ports/services';
import { CancelQuoteAgentMission } from './cancel-quote-agent-mission';
import { GetActiveAgentMission } from './get-active-agent-mission';
import { StartQuoteAgentMission } from './start-quote-agent-mission';
import { deriveAgentMissionSystemCommandId } from './agent-mission-application';

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
const INITIAL_NOW = '2026-07-26T10:00:00.000Z';

interface MemoryState {
  readonly missions: Map<string, AgentMission>;
  readonly events: AgentMissionEvent[];
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
    slot: null,
  };

  now = INITIAL_NOW;
  failAtWrite: number | null = null;
  companyUnavailableReason: 'missing' | 'closed' | null = null;
  readTransactions = 0;
  writeTransactions = 0;

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

  async readQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionReadTransaction) => Promise<T>,
  ): Promise<T> {
    this.readTransactions += 1;
    const state = this.state;
    return work({
      databaseNow: async () => this.now,
      missions: {
        findActive: async ({ kind }) => this.findActive(state, owner, kind),
        findById: async ({ missionId }) => {
          const mission = state.missions.get(missionId) ?? null;
          return mission !== null && sameOwner(owner, mission.toSnapshot()) ? mission : null;
        },
      },
    });
  }

  async runQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionTransaction) => Promise<T>,
  ): Promise<AgentMissionWriteExecution<T>> {
    this.writeTransactions += 1;
    if (this.companyUnavailableReason !== null) {
      return {
        status: 'company_unavailable',
        reason: this.companyUnavailableReason,
      };
    }
    const nextState = cloneState(this.state);
    let writeCount = 0;
    const beforeWrite = (): void => {
      writeCount += 1;
      if (this.failAtWrite === writeCount) throw new Error(`injected-write-${writeCount}`);
    };
    const scopedSlot = (): AgentMissionQuoteDraftSlot | null => (
      nextState.slot !== null && sameOwner(owner, nextState.slot) ? nextState.slot : null
    );
    const transaction: AgentMissionTransaction = {
      databaseNow: async () => this.now,
      missions: {
        findActive: async ({ kind }) => this.findActive(nextState, owner, kind),
        findById: async ({ missionId }) => {
          const mission = nextState.missions.get(missionId) ?? null;
          return mission !== null && sameOwner(owner, mission.toSnapshot()) ? mission : null;
        },
        findActiveForUpdate: async ({ kind }) => this.findActive(nextState, owner, kind),
        findByIdForUpdate: async ({ missionId }) => {
          const mission = nextState.missions.get(missionId) ?? null;
          return mission !== null && sameOwner(owner, mission.toSnapshot()) ? mission : null;
        },
        insert: async (mission) => {
          beforeWrite();
          if (nextState.missions.has(mission.id)) throw new Error('duplicate mission');
          nextState.missions.set(mission.id, mission);
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
        findByCommandId: async ({ commandId }) => (
          nextState.events.find((event) => {
            const snapshot = event.toSnapshot();
            return sameOwner(owner, snapshot) && snapshot.commandId === commandId;
          }) ?? null
        ),
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
}

function useCases(unitOfWork = new MemoryAgentMissionUnitOfWork()) {
  const deps = {
    unitOfWork,
    fingerprints: FINGERPRINTS,
    ids: new SequenceIds(),
  };
  return {
    unitOfWork,
    start: new StartQuoteAgentMission(deps),
    get: new GetActiveAgentMission({ unitOfWork }),
    cancel: new CancelQuoteAgentMission(deps),
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

  it.each(['user_cancelled', 'manual_handoff'] as const)(
    'terminalise par %s et libère le brouillon atomiquement',
    async (reason) => {
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
});
