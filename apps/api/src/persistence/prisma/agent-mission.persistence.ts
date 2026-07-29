import { timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AgentMission,
  AgentMissionEvent,
  normalizeCustomerName,
  parseQuoteDraftPayload,
  type AgentMissionAuthorizedRealtimeLease,
  type AgentMissionCapabilityRejectionReason,
  type AgentMissionDraftFenceResult,
  type AgentMissionEventRepositoryPort,
  type AgentMissionDraftFencePort,
  type AgentMissionOwner,
  type AgentMissionQuoteScreenAuthorityPort,
  type AgentMissionQuoteScreenFences,
  type AgentMissionQuoteScreenObservation,
  type AgentMissionQuoteDraftRepositoryPort,
  type AgentMissionQuoteDraftSlot,
  type AgentMissionReadRepositoryPort,
  type AgentMissionReadTransaction,
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionRepositoryPort,
  type AgentMissionReadExecution,
  type AgentMissionResumeReadExecution,
  type AgentMissionResumeReadTransaction,
  type AgentMissionResumeUnitOfWorkPort,
  type AgentMissionTransaction,
  type AgentMissionUnitOfWorkPort,
  type AgentMissionWriteExecution,
  type CustomerCandidate,
  type CustomerCandidateReadPort,
  type CustomerCandidateReference,
  type CustomerCandidateSearchPort,
  type QuoteDraftPayloadV1,
} from '@bob/core';
import {
  Prisma,
  type AgentMission as AgentMissionRow,
  type AgentMissionEvent as AgentMissionEventRow,
  type QuoteDraftSlot as QuoteDraftSlotRow,
} from '@prisma/client';
import { prepareRealtimeContext } from '../../voice/realtime/realtime-admission';
import type { PrismaService } from './prisma.service';

const OWNER_TRANSACTION_OPTIONS = {
  maxWaitMs: 5_000,
  timeoutMs: 15_000,
} as const;

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_SUBJECT_HASH_CANDIDATES = 32;

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

interface AgentMissionAuthorityLeaseRow {
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly state: string;
  readonly leaseExpiresAt: Date;
  readonly hardExpiresAt: Date;
  readonly contextSchemaVersion: number | null;
  readonly contextRevision: number | null;
  readonly contextPayload: Prisma.JsonValue | null;
  readonly contextDigest: string | null;
  readonly contextUpdatedAt: Date | null;
  readonly sidebandOwnerLeaseExpiresAt: Date | null;
  readonly sidebandOwnerEpoch: number;
  readonly contextAppliedRevision: number | null;
  readonly contextAppliedDigest: string | null;
  readonly contextAppliedAt: Date | null;
  readonly contextAppliedOwnerEpoch: number | null;
  readonly agentMissionProtocolVersion: number | null;
  readonly agentMissionProtocolBoundAt: Date | null;
  readonly agentMissionCapabilityHash: string | null;
  readonly agentMissionReleaseFlagVersion: number | null;
  readonly agentMissionBootstrapAcknowledgedAt: Date | null;
}

interface CustomerCandidateRow {
  readonly customerId: string;
  readonly canonicalName: string;
  readonly matchKind: 'exact' | 'fuzzy';
  readonly score: number;
}

interface CustomerCandidateReferenceRow {
  readonly customerId: string;
  readonly canonicalName: string;
}

function canonicalCustomerName(value: string): string {
  // Les lignes historiques précèdent parfois la normalisation du domaine. Une valeur réellement
  // invalide reste inchangée afin que le validateur core échoue fermé ; seuls les espaces sans
  // sémantique sont réparés à la frontière Prisma.
  return normalizeCustomerName(value) ?? value;
}

type AgentMissionAuthorityResolution =
  | {
      readonly status: 'authorized';
      readonly lease: AgentMissionAuthorityLeaseRow;
      readonly databaseNow: Date;
    }
  | {
      readonly status: 'rejected';
      readonly reason: AgentMissionCapabilityRejectionReason;
    };

