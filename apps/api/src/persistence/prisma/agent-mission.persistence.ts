import { timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AGENT_MISSION_PROTOCOL_V1,
  AGENT_MISSION_PROTOCOL_M2A,
  AGENT_MISSION_PROTOCOL_VERSIONS,
  AgentMission,
  AgentMissionEvent,
  normalizeCustomerName,
  parseAgentMissionQuoteLineWork,
  parseCustomPrestation,
  parseQuoteDraftPayload,
  type AgentMissionAuthorizedRealtimeLease,
  type AgentMissionCapabilityRejectionReason,
  type AgentMissionDraftFenceResult,
  type AgentMissionEventLookup,
  type AgentMissionEventRepositoryPort,
  type AgentMissionDraftFencePort,
  type AgentMissionForeground,
  type AgentMissionForegroundUnavailableReason,
  type AgentMissionLookup,
  type AgentMissionOwner,
  type AgentMissionProtocolVersion,
  type AgentMissionQuoteScreenAuthorityPort,
  type AgentMissionQuoteScreenFences,
  type AgentMissionQuoteScreenObservation,
  type AgentMissionQuoteDraftRepositoryPort,
  type AgentMissionQuoteDraftSlot,
  type AgentMissionQuoteLineWork,
  type AgentMissionQuoteLineWorkRepositoryPort,
  type AgentMissionReadRepositoryPort,
  type AgentMissionReadTransaction,
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionRepositoryPort,
  type AgentMissionReadExecution,
  type AgentMissionResumeReadExecution,
  type AgentMissionResumeReadTransaction,
  type AgentMissionResumeUnitOfWorkPort,
  type AgentMissionResumeV2ReadTransaction,
  type AgentMissionResumeV2UnitOfWorkPort,
  type AgentMissionTransaction,
  type AgentMissionUnitOfWorkPort,
  type AgentMissionWriteExecution,
  type CustomerCandidate,
  type CustomerCandidateReadPort,
  type CustomerCandidateReference,
  type CustomerCandidateSearchPort,
  type CatalogueCandidateRecord,
  type QuoteDraftPayloadV1,
  type QuoteVatContextPort,
  type QuoteVatDecisionContext,
} from '@bob/core';
import {
  Prisma,
  type AgentMission as AgentMissionRow,
  type AgentMissionEvent as AgentMissionEventRow,
  type AgentMissionQuoteLineWork as AgentMissionQuoteLineWorkRow,
  type QuoteDraftSlot as QuoteDraftSlotRow,
} from '@prisma/client';
import { prepareRealtimeContext } from '../../voice/realtime/realtime-admission';
import { PrismaCatalogueCandidateSearch } from './catalogue-candidate.persistence';
import { canonicalPrismaVatRate } from './prisma-vat-rate';
import type { PrismaService } from './prisma.service';

const OWNER_TRANSACTION_OPTIONS = {
  maxWaitMs: 5_000,
  timeoutMs: 15_000,
} as const;

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_SUBJECT_HASH_CANDIDATES = 32;
const QUOTE_VAT_REGIMES = new Set([
  'franchise',
  'reel_simpl',
  'reel_normal',
] as const);
const QUOTE_VAT_TRADES = new Set([
  'plombier',
  'electricien',
  'macon',
  'peintre',
  'paysagiste',
  'frigoriste',
  'mainteneur',
  'consultant',
  'freelance_it',
  'photographe',
  'coach',
  'autre',
] as const);
const QUOTE_VAT_CUSTOMER_TYPES = new Set(['b2c', 'b2b', 'b2g'] as const);

const MISSION_COLUMNS = Prisma.sql`
  "id",
  "companyId",
  "ownerUserId",
  "protocolVersion",
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

const QUOTE_LINE_WORK_COLUMNS = Prisma.sql`
  "id",
  "companyId",
  "ownerUserId",
  "missionId",
  "ordinal",
  "revision",
  "state",
  "origin",
  "catalogueResolution",
  "serviceReference",
  "category",
  "quantityMilli",
  "unit",
  "unitPriceCents",
  "requestedVatRate",
  "priceBasis",
  "housingOlderThan2y",
  "energyRenovation",
  "requiredFact",
  "catalogueItemId",
  "expectedCatalogueRevision",
  "catalogueCategoryOverrideConfirmed",
  "catalogueUnitOverrideConfirmed",
  "proposalId",
  "proposalRevision",
  "proposalDiffHash",
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

interface QuoteVatContextRow {
  readonly customerId: string;
  readonly companyVatRegime: string;
  readonly companyTrade: string;
  readonly customerType: string;
  readonly customerIsSubcontractingBtp: boolean;
}

interface AgentMissionResumeCatalogueRow {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly unit: string | null;
  readonly unitPriceHT: number;
  readonly vatRate: Prisma.Decimal;
  readonly revision: number;
}

function canonicalAgentMissionResumeCatalogueRecord(
  row: AgentMissionResumeCatalogueRow,
): CatalogueCandidateRecord {
  const prestation = parseCustomPrestation({
    id: row.id,
    label: row.label,
    category: row.category,
    unit: row.unit,
    unitPriceHT: row.unitPriceHT,
    vatRate: canonicalPrismaVatRate(row.vatRate),
  });
  if (
    prestation === null
    || !Number.isSafeInteger(row.revision)
    || row.revision < 1
    || row.revision > 2_147_483_647
  ) {
    throw new Error('AGENT_MISSION_RESUME_CATALOGUE_ROW_CORRUPT');
  }
  return Object.freeze({ ...prestation, revision: row.revision });
}

function canonicalCustomerName(value: string): string {
  // Les lignes historiques précèdent parfois la normalisation du domaine. Une valeur réellement
  // invalide reste inchangée afin que le validateur core échoue fermé ; seuls les espaces sans
  // sémantique sont réparés à la frontière Prisma.
  return normalizeCustomerName(value) ?? value;
}

