import {
  AgentMission,
  AgentMissionEvent,
  parseQuoteDraftPayload,
  type AgentMissionDraftFenceResult,
  type AgentMissionEventRepositoryPort,
  type AgentMissionDraftFencePort,
  type AgentMissionOwner,
  type AgentMissionQuoteDraftRepositoryPort,
  type AgentMissionQuoteDraftSlot,
  type AgentMissionReadRepositoryPort,
  type AgentMissionRepositoryPort,
  type AgentMissionTransaction,
  type AgentMissionUnitOfWorkPort,
  type AgentMissionWriteExecution,
  type QuoteDraftPayloadV1,
} from '@bob/core';
import {
  Prisma,
  type AgentMission as AgentMissionRow,
  type AgentMissionEvent as AgentMissionEventRow,
  type QuoteDraftSlot as QuoteDraftSlotRow,
} from '@prisma/client';
import type { PrismaService } from './prisma.service';

const OWNER_TRANSACTION_OPTIONS = {
  maxWaitMs: 5_000,
  timeoutMs: 15_000,
} as const;

const MISSION_COLUMNS = Prisma.sql`
  "id",
  "companyId",
  "ownerUserId",
  "kind",
  "status",
  "phase",
  "revision",
  "payloadVersion",
  "payload",
  "currentBinding",
  "idleExpiresAt",
  "hardExpiresAt",
  "terminalAt",
  "retentionExpiresAt",
  "createdAt",
  "updatedAt"
`;