function canonicalAuthorityProof(
  proof: AgentMissionRealtimeAuthorityProof,
): {
  readonly subjectHashCandidates: readonly string[];
  readonly principalBindingHash: string;
  readonly capabilityHash: string;
} | null {
  if (
    !Array.isArray(proof.subjectHashCandidates)
    || proof.subjectHashCandidates.length < 1
    || proof.subjectHashCandidates.length > MAX_SUBJECT_HASH_CANDIDATES
    || !SHA256_HEX.test(proof.principalBindingHash)
    || !SHA256_HEX.test(proof.capabilityHash)
  ) return null;
  const subjectHashCandidates = [...proof.subjectHashCandidates];
  if (
    subjectHashCandidates.some((candidate) => !SHA256_HEX.test(candidate))
    || new Set(subjectHashCandidates).size !== subjectHashCandidates.length
  ) return null;
  subjectHashCandidates.sort();
  return Object.freeze({
    subjectHashCandidates: Object.freeze(subjectHashCandidates),
    principalBindingHash: proof.principalBindingHash,
    capabilityHash: proof.capabilityHash,
  });
}

function exactCapabilityHash(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  return expectedBytes.byteLength === 32
    && actualBytes.byteLength === 32
    && timingSafeEqual(expectedBytes, actualBytes);
}

function validAuthorityLeaseAt(
  row: AgentMissionAuthorityLeaseRow,
  databaseNow: Date,
): boolean {
  return row.state === 'active'
    && row.leaseExpiresAt.getTime() > databaseNow.getTime()
    && row.hardExpiresAt.getTime() > databaseNow.getTime()
    && row.agentMissionProtocolVersion === 1
    && row.agentMissionProtocolBoundAt instanceof Date
    && row.agentMissionBootstrapAcknowledgedAt instanceof Date
    && typeof row.agentMissionCapabilityHash === 'string'
    && SHA256_HEX.test(row.agentMissionCapabilityHash)
    && Number.isSafeInteger(row.agentMissionReleaseFlagVersion)
    && (row.agentMissionReleaseFlagVersion ?? 0) >= 1;
}

function rejectedAuthorityReason(
  rows: readonly AgentMissionAuthorityLeaseRow[],
  databaseNow: Date,
): AgentMissionCapabilityRejectionReason {
  if (rows.length === 0) return 'not_found';
  if (rows.some((row) => (
    row.state === 'active'
    && (
      row.leaseExpiresAt.getTime() <= databaseNow.getTime()
      || row.hardExpiresAt.getTime() <= databaseNow.getTime()
    )
  ))) return 'expired';
  return 'state';
}

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

async function acquireAgentMissionPrincipalLock(
  transaction: Prisma.TransactionClient,
  companyId: string,
  principalBindingHash: string,
): Promise<void> {
  const lockKey = `bob-live:principal:${companyId}:${principalBindingHash}`;
  await transaction.$queryRaw<Array<{ locked: boolean }>>`
    SELECT (
      pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) IS NULL
    ) AS "locked"
  `;
}

async function databaseClock(
  transaction: Prisma.TransactionClient,
): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('AGENT_MISSION_DATABASE_CLOCK_UNAVAILABLE');
  }
  return now;
}

const AUTHORITY_LEASE_COLUMNS = Prisma.sql`
  btrim("subjectHash") AS "subjectHash",
  "sessionId",
  state,
  "leaseExpiresAt",
  "hardExpiresAt",
  "contextSchemaVersion",
  "contextRevision",
  "contextPayload",
  btrim("contextDigest") AS "contextDigest",
  "contextUpdatedAt",
  "sidebandOwnerLeaseExpiresAt",
  "sidebandOwnerEpoch",
  "contextAppliedRevision",
  btrim("contextAppliedDigest") AS "contextAppliedDigest",
  "contextAppliedAt",
  "contextAppliedOwnerEpoch",
  "agentMissionProtocolVersion",
  "agentMissionProtocolBoundAt",
  btrim("agentMissionCapabilityHash") AS "agentMissionCapabilityHash",
  "agentMissionReleaseFlagVersion",
  "agentMissionBootstrapAcknowledgedAt"
`;

async function readAuthorityLeaseRows(
  transaction: Prisma.TransactionClient,
  companyId: string,
  subjectHashCandidates: readonly string[],
): Promise<AgentMissionAuthorityLeaseRow[]> {
  return transaction.$queryRaw<AgentMissionAuthorityLeaseRow[]>`
    SELECT ${AUTHORITY_LEASE_COLUMNS}
    FROM public.realtime_session_leases
    WHERE "companyId" = ${companyId}
      AND "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
    ORDER BY "subjectHash", "sessionId"
  `;
}