function canonicalPersistedAgentMissionProtocolVersion(
  value: number,
): AgentMissionProtocolVersion {
  if (
    !Number.isSafeInteger(value)
    || !(AGENT_MISSION_PROTOCOL_VERSIONS as readonly number[]).includes(value)
  ) {
    throw new Error('AGENT_MISSION_PROTOCOL_VERSION_CORRUPT');
  }
  return value as AgentMissionProtocolVersion;
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
  readonly protocolVersion: AgentMissionProtocolVersion;
  readonly subjectHashCandidates: readonly string[];
  readonly principalBindingHash: string;
  readonly capabilityHash: string;
} | null {
  if (
    !AGENT_MISSION_PROTOCOL_VERSIONS.includes(proof.protocolVersion)
    || !Array.isArray(proof.subjectHashCandidates)
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
    protocolVersion: proof.protocolVersion,
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

function postgresErrorCode(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const databaseCode = error.meta?.code;
    return typeof databaseCode === 'string' ? databaseCode : error.code;
  }
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as {
    readonly code?: unknown;
    readonly meta?: { readonly code?: unknown };
  };
  if (typeof candidate.meta?.code === 'string') return candidate.meta.code;
  const code = candidate.code;
  return typeof code === 'string' ? code : null;
}

function prismaTransactionTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    readonly meta?: { readonly error?: unknown };
  };
  const detail = candidate.meta?.error;
  return typeof detail === 'string'
    && (
      detail === 'Unable to start a transaction in the given time.'
      || /^(?:Transaction already closed: )?A (?:query|commit|rollback) cannot be executed on an expired transaction\./u.test(
        detail,
      )
    );
}

function foregroundUnavailableReason(
  error: unknown,
): AgentMissionForegroundUnavailableReason | null {
  const code = postgresErrorCode(error);
  if (code === '55P03') return 'lock_timeout';
  if (code === '57014') return 'query_canceled';
  if (code === 'P2028' && prismaTransactionTimeout(error)) return 'transaction_timeout';
  return null;
}

/**
 * Sentinel interne : une erreur SQLSTATE survenue DANS le callback transactionnel doit sortir
 * par une exception. Retourner un statut depuis ce callback ferait croire à Prisma que le
 * callback a réussi alors que PostgreSQL a déjà aborté la transaction, donc faux succès possible.
 */
class AgentMissionForegroundTransactionUnavailable extends Error {
  readonly name = 'AgentMissionForegroundTransactionUnavailable';

  constructor(readonly reason: AgentMissionForegroundUnavailableReason) {
    super('agent_mission_foreground_transaction_unavailable');
  }
}

function rethrowForegroundTransactionFailure(error: unknown): never {
  const reason = foregroundUnavailableReason(error);
  if (reason !== null) {
    throw new AgentMissionForegroundTransactionUnavailable(reason);
  }
  throw error;
}

async function mapForegroundTransactionFailure<R>(
  operation: () => Promise<R>,
): Promise<
  R | {
    readonly status: 'foreground_unavailable';
    readonly reason: AgentMissionForegroundUnavailableReason;
  }
> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentMissionForegroundTransactionUnavailable) {
      return { status: 'foreground_unavailable', reason: error.reason };
    }
    // Une panne peut aussi survenir dans la frontière `withIsolatedOwner` elle-même, avant
    // l'entrée dans notre callback. À ce stade la promesse transactionnelle a déjà rejeté :
    // le rollback est donc acquis et le mapping externe est sûr.
    const reason = foregroundUnavailableReason(error);
    if (reason !== null) return { status: 'foreground_unavailable', reason };
    throw error;
  }
}