const QUOTE_DRAFT_COLUMNS = Prisma.sql`
  "companyId",
  "ownerUserId",
  "revision",
  "payloadVersion",
  "payload",
  "agentMissionId",
  "createdAt",
  "updatedAt"
`;

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function missionFromRow(row: AgentMissionRow): AgentMission {
  const result = AgentMission.rehydrate({
    id: row.id,
    companyId: row.companyId,
    ownerUserId: row.ownerUserId,
    kind: row.kind,
    status: row.status,
    phase: row.phase,
    revision: row.revision,
    payloadVersion: row.payloadVersion,
    payload: row.payload,
    currentBinding: row.currentBinding,
    idleExpiresAt: row.idleExpiresAt.toISOString(),
    hardExpiresAt: row.hardExpiresAt.toISOString(),
    terminalAt: row.terminalAt?.toISOString() ?? null,
    retentionExpiresAt: row.retentionExpiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!result.ok) {
    throw new Error(
      `AGENT_MISSION_ROW_CORRUPT:${result.error.code}:${
        'field' in result.error ? result.error.field : 'state'
      }`,
    );
  }
  return result.value;
}

function eventFromRow(row: AgentMissionEventRow): AgentMissionEvent {
  const result = AgentMissionEvent.record({
    id: row.id,
    companyId: row.companyId,
    ownerUserId: row.ownerUserId,
    missionId: row.missionId,
    sequence: row.sequence,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    actor: row.actor,
    commandId: row.commandId,
    requestFingerprintHmac: row.requestFingerprintHmac,
    fingerprintKeyVersion: row.fingerprintKeyVersion,
    fingerprintCanonicalizationVersion: row.fingerprintCanonicalizationVersion,
    missionRevisionBefore: row.missionRevisionBefore,
    missionRevisionAfter: row.missionRevisionAfter,
    draftSlotRevisionBefore: row.draftSlotRevisionBefore,
    draftSlotRevisionAfter: row.draftSlotRevisionAfter,
    draftContentRevisionBefore: row.draftContentRevisionBefore,
    draftContentRevisionAfter: row.draftContentRevisionAfter,
    realtimeSessionId: row.realtimeSessionId,
    turnId: row.turnId,
    contextRevision: row.contextRevision,
    contextDigest: row.contextDigest,
    data: row.data,
    occurredAt: row.occurredAt.toISOString(),
    retentionExpiresAt: row.retentionExpiresAt.toISOString(),
  });
  if (!result.ok) {
    throw new Error(
      `AGENT_MISSION_EVENT_ROW_CORRUPT:${result.error.field}:${result.error.reason}`,
    );
  }
  return result.value;
}

function quoteDraftPayload(value: unknown): QuoteDraftPayloadV1 {
  const parsed = parseQuoteDraftPayload(value);
  if (!parsed.ok) {
    throw new Error(`AGENT_MISSION_QUOTE_DRAFT_CORRUPT:${parsed.error.code}:${parsed.error.path}`);
  }
  return parsed.value;
}

function quoteDraftFromRow(row: QuoteDraftSlotRow): AgentMissionQuoteDraftSlot {
  if (row.payloadVersion !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new Error('AGENT_MISSION_QUOTE_DRAFT_VERSION_OR_REVISION_CORRUPT');
  }
  return {
    companyId: row.companyId,
    ownerUserId: row.ownerUserId,
    revision: row.revision,
    payloadVersion: 1,
    payload: quoteDraftPayload(row.payload),
    agentMissionId: row.agentMissionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function setMissionContext(
  transaction: Prisma.TransactionClient,
  missionId: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT set_config('app.current_agent_mission_id', ${missionId}, true)
  `;
}

async function setTransactionTimeouts(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT
      set_config('lock_timeout', '5s', true),
      set_config('statement_timeout', '10s', true)
  `;
}

function quoteCreationOwnerLockKey(owner: AgentMissionOwner): string {
  return [
    'bob.agent-mission.owner-kind.v1',
    owner.companyId,
    owner.ownerUserId,
    'quote_creation',
  ].join('\u001f');
}

async function acquireQuoteCreationOwnerLock(
  transaction: Prisma.TransactionClient,
  owner: AgentMissionOwner,
): Promise<void> {
  const ownerLockKey = quoteCreationOwnerLockKey(owner);
  await transaction.$queryRaw<Array<{ locked: boolean }>>`
    SELECT (
      pg_advisory_xact_lock(hashtextextended(${ownerLockKey}, 0)) IS NULL
    ) AS "locked"
  `;
}

async function lockOpenCompanyForMissionWrite(
  transaction: Prisma.TransactionClient,
  companyId: string,
): Promise<'open' | 'missing' | 'closed'> {
  const rows = await transaction.$queryRaw<Array<{ closedAt: Date | null }>>`
    SELECT "closedAt"
    FROM public.companies
    WHERE "id" = ${companyId}
    LIMIT 1
    FOR SHARE
  `;
  if (rows[0] === undefined) return 'missing';
  return rows[0].closedAt === null ? 'open' : 'closed';
}

class PrismaAgentMissionReadRepository implements AgentMissionReadRepositoryPort {
  constructor(protected readonly transaction: Prisma.TransactionClient) {}

  async findActive(input: AgentMissionOwner & {
    readonly kind: 'quote_creation';
  }): Promise<AgentMission | null> {
    const row = await this.transaction.agentMission.findFirst({
      where: {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        kind: input.kind,
        status: 'active',
      },
    });
    return row === null ? null : missionFromRow(row);
  }

  async findById(input: AgentMissionOwner & {
    readonly missionId: string;
  }): Promise<AgentMission | null> {
    const row = await this.transaction.agentMission.findFirst({
      where: {
        id: input.missionId,
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
      },
    });
    return row === null ? null : missionFromRow(row);
  }
}

class PrismaAgentMissionRepository
  extends PrismaAgentMissionReadRepository
  implements AgentMissionRepositoryPort {
  async findActiveForUpdate(input: AgentMissionOwner & {
    readonly kind: 'quote_creation';
  }): Promise<AgentMission | null> {
    // Sous FORCE RLS, SELECT ... FOR UPDATE doit aussi satisfaire la policy UPDATE, laquelle
    // exige la capability exacte de la mission. L'advisory lock owner+kind est déjà possédé par
    // l'UoW : on peut donc découvrir l'UUID via la policy SELECT, poser la capability, puis
    // verrouiller sans fenêtre de concurrence.
    const visible = await this.transaction.agentMission.findFirst({
      where: {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        kind: input.kind,
        status: 'active',
      },
      select: { id: true },
    });
    if (visible === null) return null;
    await setMissionContext(this.transaction, visible.id);
    const rows = await this.transaction.$queryRaw<AgentMissionRow[]>`
      SELECT ${MISSION_COLUMNS}
      FROM public.agent_missions
      WHERE "id" = ${visible.id}::UUID
        AND "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "kind" = ${input.kind}
        AND "status" = 'active'
      LIMIT 1
      FOR UPDATE
    `;
    return rows[0] === undefined ? null : missionFromRow(rows[0]);
  }

  async findByIdForUpdate(input: AgentMissionOwner & {
    readonly missionId: string;
  }): Promise<AgentMission | null> {
    await setMissionContext(this.transaction, input.missionId);
    const rows = await this.transaction.$queryRaw<AgentMissionRow[]>`
      SELECT ${MISSION_COLUMNS}
      FROM public.agent_missions
      WHERE "id" = ${input.missionId}::UUID
        AND "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
      LIMIT 1
      FOR UPDATE
    `;
    return rows[0] === undefined ? null : missionFromRow(rows[0]);
  }

  async insert(mission: AgentMission): Promise<void> {
    const snapshot = mission.toSnapshot();
    await setMissionContext(this.transaction, snapshot.id);
    await this.transaction.agentMission.create({
      data: {
        id: snapshot.id,
        companyId: snapshot.companyId,
        ownerUserId: snapshot.ownerUserId,
        kind: snapshot.kind,
        status: snapshot.status,
        phase: snapshot.phase,
        revision: snapshot.revision,
        payloadVersion: snapshot.payloadVersion,
        payload: toInputJson(snapshot.payload),
        currentBinding: snapshot.currentBinding === null
          ? Prisma.DbNull
          : toInputJson(snapshot.currentBinding),
        idleExpiresAt: new Date(snapshot.idleExpiresAt),
        hardExpiresAt: new Date(snapshot.hardExpiresAt),
        terminalAt: snapshot.terminalAt === null ? null : new Date(snapshot.terminalAt),
        retentionExpiresAt: new Date(snapshot.retentionExpiresAt),
        createdAt: new Date(snapshot.createdAt),
        updatedAt: new Date(snapshot.updatedAt),
      },
    });
  }

  async updateCas(input: {
    readonly mission: AgentMission;
    readonly expectedRevision: number;
  }): Promise<'updated' | 'revision_conflict'> {
    const snapshot = input.mission.toSnapshot();
    await setMissionContext(this.transaction, snapshot.id);
    const updated = await this.transaction.agentMission.updateMany({
      where: {
        id: snapshot.id,
        companyId: snapshot.companyId,
        ownerUserId: snapshot.ownerUserId,
        revision: input.expectedRevision,
      },
      data: {
        status: snapshot.status,
        phase: snapshot.phase,
        revision: snapshot.revision,
        payloadVersion: snapshot.payloadVersion,
        payload: toInputJson(snapshot.payload),
        currentBinding: snapshot.currentBinding === null
          ? Prisma.DbNull
          : toInputJson(snapshot.currentBinding),
        idleExpiresAt: new Date(snapshot.idleExpiresAt),
        hardExpiresAt: new Date(snapshot.hardExpiresAt),
        terminalAt: snapshot.terminalAt === null ? null : new Date(snapshot.terminalAt),
        retentionExpiresAt: new Date(snapshot.retentionExpiresAt),
        updatedAt: new Date(snapshot.updatedAt),
      },
    });
    return updated.count === 1 ? 'updated' : 'revision_conflict';
  }
}

class PrismaAgentMissionEventRepository implements AgentMissionEventRepositoryPort {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async findByCommandId(input: AgentMissionOwner & {
    readonly commandId: string;
  }): Promise<AgentMissionEvent | null> {
    const row = await this.transaction.agentMissionEvent.findFirst({
      where: {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        commandId: input.commandId,
      },
    });
    return row === null ? null : eventFromRow(row);
  }

  async append(event: AgentMissionEvent): Promise<void> {
    const snapshot = event.toSnapshot();
    await setMissionContext(this.transaction, snapshot.missionId);
    await this.transaction.agentMissionEvent.create({
      data: {
        id: snapshot.id,
        companyId: snapshot.companyId,
        ownerUserId: snapshot.ownerUserId,
        missionId: snapshot.missionId,
        sequence: snapshot.sequence,
        eventType: snapshot.eventType,
        eventVersion: snapshot.eventVersion,
        actor: snapshot.actor,
        commandId: snapshot.commandId,
        requestFingerprintHmac: snapshot.requestFingerprintHmac,
        fingerprintKeyVersion: snapshot.fingerprintKeyVersion,
        fingerprintCanonicalizationVersion: snapshot.fingerprintCanonicalizationVersion,
        missionRevisionBefore: snapshot.missionRevisionBefore,
        missionRevisionAfter: snapshot.missionRevisionAfter,
        draftSlotRevisionBefore: snapshot.draftSlotRevisionBefore,
        draftSlotRevisionAfter: snapshot.draftSlotRevisionAfter,
        draftContentRevisionBefore: snapshot.draftContentRevisionBefore,
        draftContentRevisionAfter: snapshot.draftContentRevisionAfter,
        realtimeSessionId: snapshot.realtimeSessionId,
        turnId: snapshot.turnId,
        contextRevision: snapshot.contextRevision,
        contextDigest: snapshot.contextDigest,
        data: toInputJson(snapshot.data),
        occurredAt: new Date(snapshot.occurredAt),
        retentionExpiresAt: new Date(snapshot.retentionExpiresAt),
      },
    });
  }
}

class PrismaAgentMissionQuoteDraftRepository
implements AgentMissionQuoteDraftRepositoryPort {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async getForUpdate(owner: AgentMissionOwner): Promise<AgentMissionQuoteDraftSlot | null> {
    const rows = await this.transaction.$queryRaw<QuoteDraftSlotRow[]>`
      SELECT ${QUOTE_DRAFT_COLUMNS}
      FROM public.quote_draft_slots
      WHERE "companyId" = ${owner.companyId}
        AND "ownerUserId" = ${owner.ownerUserId}
      LIMIT 1
      FOR UPDATE
    `;
    return rows[0] === undefined ? null : quoteDraftFromRow(rows[0]);
  }

  async create(input: AgentMissionOwner & {
    readonly payload: QuoteDraftPayloadV1;
  }): Promise<AgentMissionQuoteDraftSlot | null> {
    const inserted = await this.transaction.quoteDraftSlot.createMany({
      data: [{
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        revision: 1,
        payloadVersion: 1,
        payload: toInputJson(input.payload),
      }],
      skipDuplicates: true,
    });
    return inserted.count === 1 ? this.getForUpdate(input) : null;
  }

  async claim(input: AgentMissionOwner & {
    readonly missionId: string;
    readonly expectedSlotRevision: number;
    readonly expectedDraftSessionId: string;
  }): Promise<AgentMissionQuoteDraftSlot | null> {
    await setMissionContext(this.transaction, input.missionId);
    const rows = await this.transaction.$queryRaw<QuoteDraftSlotRow[]>`
      UPDATE public.quote_draft_slots
      SET "agentMissionId" = ${input.missionId}::UUID
      WHERE "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "revision" = ${input.expectedSlotRevision}
        AND "agentMissionId" IS NULL
        AND "payload" -> 'draft' ->> 'sessionId' = ${input.expectedDraftSessionId}
      RETURNING ${QUOTE_DRAFT_COLUMNS}
    `;
    return rows[0] === undefined ? null : quoteDraftFromRow(rows[0]);
  }

  async release(input: AgentMissionOwner & {
    readonly missionId: string;
  }): Promise<boolean> {
    await setMissionContext(this.transaction, input.missionId);
    const rows = await this.transaction.$queryRaw<Array<{ companyId: string }>>`
      UPDATE public.quote_draft_slots
      SET "agentMissionId" = NULL
      WHERE "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "agentMissionId" = ${input.missionId}::UUID
      RETURNING "companyId"
    `;
    return rows.length === 1;
  }
}

function createWriteTransaction(
  transaction: Prisma.TransactionClient,
): AgentMissionTransaction {
  return {
    databaseNow: async () => {
      const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"
      `;
      const now = rows[0]?.now;
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('AGENT_MISSION_DATABASE_CLOCK_UNAVAILABLE');
      }
      return now.toISOString();
    },
    missions: new PrismaAgentMissionRepository(transaction),
    events: new PrismaAgentMissionEventRepository(transaction),
    quoteDrafts: new PrismaAgentMissionQuoteDraftRepository(transaction),
  };
}

export class PrismaAgentMissionUnitOfWork implements AgentMissionUnitOfWorkPort {
  constructor(private readonly prisma: PrismaService) {}

  readQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    work: Parameters<AgentMissionUnitOfWorkPort['readQuoteCreationOwner']>[1],
  ): Promise<T> {
    return this.prisma.withIsolatedOwner(owner.companyId, owner.ownerUserId, async (transaction) => {
      await setTransactionTimeouts(transaction);
      const missions = new PrismaAgentMissionReadRepository(transaction);
      return work({
        databaseNow: async () => {
          const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
            SELECT clock_timestamp() AS "now"
          `;
          const now = rows[0]?.now;
          if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
            throw new Error('AGENT_MISSION_DATABASE_CLOCK_UNAVAILABLE');
          }
          return now.toISOString();
        },
        missions,
      });
    }, { ...OWNER_TRANSACTION_OPTIONS, readOnly: true }) as Promise<T>;
  }

  runQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionTransaction) => Promise<T>,
  ): Promise<AgentMissionWriteExecution<T>> {
    return this.prisma.withIsolatedOwner(owner.companyId, owner.ownerUserId, async (transaction) => {
      await setTransactionTimeouts(transaction);
      const company = await lockOpenCompanyForMissionWrite(transaction, owner.companyId);
      if (company !== 'open') {
        return { status: 'company_unavailable', reason: company } as const;
      }
      await acquireQuoteCreationOwnerLock(transaction, owner);
      return {
        status: 'executed',
        value: await work(createWriteTransaction(transaction)),
      } as const;
    }, { ...OWNER_TRANSACTION_OPTIONS, readOnly: false });
  }
}