async function lockAuthorityLeaseRows(
  transaction: Prisma.TransactionClient,
  companyId: string,
  subjectHashCandidates: readonly string[],
): Promise<AgentMissionAuthorityLeaseRow[]> {
  return transaction.$queryRaw<AgentMissionAuthorityLeaseRow[]>`
    SELECT ${AUTHORITY_LEASE_COLUMNS}
    FROM public.realtime_session_leases
    WHERE "companyId" = ${companyId}
      AND "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
    ORDER BY "subjectHash", "sessionId"
    FOR UPDATE
  `;
}

async function resolveAgentMissionAuthority(
  transaction: Prisma.TransactionClient,
  owner: AgentMissionOwner,
  proof: AgentMissionRealtimeAuthorityProof,
  lockRows: boolean,
): Promise<AgentMissionAuthorityResolution> {
  const canonical = canonicalAuthorityProof(proof);
  if (canonical === null) {
    return { status: 'rejected', reason: 'malformed' };
  }
  if (lockRows) {
    await acquireAgentMissionPrincipalLock(
      transaction,
      owner.companyId,
      canonical.principalBindingHash,
    );
  }
  const rows = lockRows
    ? await lockAuthorityLeaseRows(
        transaction,
        owner.companyId,
        canonical.subjectHashCandidates,
      )
    : await readAuthorityLeaseRows(
        transaction,
        owner.companyId,
        canonical.subjectHashCandidates,
      );
  const now = await databaseClock(transaction);
  const eligible = rows.filter((row) => validAuthorityLeaseAt(row, now));
  if (eligible.length === 0) {
    return {
      status: 'rejected',
      reason: rejectedAuthorityReason(rows, now),
    };
  }
  if (eligible.length !== 1) {
    return { status: 'rejected', reason: 'ambiguous' };
  }
  const lease = eligible[0]!;
  if (
    lease.agentMissionCapabilityHash === null
    || !exactCapabilityHash(
      canonical.capabilityHash,
      lease.agentMissionCapabilityHash,
    )
  ) {
    return { status: 'rejected', reason: 'hash_mismatch' };
  }
  return { status: 'authorized', lease, databaseNow: now };
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

  async selectCustomerCas(input: AgentMissionOwner & {
    readonly missionId: string;
    readonly expectedSlotRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftContentRevision: number;
    readonly payload: QuoteDraftPayloadV1;
  }): Promise<AgentMissionQuoteDraftSlot | null> {
    await setMissionContext(this.transaction, input.missionId);
    const payloadJson = JSON.stringify(input.payload);
    const rows = await this.transaction.$queryRaw<QuoteDraftSlotRow[]>`
      UPDATE public.quote_draft_slots
      SET
        "revision" = "revision" + 1,
        "payloadVersion" = 1,
        "payload" = ${payloadJson}::jsonb,
        "updatedAt" = clock_timestamp()
      WHERE "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "agentMissionId" = ${input.missionId}::UUID
        AND "revision" = ${input.expectedSlotRevision}
        AND "revision" < 2147483647
        AND "payloadVersion" = 1
        AND "payload" -> 'draft' ->> 'sessionId' = ${input.expectedDraftSessionId}
        AND ("payload" #>> '{draft,contentRevision}')::integer
          = ${input.expectedDraftContentRevision}
        AND "payload" -> 'draft' ->> 'step' = 'client'
        AND "payload" -> 'draft' -> 'customer' = 'null'::jsonb
      RETURNING ${QUOTE_DRAFT_COLUMNS}
    `;
    return rows[0] === undefined ? null : quoteDraftFromRow(rows[0]);
  }
}