function validAuthorityLeaseAt(
  row: AgentMissionAuthorityLeaseRow,
  databaseNow: Date,
  protocolVersion: AgentMissionProtocolVersion,
): boolean {
  return row.state === 'active'
    && row.leaseExpiresAt.getTime() > databaseNow.getTime()
    && row.hardExpiresAt.getTime() > databaseNow.getTime()
    && row.agentMissionProtocolVersion === protocolVersion
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
    protocolVersion: canonicalPersistedAgentMissionProtocolVersion(row.protocolVersion),
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

function quoteLineWorkFromRow(
  row: AgentMissionQuoteLineWorkRow,
): AgentMissionQuoteLineWork {
  const quantityMilli = row.quantityMilli === null
    ? null
    : Number(row.quantityMilli);
  const requestedVatRate = row.requestedVatRate === null
    ? null
    : canonicalPrismaVatRate(row.requestedVatRate);
  if (row.requestedVatRate !== null && requestedVatRate === null) {
    throw new Error(
      'AGENT_MISSION_QUOTE_LINE_WORK_ROW_CORRUPT:requestedVatRate:invalid_value',
    );
  }
  const parsed = parseAgentMissionQuoteLineWork({
    id: row.id,
    companyId: row.companyId,
    ownerUserId: row.ownerUserId,
    missionId: row.missionId,
    ordinal: row.ordinal,
    revision: row.revision,
    state: row.state,
    origin: row.origin,
    catalogueResolution: row.catalogueResolution,
    serviceReference: row.serviceReference,
    category: row.category,
    quantityMilli,
    unit: row.unit,
    unitPriceCents: row.unitPriceCents,
    requestedVatRate,
    priceBasis: row.priceBasis,
    housingOlderThan2y: row.housingOlderThan2y,
    energyRenovation: row.energyRenovation,
    requiredFact: row.requiredFact,
    catalogueItemId: row.catalogueItemId,
    expectedCatalogueRevision: row.expectedCatalogueRevision,
    catalogueCategoryOverrideConfirmed:
      row.catalogueCategoryOverrideConfirmed,
    catalogueUnitOverrideConfirmed:
      row.catalogueUnitOverrideConfirmed,
    proposalId: row.proposalId,
    proposalRevision: row.proposalRevision,
    proposalDiffHash: row.proposalDiffHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.ok) {
    throw new Error(
      `AGENT_MISSION_QUOTE_LINE_WORK_ROW_CORRUPT:${parsed.error.field}:${
        parsed.error.reason
      }`,
    );
  }
  return parsed.value;
}

async function setMissionContext(
  transaction: Prisma.TransactionClient,
  missionId: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT set_config('app.current_agent_mission_id', ${missionId}, true)
  `;
}

async function lockActiveQuoteMissionForWork(
  transaction: Prisma.TransactionClient,
  input: AgentMissionOwner & { readonly missionId: string },
  expectedProtocolVersion: AgentMissionProtocolVersion,
): Promise<boolean> {
  // Le contexte est nécessaire pour satisfaire la policy UPDATE de la mission lors du
  // SELECT ... FOR UPDATE. L'identifiant seul ne confère aucune autorité : la ligne parent doit
  // aussi appartenir au tenant/propriétaire courant, être un devis et rester active.
  await setMissionContext(transaction, input.missionId);
  const rows = await transaction.$queryRaw<Array<{ readonly id: string }>>`
    SELECT "id"
    FROM public.agent_missions
    WHERE "id" = ${input.missionId}::UUID
      AND "companyId" = ${input.companyId}
      AND "ownerUserId" = ${input.ownerUserId}
      AND "kind" = 'quote_creation'
      AND "status" = 'active'
      AND "protocolVersion" = ${expectedProtocolVersion}
    LIMIT 1
    FOR UPDATE
  `;
  return rows.length === 1;
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

function missionForegroundOwnerLockKey(owner: AgentMissionOwner): string {
  return [
    'bob.agent-mission.owner-foreground.v2',
    owner.companyId,
    owner.ownerUserId,
  ].join('\u001f');
}

async function acquireMissionForegroundOwnerLock(
  transaction: Prisma.TransactionClient,
  owner: AgentMissionOwner,
): Promise<void> {
  const ownerLockKey = missionForegroundOwnerLockKey(owner);
  await transaction.$queryRaw<Array<{ locked: boolean }>>`
    SELECT (
      pg_advisory_xact_lock(hashtextextended(${ownerLockKey}, 0)) IS NULL
    ) AS "locked"
  `;
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
  const eligible = rows.filter((row) => validAuthorityLeaseAt(
    row,
    now,
    canonical.protocolVersion,
  ));
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
  constructor(
    protected readonly transaction: Prisma.TransactionClient,
    protected readonly expectedProtocolVersion: AgentMissionProtocolVersion,
  ) {}

  async findActive(input: AgentMissionOwner & {
    readonly kind: 'quote_creation';
  }): Promise<AgentMission | null> {
    const row = await this.transaction.agentMission.findFirst({
      where: {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        kind: input.kind,
        status: 'active',
        protocolVersion: this.expectedProtocolVersion,
      },
    });
    return row === null ? null : missionFromRow(row);
  }

  async findForeground(input: AgentMissionOwner): Promise<AgentMissionForeground | null> {
    const visible = await this.transaction.agentMission.findMany({
      where: {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        status: 'active',
      },
      select: { id: true, kind: true, protocolVersion: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
    if (visible.length > 1) {
      throw new Error('AGENT_MISSION_FOREGROUND_AMBIGUOUS');
    }
    const reference = visible[0];
    if (reference === undefined) return null;
    if (reference.kind !== 'quote_creation') {
      return {
        status: 'unsupported_kind',
        missionId: reference.id,
        kind: reference.kind,
      };
    }
    const protocolVersion = canonicalPersistedAgentMissionProtocolVersion(
      reference.protocolVersion,
    );
    if (protocolVersion !== this.expectedProtocolVersion) {
      return {
        status: 'unsupported_protocol',
        missionId: reference.id,
        kind: 'quote_creation',
        protocolVersion,
      };
    }
    const lookup = await this.findById({
      ...input,
      missionId: reference.id,
    });
    if (lookup === null || lookup.status !== 'known') {
      throw new Error('AGENT_MISSION_FOREGROUND_DISAPPEARED');
    }
    return lookup;
  }

  async findById(input: AgentMissionOwner & {
    readonly missionId: string;
  }): Promise<AgentMissionLookup | null> {
    const reference = await this.transaction.agentMission.findFirst({
      where: {
        id: input.missionId,
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
      },
      select: { id: true, kind: true, protocolVersion: true },
    });
    if (reference === null) return null;
    if (reference.kind !== 'quote_creation') {
      return {
        status: 'unsupported_kind',
        missionId: reference.id,
        kind: reference.kind,
      };
    }
    const protocolVersion = canonicalPersistedAgentMissionProtocolVersion(
      reference.protocolVersion,
    );
    if (protocolVersion !== this.expectedProtocolVersion) {
      return {
        status: 'unsupported_protocol',
        missionId: reference.id,
        kind: 'quote_creation',
        protocolVersion,
      };
    }
    const row = await this.transaction.agentMission.findFirst({
      where: {
        id: input.missionId,
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        kind: 'quote_creation',
        protocolVersion: this.expectedProtocolVersion,
      },
    });
    return row === null ? null : { status: 'known', mission: missionFromRow(row) };
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
        protocolVersion: this.expectedProtocolVersion,
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
        AND "protocolVersion" = ${this.expectedProtocolVersion}
      LIMIT 1
      FOR UPDATE
    `;
    return rows[0] === undefined ? null : missionFromRow(rows[0]);
  }

  async findForegroundForUpdate(
    input: AgentMissionOwner,
  ): Promise<AgentMissionForeground | null> {
    // Le verrou foreground global est possédé par l'UoW. La première lecture ne parse aucun
    // payload : un binaire K2 peut donc voir un futur kind sans l'interpréter comme un devis.
    const visible = await this.transaction.agentMission.findMany({
      where: {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        status: 'active',
      },
      select: { id: true, kind: true, protocolVersion: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
    if (visible.length > 1) {
      throw new Error('AGENT_MISSION_FOREGROUND_AMBIGUOUS');
    }
    const reference = visible[0];
    if (reference === undefined) return null;
    await setMissionContext(this.transaction, reference.id);
    if (reference.kind !== 'quote_creation') {
      const locked = await this.transaction.$queryRaw<Array<{ id: string; kind: string }>>`
        SELECT "id", "kind"
        FROM public.agent_missions
        WHERE "id" = ${reference.id}::UUID
          AND "companyId" = ${input.companyId}
          AND "ownerUserId" = ${input.ownerUserId}
          AND "status" = 'active'
        LIMIT 1
        FOR UPDATE
      `;
      const row = locked[0];
      if (row === undefined) {
        throw new Error('AGENT_MISSION_FOREGROUND_DISAPPEARED');
      }
      return {
        status: 'unsupported_kind',
        missionId: row.id,
        kind: row.kind,
      };
    }
    const protocolVersion = canonicalPersistedAgentMissionProtocolVersion(
      reference.protocolVersion,
    );
    if (protocolVersion !== this.expectedProtocolVersion) {
      return {
        status: 'unsupported_protocol',
        missionId: reference.id,
        kind: 'quote_creation',
        protocolVersion,
      };
    }
    const rows = await this.transaction.$queryRaw<AgentMissionRow[]>`
      SELECT ${MISSION_COLUMNS}
      FROM public.agent_missions
      WHERE "id" = ${reference.id}::UUID
        AND "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "kind" = 'quote_creation'
        AND "status" = 'active'
        AND "protocolVersion" = ${this.expectedProtocolVersion}
      LIMIT 1
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error('AGENT_MISSION_FOREGROUND_DISAPPEARED');
    }
    return { status: 'known', mission: missionFromRow(row) };
  }

  async findByIdForUpdate(input: AgentMissionOwner & {
    readonly missionId: string;
  }): Promise<AgentMissionLookup | null> {
    await setMissionContext(this.transaction, input.missionId);
    const reference = await this.transaction.agentMission.findFirst({
      where: {
        id: input.missionId,
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
      },
      select: { id: true, kind: true, protocolVersion: true },
    });
    if (reference === null) return null;
    // Une mission terminale d'un futur kind reste discriminée : l'appelant ne peut ni la parser
    // comme un devis, ni confondre son identifiant avec une absence.
    if (reference.kind !== 'quote_creation') {
      return {
        status: 'unsupported_kind',
        missionId: reference.id,
        kind: reference.kind,
      };
    }
    const protocolVersion = canonicalPersistedAgentMissionProtocolVersion(
      reference.protocolVersion,
    );
    if (protocolVersion !== this.expectedProtocolVersion) {
      return {
        status: 'unsupported_protocol',
        missionId: reference.id,
        kind: 'quote_creation',
        protocolVersion,
      };
    }
    const rows = await this.transaction.$queryRaw<AgentMissionRow[]>`
      SELECT ${MISSION_COLUMNS}
      FROM public.agent_missions
      WHERE "id" = ${input.missionId}::UUID
        AND "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "protocolVersion" = ${this.expectedProtocolVersion}
      LIMIT 1
      FOR UPDATE
    `;
    return rows[0] === undefined
      ? null
      : { status: 'known', mission: missionFromRow(rows[0]) };
  }

  async insert(mission: AgentMission): Promise<'inserted' | 'conflict'> {
    const snapshot = mission.toSnapshot();
    if (snapshot.protocolVersion !== this.expectedProtocolVersion) {
      throw new Error('AGENT_MISSION_PROTOCOL_AUTHORITY_MISMATCH');
    }
    await setMissionContext(this.transaction, snapshot.id);
    const inserted = await this.transaction.agentMission.createMany({
      data: [{
        id: snapshot.id,
        companyId: snapshot.companyId,
        ownerUserId: snapshot.ownerUserId,
        protocolVersion: snapshot.protocolVersion,
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
      }],
      skipDuplicates: true,
    });
    if (inserted.count === 1) return 'inserted';
    return 'conflict';
  }

  async updateCas(input: {
    readonly mission: AgentMission;
    readonly expectedRevision: number;
  }): Promise<'updated' | 'revision_conflict'> {
    const snapshot = input.mission.toSnapshot();
    if (snapshot.protocolVersion !== this.expectedProtocolVersion) {
      throw new Error('AGENT_MISSION_PROTOCOL_AUTHORITY_MISMATCH');
    }
    await setMissionContext(this.transaction, snapshot.id);
    const updated = await this.transaction.agentMission.updateMany({
      where: {
        id: snapshot.id,
        companyId: snapshot.companyId,
        ownerUserId: snapshot.ownerUserId,
        protocolVersion: this.expectedProtocolVersion,
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
  constructor(
    private readonly transaction: Prisma.TransactionClient,
    private readonly expectedProtocolVersion: AgentMissionProtocolVersion,
  ) {}

  async findByCommandId(input: AgentMissionOwner & {
    readonly commandId: string;
  }): Promise<AgentMissionEventLookup | null> {
    const reference = await this.transaction.agentMissionEvent.findFirst({
      where: {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        commandId: input.commandId,
      },
      select: {
        missionId: true,
        mission: { select: { kind: true, protocolVersion: true } },
      },
    });
    if (reference === null) return null;
    if (reference.mission.kind !== 'quote_creation') {
      return {
        status: 'unsupported_kind',
        missionId: reference.missionId,
        kind: reference.mission.kind,
      };
    }
    const protocolVersion = canonicalPersistedAgentMissionProtocolVersion(
      reference.mission.protocolVersion,
    );
    if (protocolVersion !== this.expectedProtocolVersion) {
      return {
        status: 'unsupported_protocol',
        missionId: reference.missionId,
        kind: 'quote_creation',
        protocolVersion,
      };
    }
    const row = await this.transaction.agentMissionEvent.findFirst({
      where: {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        commandId: input.commandId,
        mission: {
          kind: 'quote_creation',
          protocolVersion: this.expectedProtocolVersion,
        },
      },
    });
    return row === null ? null : { status: 'known', event: eventFromRow(row) };
  }

  async append(event: AgentMissionEvent): Promise<void> {
    const snapshot = event.toSnapshot();
    await setMissionContext(this.transaction, snapshot.missionId);
    const owner = await this.transaction.agentMission.findFirst({
      where: {
        id: snapshot.missionId,
        companyId: snapshot.companyId,
        ownerUserId: snapshot.ownerUserId,
        protocolVersion: this.expectedProtocolVersion,
      },
      select: { id: true },
    });
    if (owner === null) {
      throw new Error('AGENT_MISSION_EVENT_PROTOCOL_AUTHORITY_MISMATCH');
    }
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

  async appendLineCas(input: AgentMissionOwner & {
    readonly missionId: string;
    readonly expectedSlotRevision: number;
    readonly expectedDraftSessionId: string;
    readonly expectedDraftContentRevision: number;
    readonly payload: QuoteDraftPayloadV1;
  }): Promise<AgentMissionQuoteDraftSlot | null> {
    const payload = parseQuoteDraftPayload(input.payload);
    if (
      !payload.ok
      || payload.value.draft.sessionId !== input.expectedDraftSessionId
      || payload.value.draft.contentRevision
        !== input.expectedDraftContentRevision + 1
      || payload.value.draft.step !== 'lignes'
      || payload.value.draft.customer === null
    ) {
      return null;
    }
    await setMissionContext(this.transaction, input.missionId);
    const payloadJson = JSON.stringify(payload.value);
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
        AND "payload" -> 'draft' ->> 'sessionId'
          = ${input.expectedDraftSessionId}
        AND ("payload" #>> '{draft,contentRevision}')::integer
          = ${input.expectedDraftContentRevision}
        AND "payload" -> 'draft' ->> 'step' = 'lignes'
        AND "payload" -> 'draft' -> 'customer' <> 'null'::jsonb
      RETURNING ${QUOTE_DRAFT_COLUMNS}
    `;
    return rows[0] === undefined ? null : quoteDraftFromRow(rows[0]);
  }
}

function quoteLineWorkForPersistence(
  workItem: AgentMissionQuoteLineWork,
): AgentMissionQuoteLineWork {
  const parsed = parseAgentMissionQuoteLineWork(workItem);
  if (!parsed.ok) {
    throw new Error(
      `AGENT_MISSION_QUOTE_LINE_WORK_INPUT_INVALID:${parsed.error.field}:${
        parsed.error.reason
      }`,
    );
  }
  return parsed.value;
}

function quoteLineWorkCreateData(
  workItem: AgentMissionQuoteLineWork,
): Prisma.AgentMissionQuoteLineWorkCreateManyInput {
  return {
    id: workItem.id,
    companyId: workItem.companyId,
    ownerUserId: workItem.ownerUserId,
    missionId: workItem.missionId,
    ordinal: workItem.ordinal,
    revision: workItem.revision,
    state: workItem.state,
    origin: workItem.origin,
    catalogueResolution: workItem.catalogueResolution,
    serviceReference: workItem.serviceReference,
    category: workItem.category,
    quantityMilli: workItem.quantityMilli === null
      ? null
      : BigInt(workItem.quantityMilli),
    unit: workItem.unit,
    unitPriceCents: workItem.unitPriceCents,
    requestedVatRate: workItem.requestedVatRate === null
      ? null
      : new Prisma.Decimal(workItem.requestedVatRate),
    priceBasis: workItem.priceBasis,
    housingOlderThan2y: workItem.housingOlderThan2y,
    energyRenovation: workItem.energyRenovation,
    requiredFact: workItem.requiredFact,
    catalogueItemId: workItem.catalogueItemId,
    expectedCatalogueRevision: workItem.expectedCatalogueRevision,
    catalogueCategoryOverrideConfirmed:
      workItem.catalogueCategoryOverrideConfirmed,
    catalogueUnitOverrideConfirmed:
      workItem.catalogueUnitOverrideConfirmed,
    proposalId: workItem.proposalId,
    proposalRevision: workItem.proposalRevision,
    proposalDiffHash: workItem.proposalDiffHash,
    createdAt: new Date(workItem.createdAt),
    updatedAt: new Date(workItem.updatedAt),
  };
}

class PrismaAgentMissionQuoteLineWorkRepository
implements AgentMissionQuoteLineWorkRepositoryPort {
  constructor(
    private readonly transaction: Prisma.TransactionClient,
    private readonly expectedProtocolVersion: AgentMissionProtocolVersion,
  ) {}

  async listForUpdate(
    input: AgentMissionOwner & { readonly missionId: string },
  ): Promise<readonly AgentMissionQuoteLineWork[]> {
    if (!await lockActiveQuoteMissionForWork(
      this.transaction,
      input,
      this.expectedProtocolVersion,
    )) return [];
    const rows = await this.transaction.$queryRaw<AgentMissionQuoteLineWorkRow[]>`
      SELECT ${QUOTE_LINE_WORK_COLUMNS}
      FROM public.agent_mission_quote_line_work
      WHERE "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "missionId" = ${input.missionId}::UUID
      ORDER BY "ordinal" ASC, "id" ASC
      FOR UPDATE
    `;
    return rows.map(quoteLineWorkFromRow);
  }

  async findByIdForUpdate(
    input: AgentMissionOwner & {
      readonly missionId: string;
      readonly workItemId: string;
    },
  ): Promise<AgentMissionQuoteLineWork | null> {
    if (!await lockActiveQuoteMissionForWork(
      this.transaction,
      input,
      this.expectedProtocolVersion,
    )) return null;
    const rows = await this.transaction.$queryRaw<AgentMissionQuoteLineWorkRow[]>`
      SELECT ${QUOTE_LINE_WORK_COLUMNS}
      FROM public.agent_mission_quote_line_work
      WHERE "id" = ${input.workItemId}::UUID
        AND "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "missionId" = ${input.missionId}::UUID
      LIMIT 1
      FOR UPDATE
    `;
    return rows[0] === undefined ? null : quoteLineWorkFromRow(rows[0]);
  }

  async insertMany(
    input: AgentMissionOwner & {
      readonly missionId: string;
      readonly workItems: readonly AgentMissionQuoteLineWork[];
    },
  ): Promise<'inserted' | 'conflict'> {
    if (input.workItems.length === 0) return 'inserted';
    if (!await lockActiveQuoteMissionForWork(
      this.transaction,
      input,
      this.expectedProtocolVersion,
    )) return 'conflict';

    const canonical = input.workItems.map(quoteLineWorkForPersistence);
    if (
      canonical.some((item) => (
        item.companyId !== input.companyId
        || item.ownerUserId !== input.ownerUserId
        || item.missionId !== input.missionId
        || item.revision !== 1
      ))
      || new Set(canonical.map((item) => item.id)).size !== canonical.length
      || new Set(canonical.map((item) => item.ordinal)).size !== canonical.length
    ) {
      throw new Error('AGENT_MISSION_QUOTE_LINE_WORK_INSERT_SCOPE_INVALID');
    }

    const existing = await this.transaction.agentMissionQuoteLineWork.findFirst({
      where: {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        missionId: input.missionId,
        OR: [
          { id: { in: canonical.map((item) => item.id) } },
          { ordinal: { in: canonical.map((item) => item.ordinal) } },
        ],
      },
      select: { id: true },
    });
    if (existing !== null) return 'conflict';

    // Prisma ne fournit pas de transaction imbriquée dans une interactive transaction. Ce
    // savepoint rend néanmoins le contrat `conflict` atomique : une collision UUID globale ne
    // peut jamais laisser un sous-ensemble des lignes inséré.
    await this.transaction.$executeRawUnsafe(
      'SAVEPOINT bob_agent_mission_quote_line_work_insert',
    );
    try {
      await this.transaction.agentMissionQuoteLineWork.createMany({
        data: canonical.map(quoteLineWorkCreateData),
      });
      await this.transaction.$executeRawUnsafe(
        'RELEASE SAVEPOINT bob_agent_mission_quote_line_work_insert',
      );
      return 'inserted';
    } catch (error) {
      await this.transaction.$executeRawUnsafe(
        'ROLLBACK TO SAVEPOINT bob_agent_mission_quote_line_work_insert',
      );
      await this.transaction.$executeRawUnsafe(
        'RELEASE SAVEPOINT bob_agent_mission_quote_line_work_insert',
      );
      if (postgresErrorCode(error) === '23505' || postgresErrorCode(error) === 'P2002') {
        return 'conflict';
      }
      throw error;
    }
  }

  async updateCas(input: {
    readonly workItem: AgentMissionQuoteLineWork;
    readonly expectedRevision: number;
  }): Promise<'updated' | 'revision_conflict'> {
    const workItem = quoteLineWorkForPersistence(input.workItem);
    if (
      !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 1
      || workItem.revision !== input.expectedRevision + 1
    ) {
      throw new Error('AGENT_MISSION_QUOTE_LINE_WORK_CAS_REVISION_INVALID');
    }
    if (!await lockActiveQuoteMissionForWork(
      this.transaction,
      {
        companyId: workItem.companyId,
        ownerUserId: workItem.ownerUserId,
        missionId: workItem.missionId,
      },
      this.expectedProtocolVersion,
    )) {
      return 'revision_conflict';
    }
    const updated = await this.transaction.agentMissionQuoteLineWork.updateMany({
      where: {
        id: workItem.id,
        companyId: workItem.companyId,
        ownerUserId: workItem.ownerUserId,
        missionId: workItem.missionId,
        ordinal: workItem.ordinal,
        origin: workItem.origin,
        createdAt: new Date(workItem.createdAt),
        revision: input.expectedRevision,
      },
      data: {
        revision: workItem.revision,
        state: workItem.state,
        catalogueResolution: workItem.catalogueResolution,
        serviceReference: workItem.serviceReference,
        category: workItem.category,
        quantityMilli: workItem.quantityMilli === null
          ? null
          : BigInt(workItem.quantityMilli),
        unit: workItem.unit,
        unitPriceCents: workItem.unitPriceCents,
        requestedVatRate: workItem.requestedVatRate === null
          ? null
          : new Prisma.Decimal(workItem.requestedVatRate),
        priceBasis: workItem.priceBasis,
        housingOlderThan2y: workItem.housingOlderThan2y,
        energyRenovation: workItem.energyRenovation,
        requiredFact: workItem.requiredFact,
        catalogueItemId: workItem.catalogueItemId,
        expectedCatalogueRevision: workItem.expectedCatalogueRevision,
        catalogueCategoryOverrideConfirmed:
          workItem.catalogueCategoryOverrideConfirmed,
        catalogueUnitOverrideConfirmed:
          workItem.catalogueUnitOverrideConfirmed,
        proposalId: workItem.proposalId,
        proposalRevision: workItem.proposalRevision,
        proposalDiffHash: workItem.proposalDiffHash,
        updatedAt: new Date(workItem.updatedAt),
      },
    });
    return updated.count === 1 ? 'updated' : 'revision_conflict';
  }

  async delete(
    input: AgentMissionOwner & {
      readonly missionId: string;
      readonly workItemId: string;
      readonly expectedRevision: number;
    },
  ): Promise<'deleted' | 'not_found' | 'revision_conflict'> {
    if (!await lockActiveQuoteMissionForWork(
      this.transaction,
      input,
      this.expectedProtocolVersion,
    )) return 'not_found';
    const rows = await this.transaction.$queryRaw<Array<{ readonly revision: number }>>`
      SELECT "revision"
      FROM public.agent_mission_quote_line_work
      WHERE "id" = ${input.workItemId}::UUID
        AND "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "missionId" = ${input.missionId}::UUID
      LIMIT 1
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) return 'not_found';
    if (row.revision !== input.expectedRevision) return 'revision_conflict';
    const deleted = await this.transaction.$queryRaw<Array<{ readonly id: string }>>`
      DELETE FROM public.agent_mission_quote_line_work
      WHERE "id" = ${input.workItemId}::UUID
        AND "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "missionId" = ${input.missionId}::UUID
        AND "revision" = ${input.expectedRevision}
      RETURNING "id"
    `;
    return deleted.length === 1 ? 'deleted' : 'revision_conflict';
  }

  async deleteAll(
    input: AgentMissionOwner & { readonly missionId: string },
  ): Promise<number> {
    if (!await lockActiveQuoteMissionForWork(
      this.transaction,
      input,
      this.expectedProtocolVersion,
    )) return 0;
    const deleted = await this.transaction.$queryRaw<Array<{ readonly id: string }>>`
      DELETE FROM public.agent_mission_quote_line_work
      WHERE "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "missionId" = ${input.missionId}::UUID
      RETURNING "id"
    `;
    return deleted.length;
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

class PrismaAgentMissionResumeQuoteLineWorkRepository {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async list(
    input: AgentMissionOwner & { readonly missionId: string },
  ): Promise<readonly AgentMissionQuoteLineWork[]> {
    const rows = await this.transaction.$queryRaw<AgentMissionQuoteLineWorkRow[]>`
      SELECT ${QUOTE_LINE_WORK_COLUMNS}
      FROM public.agent_mission_quote_line_work
      WHERE "companyId" = ${input.companyId}
        AND "ownerUserId" = ${input.ownerUserId}
        AND "missionId" = ${input.missionId}::UUID
      ORDER BY "ordinal" ASC, "id" ASC
      LIMIT 21
    `;
    return Object.freeze(rows.map(quoteLineWorkFromRow));
  }
}

class PrismaAgentMissionResumeCatalogueRepository {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async findByIds(input: {
    readonly companyId: string;
    readonly catalogueItemIds: readonly string[];
  }): Promise<readonly CatalogueCandidateRecord[]> {
    if (input.catalogueItemIds.length === 0) return Object.freeze([]);
    const ids = [...new Set(input.catalogueItemIds)];
    if (ids.length !== input.catalogueItemIds.length || ids.length > 6) {
      throw new Error('AGENT_MISSION_RESUME_CATALOGUE_INPUT_INVALID');
    }
    const rows = await this.transaction.$queryRaw<
      AgentMissionResumeCatalogueRow[]
    >`
      SELECT
        c."id",
        c."label",
        c."category"::TEXT AS "category",
        c."unit",
        c."unitPriceHt" AS "unitPriceHT",
        c."vatRate",
        c."revision"
      FROM public.catalogue_prestations AS c
      WHERE c."companyId" = ${input.companyId}
        AND c."id" IN (${Prisma.join(ids)})
      ORDER BY c."id" ASC
    `;
    return Object.freeze(
      rows.map(canonicalAgentMissionResumeCatalogueRecord),
    );
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

function canonicalQuoteVatContextRow(
  row: QuoteVatContextRow,
): QuoteVatDecisionContext {
  if (
    !QUOTE_VAT_REGIMES.has(
      row.companyVatRegime as 'franchise' | 'reel_simpl' | 'reel_normal',
    )
    || !QUOTE_VAT_TRADES.has(
      row.companyTrade as
        | 'plombier'
        | 'electricien'
        | 'macon'
        | 'peintre'
        | 'paysagiste'
        | 'frigoriste'
        | 'mainteneur'
        | 'consultant'
        | 'freelance_it'
        | 'photographe'
        | 'coach'
        | 'autre',
    )
    || !QUOTE_VAT_CUSTOMER_TYPES.has(
      row.customerType as 'b2c' | 'b2b' | 'b2g',
    )
    || typeof row.customerIsSubcontractingBtp !== 'boolean'
  ) {
    throw new Error('AGENT_MISSION_QUOTE_VAT_CONTEXT_CORRUPT');
  }
  return Object.freeze({
    customerId: row.customerId,
    companyVatRegime: row.companyVatRegime as
      QuoteVatDecisionContext['companyVatRegime'],
    companyTrade: row.companyTrade as QuoteVatDecisionContext['companyTrade'],
    customerType: row.customerType as QuoteVatDecisionContext['customerType'],
    customerIsSubcontractingBtp: row.customerIsSubcontractingBtp,
  });
}

class PrismaQuoteVatContext implements QuoteVatContextPort {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async getForUpdate(input: {
    readonly companyId: string;
    readonly customerId: string;
  }): Promise<QuoteVatDecisionContext | null> {
    const rows = await this.transaction.$queryRaw<QuoteVatContextRow[]>`
      SELECT
        customer."id" AS "customerId",
        company."vatRegime"::TEXT AS "companyVatRegime",
        company."trade" AS "companyTrade",
        customer."type"::TEXT AS "customerType",
        customer."isSubcontractingBtp" AS "customerIsSubcontractingBtp"
      FROM public.companies AS company
      JOIN public.customers AS customer
        ON customer."companyId" = company."id"
      WHERE company."id" = ${input.companyId}
        AND customer."id" = ${input.customerId}
        AND customer."companyId" = ${input.companyId}
      LIMIT 1
      FOR SHARE OF company, customer
    `;
    return rows[0] === undefined ? null : canonicalQuoteVatContextRow(rows[0]);
  }
}

class PrismaAgentMissionResumeQuoteVatContextRepository {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async get(input: {
    readonly companyId: string;
    readonly customerId: string;
  }): Promise<QuoteVatDecisionContext | null> {
    const rows = await this.transaction.$queryRaw<QuoteVatContextRow[]>`
      SELECT
        customer."id" AS "customerId",
        company."vatRegime"::TEXT AS "companyVatRegime",
        company."trade" AS "companyTrade",
        customer."type"::TEXT AS "customerType",
        customer."isSubcontractingBtp" AS "customerIsSubcontractingBtp"
      FROM public.companies AS company
      JOIN public.customers AS customer
        ON customer."companyId" = company."id"
      WHERE company."id" = ${input.companyId}
        AND customer."id" = ${input.customerId}
        AND customer."companyId" = ${input.companyId}
      LIMIT 1
    `;
    return rows[0] === undefined ? null : canonicalQuoteVatContextRow(rows[0]);
  }
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
  protocolVersion: AgentMissionProtocolVersion,
): AgentMissionTransaction {
  const instant = databaseNow.toISOString();
  return {
    databaseNow: async () => instant,
    realtime: authorizedRealtimeLease(lease, databaseNow),
    missions: new PrismaAgentMissionRepository(transaction, protocolVersion),
    events: new PrismaAgentMissionEventRepository(transaction, protocolVersion),
    quoteDrafts: new PrismaAgentMissionQuoteDraftRepository(transaction),
    quoteLineWork: new PrismaAgentMissionQuoteLineWorkRepository(
      transaction,
      protocolVersion,
    ),
    quoteScreen: new PrismaAgentMissionQuoteScreenAuthority(transaction, lease),
    customers: new PrismaAgentMissionCustomerRepository(transaction),
    catalogueCandidates: new PrismaCatalogueCandidateSearch(transaction),
    quoteVatContext: new PrismaQuoteVatContext(transaction),
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
      const missions = new PrismaAgentMissionReadRepository(
        transaction,
        authority.protocolVersion,
      );
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
    return mapForegroundTransactionFailure(() =>
      this.prisma.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        async (transaction) => {
          try {
            await setTransactionTimeouts(transaction);
            const company = await lockOpenCompanyForMissionWrite(transaction, owner.companyId);
            if (company !== 'open') {
              return { status: 'company_unavailable', reason: company } as const;
            }
            await acquireMissionForegroundOwnerLock(transaction, owner);
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
                authority.protocolVersion,
              )),
            } as const;
          } catch (error) {
            rethrowForegroundTransactionFailure(error);
          }
        },
        { ...OWNER_TRANSACTION_OPTIONS, readOnly: false },
      ),
    );
  }
}

/**
 * Reprise après perte du handle volatile.
 *
 * Cette autorité n'accède ni aux leases Realtime ni à leurs capabilities. Elle ne prend aucun
 * verrou SQL et ne fournit aucun port d'écriture au callback.
 */
export class PrismaAgentMissionResumeUnitOfWork
implements AgentMissionResumeUnitOfWorkPort, AgentMissionResumeV2UnitOfWorkPort {
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
            // Le wire de reprise publié reste V1 jusqu'au train mobile M2-A-3. Une mission V2
            // est donc détectée par sa seule colonne avant tout décodage de payload.
            missions: new PrismaAgentMissionReadRepository(
              transaction,
              AGENT_MISSION_PROTOCOL_V1,
            ),
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

  readQuoteCreationOwnerV2<T>(
    owner: AgentMissionOwner,
    work: (transaction: AgentMissionResumeV2ReadTransaction) => Promise<T>,
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
            missions: new PrismaAgentMissionReadRepository(
              transaction,
              AGENT_MISSION_PROTOCOL_M2A,
            ),
            quoteDrafts: new PrismaAgentMissionResumeQuoteDraftRepository(transaction),
            customers: new PrismaAgentMissionResumeCustomerRepository(transaction),
            quoteLineWork:
              new PrismaAgentMissionResumeQuoteLineWorkRepository(transaction),
            catalogue: new PrismaAgentMissionResumeCatalogueRepository(transaction),
            quoteVatContext:
              new PrismaAgentMissionResumeQuoteVatContextRepository(transaction),
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
    return mapForegroundTransactionFailure(() =>
      this.prisma.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        async (transaction) => {
          try {
            await setTransactionTimeouts(transaction);
            const company = await lockOpenCompanyForMissionWrite(transaction, owner.companyId);
            if (company !== 'open') {
              return { status: 'company_unavailable', reason: company } as const;
            }
            await acquireMissionForegroundOwnerLock(transaction, owner);
            await acquireQuoteCreationOwnerLock(transaction, owner);
            const rows = await transaction.$queryRaw<Array<{ agentMissionId: string | null }>>`
              SELECT "agentMissionId"
              FROM public.quote_draft_slots
              WHERE "companyId" = ${owner.companyId}
                AND "ownerUserId" = ${owner.ownerUserId}
              LIMIT 1
              FOR UPDATE
            `;
            // Tout marqueur est bloquant, même si la mission liée est terminale : un orphelin est
            // une corruption à réparer, jamais une permission implicite de contourner le trigger SQL.
            if (rows[0]?.agentMissionId != null) {
              return { status: 'owned_by_agent_mission' } as const;
            }
            return { status: 'executed', value: await work() } as const;
          } catch (error) {
            rethrowForegroundTransactionFailure(error);
          }
        },
        { ...OWNER_TRANSACTION_OPTIONS, readOnly: false },
      ),
    );
  }
}