export class PrismaAgentMissionDraftFence implements AgentMissionDraftFencePort {
  constructor(private readonly prisma: PrismaService) {}

  runLegacyMutationIfUnowned<T>(
    owner: AgentMissionOwner,
    work: () => Promise<T>,
  ): Promise<AgentMissionDraftFenceResult<T>> {
    return this.prisma.withIsolatedOwner(
      owner.companyId,
      owner.ownerUserId,
      async (transaction) => {
        await setTransactionTimeouts(transaction);
        const company = await lockOpenCompanyForMissionWrite(transaction, owner.companyId);
        if (company !== 'open') {
          return { status: 'company_unavailable', reason: company } as const;
        }
        await acquireQuoteCreationOwnerLock(transaction, owner);
        const rows = await transaction.$queryRaw<Array<{ agentMissionId: string | null }>>`
          SELECT "agentMissionId"
          FROM public.quote_draft_slots
          WHERE "companyId" = ${owner.companyId}
            AND "ownerUserId" = ${owner.ownerUserId}
          LIMIT 1
          FOR UPDATE
        `;
        // Tout marqueur est bloquant, même si la mission liée est terminale : un orphelin est une
        // corruption à réparer, jamais une permission implicite de contourner le trigger SQL.
        if (rows[0]?.agentMissionId != null) {
          return { status: 'owned_by_agent_mission' } as const;
        }
        return { status: 'executed', value: await work() } as const;
      },
      { ...OWNER_TRANSACTION_OPTIONS, readOnly: false },
    );
  }
}