class PrismaAgentMissionCustomerRepository
implements CustomerCandidateSearchPort, CustomerCandidateReadPort {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async search(input: {
    readonly companyId: string;
    readonly query: string;
    readonly limit: 6;
  }): Promise<readonly CustomerCandidate[]> {
    const rows = await this.transaction.$queryRaw<CustomerCandidateRow[]>`
      SELECT
        c."id" AS "customerId",
        c."name" AS "canonicalName",
        CASE
          WHEN immutable_unaccent(lower(c."name"))
            = immutable_unaccent(lower(${input.query}))
          THEN 'exact'::text
          ELSE 'fuzzy'::text
        END AS "matchKind",
        CASE
          WHEN immutable_unaccent(lower(c."name"))
            = immutable_unaccent(lower(${input.query}))
          THEN 1.0::double precision
          ELSE word_similarity(
            immutable_unaccent(lower(${input.query})),
            immutable_unaccent(lower(c."name"))
          )::double precision
        END AS "score"
      FROM public.customers c
      WHERE c."companyId" = ${input.companyId}
        AND (
          immutable_unaccent(lower(c."name"))
            = immutable_unaccent(lower(${input.query}))
          OR immutable_unaccent(lower(${input.query}))
            <% immutable_unaccent(lower(c."name"))
        )
      ORDER BY
        (
          immutable_unaccent(lower(c."name"))
            = immutable_unaccent(lower(${input.query}))
        ) DESC,
        "score" DESC,
        immutable_unaccent(lower(c."name")) COLLATE "C" ASC,
        c."id" ASC
      LIMIT ${input.limit}
      FOR SHARE OF c
    `;
    return rows.map((row) => Object.freeze({
      customerId: row.customerId,
      canonicalName: canonicalCustomerName(row.canonicalName),
      matchKind: row.matchKind,
      score: row.score,
    }));
  }

  async findById(input: {
    readonly companyId: string;
    readonly customerId: string;
  }): Promise<CustomerCandidateReference | null> {
    const rows = await this.transaction.$queryRaw<CustomerCandidateReferenceRow[]>`
      SELECT c."id" AS "customerId", c."name" AS "canonicalName"
      FROM public.customers c
      WHERE c."companyId" = ${input.companyId}
        AND c."id" = ${input.customerId}
      LIMIT 1
      FOR SHARE
    `;
    const row = rows[0];
    return row === undefined
      ? null
      : Object.freeze({
          ...row,
          canonicalName: canonicalCustomerName(row.canonicalName),
        });
  }

  async findByIds(input: {
    readonly companyId: string;
    readonly customerIds: readonly string[];
  }): Promise<readonly CustomerCandidateReference[]> {
    if (input.customerIds.length === 0) return [];
    const rows = await this.transaction.$queryRaw<CustomerCandidateReferenceRow[]>`
      SELECT c."id" AS "customerId", c."name" AS "canonicalName"
      FROM public.customers c
      WHERE c."companyId" = ${input.companyId}
        AND c."id" IN (${Prisma.join(input.customerIds)})
      ORDER BY c."id" ASC
      FOR SHARE
    `;
    return rows.map((row) => Object.freeze({
      ...row,
      canonicalName: canonicalCustomerName(row.canonicalName),
    }));
  }
}

class PrismaAgentMissionResumeQuoteDraftRepository {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async get(owner: AgentMissionOwner): Promise<AgentMissionQuoteDraftSlot | null> {
    const rows = await this.transaction.$queryRaw<QuoteDraftSlotRow[]>`
      SELECT ${QUOTE_DRAFT_COLUMNS}
      FROM public.quote_draft_slots
      WHERE "companyId" = ${owner.companyId}
        AND "ownerUserId" = ${owner.ownerUserId}
      LIMIT 1
    `;
    return rows[0] === undefined ? null : quoteDraftFromRow(rows[0]);
  }
}

class PrismaAgentMissionResumeCustomerRepository {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async findByIds(input: {
    readonly companyId: string;
    readonly customerIds: readonly string[];
  }): Promise<readonly CustomerCandidateReference[]> {
    if (input.customerIds.length === 0) return [];
    const rows = await this.transaction.$queryRaw<CustomerCandidateReferenceRow[]>`
      SELECT c."id" AS "customerId", c."name" AS "canonicalName"
      FROM public.customers c
      WHERE c."companyId" = ${input.companyId}
        AND c."id" IN (${Prisma.join(input.customerIds)})
      ORDER BY c."id" ASC
    `;
    return rows.map((row) => Object.freeze({
      ...row,
      canonicalName: canonicalCustomerName(row.canonicalName),
    }));
  }
}

interface CanonicalAppliedRealtimeContext {
  readonly revision: number;
  readonly digest: string;
  readonly screenName: string;
  readonly screenInstanceId: string;
}

function canonicalAppliedRealtimeContext(
  lease: AgentMissionAuthorityLeaseRow,
  databaseNow: Date,
): CanonicalAppliedRealtimeContext | null {
  if (
    Number.isNaN(databaseNow.getTime())
    || lease.contextSchemaVersion !== 1
    || lease.contextRevision === null
    || lease.contextAppliedRevision !== lease.contextRevision
    || lease.contextDigest === null
    || lease.contextAppliedDigest !== lease.contextDigest
    || !(lease.contextUpdatedAt instanceof Date)
    || !(lease.contextAppliedAt instanceof Date)
    || lease.contextAppliedOwnerEpoch !== lease.sidebandOwnerEpoch
    || lease.sidebandOwnerLeaseExpiresAt === null
    || lease.sidebandOwnerLeaseExpiresAt.getTime() <= databaseNow.getTime()
    || lease.contextPayload === null
  ) {
    return null;
  }
  const prepared = prepareRealtimeContext({
    version: lease.contextSchemaVersion,
    revision: lease.contextRevision,
    context: lease.contextPayload,
  });
  if (
    prepared === null
    || !isDeepStrictEqual(lease.contextPayload, prepared.snapshot.context)
    || prepared.digest !== lease.contextDigest
    || prepared.digest !== lease.contextAppliedDigest
  ) {
    return null;
  }
  return Object.freeze({
    revision: lease.contextRevision,
    digest: prepared.digest,
    screenName: prepared.snapshot.context.screen.name,
    screenInstanceId: prepared.snapshot.context.screen.instanceId,
  });
}

function authorizedRealtimeLease(
  lease: AgentMissionAuthorityLeaseRow,
  databaseNow: Date,
): AgentMissionAuthorizedRealtimeLease {
  const applied = canonicalAppliedRealtimeContext(lease, databaseNow);
  return Object.freeze({
    realtimeSessionId: lease.sessionId,
    appliedContext: applied === null
      ? null
      : Object.freeze({ revision: applied.revision, digest: applied.digest }),
  });
}

class PrismaAgentMissionQuoteScreenAuthority
implements AgentMissionQuoteScreenAuthorityPort {
  constructor(
    private readonly transaction: Prisma.TransactionClient,
    private readonly lease: AgentMissionAuthorityLeaseRow,
  ) {}

  async observeForUpdate(
    owner: AgentMissionOwner,
    fences: AgentMissionQuoteScreenFences,
  ): Promise<AgentMissionQuoteScreenObservation> {
    const databaseNow = new Date(fences.databaseNow);
    const appliedContext = canonicalAppliedRealtimeContext(this.lease, databaseNow);
    if (
      appliedContext === null
      || fences.realtimeSessionId !== this.lease.sessionId
      || appliedContext.revision !== fences.contextRevision
      || appliedContext.digest !== fences.contextDigest
      || appliedContext.screenName !== '/devis/new'
    ) {
      return { status: 'rejected', reason: 'context_stale' };
    }

    const rows = await this.transaction.$queryRaw<QuoteDraftSlotRow[]>`
      SELECT ${QUOTE_DRAFT_COLUMNS}
      FROM public.quote_draft_slots
      WHERE "companyId" = ${owner.companyId}
        AND "ownerUserId" = ${owner.ownerUserId}
      LIMIT 1
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) return { status: 'rejected', reason: 'draft_stale' };
    let draft: AgentMissionQuoteDraftSlot;
    try {
      draft = quoteDraftFromRow(row);
    } catch {
      return { status: 'rejected', reason: 'unavailable' };
    }
    if (
      draft.agentMissionId !== fences.missionId
      || draft.payload.draft.sessionId !== fences.draftSessionId
      || draft.revision !== fences.expectedDraftSlotRevision
      || draft.payload.draft.contentRevision !== fences.expectedDraftContentRevision
    ) {
      return { status: 'rejected', reason: 'draft_stale' };
    }
    return {
      status: 'ready',
      realtimeSessionId: this.lease.sessionId,
      contextRevision: appliedContext.revision,
      contextDigest: appliedContext.digest,
      screenInstanceId: appliedContext.screenInstanceId,
      draft: {
        sessionId: draft.payload.draft.sessionId,
        slotRevision: draft.revision,
        contentRevision: draft.payload.draft.contentRevision,
      },
      draftHasCustomer: draft.payload.draft.customer !== null,
    };
  }
}

function createWriteTransaction(
  transaction: Prisma.TransactionClient,
  lease: AgentMissionAuthorityLeaseRow,
  databaseNow: Date,
): AgentMissionTransaction {
  const instant = databaseNow.toISOString();
  return {
    databaseNow: async () => instant,
    realtime: authorizedRealtimeLease(lease, databaseNow),
    missions: new PrismaAgentMissionRepository(transaction),
    events: new PrismaAgentMissionEventRepository(transaction),
    quoteDrafts: new PrismaAgentMissionQuoteDraftRepository(transaction),
    quoteScreen: new PrismaAgentMissionQuoteScreenAuthority(transaction, lease),
    customers: new PrismaAgentMissionCustomerRepository(transaction),
  };
}

export class PrismaAgentMissionUnitOfWork implements AgentMissionUnitOfWorkPort {
  constructor(private readonly prisma: PrismaService) {}

  readQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    authority: AgentMissionRealtimeAuthorityProof,
    work: (transaction: AgentMissionReadTransaction) => Promise<T>,
  ): Promise<AgentMissionReadExecution<T>> {
    if (canonicalAuthorityProof(authority) === null) {
      return Promise.resolve({ status: 'capability_rejected', reason: 'malformed' });
    }
    return this.prisma.withIsolatedOwner(owner.companyId, owner.ownerUserId, async (transaction) => {
      await setTransactionTimeouts(transaction);
      const resolution = await resolveAgentMissionAuthority(
        transaction,
        owner,
        authority,
        false,
      );
      if (resolution.status === 'rejected') {
        return { status: 'capability_rejected', reason: resolution.reason } as const;
      }
      const missions = new PrismaAgentMissionReadRepository(transaction);
      const instant = resolution.databaseNow.toISOString();
      return {
        status: 'executed',
        value: await work({
          databaseNow: async () => instant,
          realtime: authorizedRealtimeLease(
            resolution.lease,
            resolution.databaseNow,
          ),
          missions,
        }),
      } as const;
    }, {
      ...OWNER_TRANSACTION_OPTIONS,
      readOnly: true,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    }) as Promise<AgentMissionReadExecution<T>>;
  }

  runQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    authority: AgentMissionRealtimeAuthorityProof,
    work: (transaction: AgentMissionTransaction) => Promise<T>,
  ): Promise<AgentMissionWriteExecution<T>> {
    if (canonicalAuthorityProof(authority) === null) {
      return Promise.resolve({ status: 'capability_rejected', reason: 'malformed' });
    }
    return this.prisma.withIsolatedOwner(owner.companyId, owner.ownerUserId, async (transaction) => {
      await setTransactionTimeouts(transaction);
      const company = await lockOpenCompanyForMissionWrite(transaction, owner.companyId);
      if (company !== 'open') {
        return { status: 'company_unavailable', reason: company } as const;
      }
      await acquireQuoteCreationOwnerLock(transaction, owner);
      const resolution = await resolveAgentMissionAuthority(
        transaction,
        owner,
        authority,
        true,
      );
      if (resolution.status === 'rejected') {
        return { status: 'capability_rejected', reason: resolution.reason } as const;
      }
      return {
        status: 'executed',
        value: await work(createWriteTransaction(
          transaction,
          resolution.lease,
          resolution.databaseNow,
        )),
      } as const;
    }, { ...OWNER_TRANSACTION_OPTIONS, readOnly: false });
  }
}

/**
 * Reprise après perte du handle volatile.
 *
 * Cette autorité n'accède ni aux leases Realtime ni à leurs capabilities. Elle ne prend aucun
 * verrou SQL et ne fournit aucun port d'écriture au callback.
 */
export class PrismaAgentMissionResumeUnitOfWork
implements AgentMissionResumeUnitOfWorkPort {
  constructor(private readonly prisma: PrismaService) {}

  readQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionResumeReadTransaction) => Promise<T>,
  ): Promise<AgentMissionResumeReadExecution<T>> {
    return this.prisma.withIsolatedOwner(
      owner.companyId,
      owner.ownerUserId,
      async (transaction) => {
        await setTransactionTimeouts(transaction);
        const companies = await transaction.$queryRaw<Array<{ closedAt: Date | null }>>`
          SELECT "closedAt"
          FROM public.companies
          WHERE "id" = ${owner.companyId}
          LIMIT 1
        `;
        const company = companies[0];
        if (company === undefined) {
          return { status: 'company_unavailable', reason: 'missing' } as const;
        }
        if (company.closedAt !== null) {
          return { status: 'company_unavailable', reason: 'closed' } as const;
        }
        const now = await databaseClock(transaction);
        return {
          status: 'executed',
          value: await work({
            databaseNow: async () => now.toISOString(),
            missions: new PrismaAgentMissionReadRepository(transaction),
            quoteDrafts: new PrismaAgentMissionResumeQuoteDraftRepository(transaction),
            customers: new PrismaAgentMissionResumeCustomerRepository(transaction),
          }),
        } as const;
      },
      {
        ...OWNER_TRANSACTION_OPTIONS,
        readOnly: true,
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );
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
