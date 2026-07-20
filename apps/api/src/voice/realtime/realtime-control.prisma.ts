import { Prisma } from '@prisma/client';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type {
  RealtimeConsumableControlGrant,
  RealtimeControlGrantConsumeInput,
  RealtimeControlGrantConsumeResult,
  RealtimeControlGrantIssueInput,
  RealtimeControlGrantIssueResult,
  RealtimeControlGrantReadInput,
  RealtimeControlGrantReadResult,
  RealtimeControlRepositoryPort,
} from './realtime-control.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const POSTGRES_INT_MAX = 2_147_483_647;
const MAX_CONTROL_BYTES = 32 * 1024;
const MAX_CONTROL_TTL_SECONDS = 120;

interface ExistingGrantRow {
  id: string;
  artifactId: string;
  contextRevision: number;
  contextDigest: string;
  controlKind: string;
  controlPayloadHmac: string;
  encryptionKeyVersion: number;
  proofKeyVersion: number;
}

interface ConsumableGrantRow extends ExistingGrantRow {
  companyId: string;
  subjectHash: string;
  sessionId: string;
  turnId: string;
  sidebandOwnerEpoch: number;
  sidebandOwnerTokenHash: string;
  sealedControl: Uint8Array;
  controlNonce: Uint8Array;
  controlTag: Uint8Array;
  acknowledgementId: string;
  existingAcknowledgementId: string | null;
  databaseNow: Date;
  expiresAt: Date;
  fenceCurrent: boolean;
}

interface LockedArtifactRow {
  subjectHash: string;
  state: string;
  deliveryId: string | null;
  contextRevision: number;
  contextDigest: string;
  sidebandOwnerEpoch: number;
  sidebandOwnerTokenHash: string;
}

interface LockedLeaseRow {
  state: string;
  providerId: string | null;
  providerCallId: string | null;
  contextRevision: number | null;
  contextDigest: string | null;
  contextAppliedRevision: number | null;
  contextAppliedDigest: string | null;
  contextAppliedOwnerEpoch: number | null;
  sidebandOwnerEpoch: number;
  sidebandOwnerTokenHash: string | null;
  live: boolean;
}

interface LockedTicketRow {
  state: string;
  subjectHash: string;
  providerSessionId: string | null;
  providerTermination: string | null;
  contextRevision: number;
  contextDigest: string;
}

interface LockedGrantRow extends ExistingGrantRow {
  companyId: string;
  sessionId: string;
  turnId: string;
  expiresAt: Date;
  databaseNow: Date;
}

interface ConsumptionRow { acknowledgementId: string }

function trim(value: string | null): string | null {
  return value === null ? null : value.trim();
}

function asBytes(value: Uint8Array): Buffer {
  return Buffer.from(value);
}

function validVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= POSTGRES_INT_MAX;
}

function validBase(input: {
  companyId: string;
  subjectHash: string;
  sessionId: string;
  turnId: string;
  contextRevision: number;
  contextDigest: string;
}): boolean {
  return COMPANY_ID.test(input.companyId)
    && SHA256_HEX.test(input.subjectHash)
    && UUID.test(input.sessionId)
    && UUID.test(input.turnId)
    && validVersion(input.contextRevision)
    && SHA256_HEX.test(input.contextDigest);
}

function validIssue(input: RealtimeControlGrantIssueInput): boolean {
  const proposalTime = input.proposalExpiresAt === null ? null : Date.parse(input.proposalExpiresAt);
  return validBase(input)
    && UUID.test(input.artifactId)
    && UUID.test(input.grantId)
    && validVersion(input.sidebandOwnerEpoch)
    && SHA256_HEX.test(input.sidebandOwnerTokenHash)
    && (input.controlKind === 'navigate' || input.controlKind === 'proposal')
    && input.sealedControl instanceof Uint8Array
    && input.sealedControl.byteLength >= 1
    && input.sealedControl.byteLength <= MAX_CONTROL_BYTES
    && input.controlNonce instanceof Uint8Array
    && input.controlNonce.byteLength === 12
    && input.controlTag instanceof Uint8Array
    && input.controlTag.byteLength === 16
    && SHA256_HEX.test(input.controlPayloadHmac)
    && validVersion(input.encryptionKeyVersion)
    && validVersion(input.proofKeyVersion)
    && Number.isSafeInteger(input.maxTtlSeconds)
    && input.maxTtlSeconds >= 1
    && input.maxTtlSeconds <= MAX_CONTROL_TTL_SECONDS
    && (proposalTime === null || (
      Number.isFinite(proposalTime)
      && new Date(proposalTime).toISOString() === input.proposalExpiresAt
    ));
}

function validRead(input: RealtimeControlGrantReadInput): boolean {
  return validBase(input) && UUID.test(input.acknowledgementId);
}

function validConsume(input: RealtimeControlGrantConsumeInput): boolean {
  return validRead(input)
    && UUID.test(input.grantId)
    && UUID.test(input.artifactId)
    && validVersion(input.sidebandOwnerEpoch)
    && SHA256_HEX.test(input.sidebandOwnerTokenHash)
    && SHA256_HEX.test(input.controlPayloadHmac);
}

function sameIssuedGrant(row: ExistingGrantRow, input: RealtimeControlGrantIssueInput): boolean {
  return row.artifactId.toLowerCase() === input.artifactId.toLowerCase()
    && row.contextRevision === input.contextRevision
    && trim(row.contextDigest) === input.contextDigest
    && row.controlKind === input.controlKind
    && trim(row.controlPayloadHmac) === input.controlPayloadHmac
    && row.encryptionKeyVersion === input.encryptionKeyVersion
    && row.proofKeyVersion === input.proofKeyVersion;
}

function mapConsumable(row: ConsumableGrantRow): RealtimeConsumableControlGrant | null {
  if (!UUID.test(row.id)
    || !COMPANY_ID.test(row.companyId)
    || !SHA256_HEX.test(trim(row.subjectHash) ?? '')
    || !UUID.test(row.sessionId)
    || !UUID.test(row.turnId)
    || !UUID.test(row.artifactId)
    || !UUID.test(row.acknowledgementId)
    || !validVersion(row.contextRevision)
    || !SHA256_HEX.test(trim(row.contextDigest) ?? '')
    || !validVersion(row.sidebandOwnerEpoch)
    || !SHA256_HEX.test(trim(row.sidebandOwnerTokenHash) ?? '')
    || (row.controlKind !== 'navigate' && row.controlKind !== 'proposal')
    || !(row.sealedControl instanceof Uint8Array)
    || !(row.controlNonce instanceof Uint8Array)
    || !(row.controlTag instanceof Uint8Array)
    || !SHA256_HEX.test(trim(row.controlPayloadHmac) ?? '')
    || !validVersion(row.encryptionKeyVersion)
    || !validVersion(row.proofKeyVersion)
    || !(row.databaseNow instanceof Date)
    || Number.isNaN(row.databaseNow.getTime())
    || !(row.expiresAt instanceof Date)
    || row.expiresAt.getTime() <= row.databaseNow.getTime()) return null;
  return {
    grantId: row.id.toLowerCase(),
    companyId: row.companyId,
    subjectHash: trim(row.subjectHash) ?? '',
    sessionId: row.sessionId.toLowerCase(),
    turnId: row.turnId.toLowerCase(),
    artifactId: row.artifactId.toLowerCase(),
    acknowledgementId: row.acknowledgementId.toLowerCase(),
    contextRevision: row.contextRevision,
    contextDigest: trim(row.contextDigest) ?? '',
    sidebandOwnerEpoch: row.sidebandOwnerEpoch,
    sidebandOwnerTokenHash: trim(row.sidebandOwnerTokenHash) ?? '',
    controlKind: row.controlKind,
    sealedControl: Uint8Array.from(row.sealedControl),
    controlNonce: Uint8Array.from(row.controlNonce),
    controlTag: Uint8Array.from(row.controlTag),
    controlPayloadHmac: trim(row.controlPayloadHmac) ?? '',
    encryptionKeyVersion: row.encryptionKeyVersion,
    proofKeyVersion: row.proofKeyVersion,
    databaseNow: row.databaseNow,
  };
}

function postgresErrorCode(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const databaseCode = error.meta?.code;
    return typeof databaseCode === 'string' ? databaseCode : error.code;
  }
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export class PrismaRealtimeControlRepository implements RealtimeControlRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async issue(input: RealtimeControlGrantIssueInput): Promise<RealtimeControlGrantIssueResult> {
    if (!validIssue(input)) return { status: 'unavailable' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          WITH db_clock AS (
            SELECT clock_timestamp() AS now
          ), candidate AS (
            SELECT artifact.id, clock.now,
                   LEAST(
                     clock.now + make_interval(secs => ${input.maxTtlSeconds}),
                     lease."leaseExpiresAt",
                     lease."hardExpiresAt",
                     lease."sidebandOwnerLeaseExpiresAt",
                     COALESCE(${input.proposalExpiresAt}::timestamptz, 'infinity'::timestamptz)
                   ) AS "expiresAt"
              FROM realtime_speech_artifacts AS artifact
              JOIN realtime_session_leases AS lease
                ON lease."companyId" = artifact."companyId"
               AND lease."subjectHash" = artifact."subjectHash"
               AND lease."sessionId" = artifact."sessionId"
              CROSS JOIN db_clock AS clock
             WHERE artifact."companyId" = ${input.companyId}
               AND artifact."subjectHash" = ${input.subjectHash}
               AND artifact."sessionId" = ${input.sessionId}::uuid
               AND artifact."turnId" = ${input.turnId}::uuid
               AND artifact.id = ${input.artifactId}::uuid
               AND artifact.state = 'ready'
               AND artifact."contextRevision" = ${input.contextRevision}
               AND artifact."contextDigest" = ${input.contextDigest}
               AND artifact."sidebandOwnerEpoch" = ${input.sidebandOwnerEpoch}
               AND artifact."sidebandOwnerTokenHash" = ${input.sidebandOwnerTokenHash}
               AND lease.state = 'active'
               AND lease."contextRevision" = artifact."contextRevision"
               AND lease."contextDigest" = artifact."contextDigest"
               AND lease."contextAppliedRevision" = artifact."contextRevision"
               AND lease."contextAppliedDigest" = artifact."contextDigest"
               AND lease."contextAppliedOwnerEpoch" = artifact."sidebandOwnerEpoch"
               AND lease."sidebandOwnerEpoch" = artifact."sidebandOwnerEpoch"
               AND lease."sidebandOwnerTokenHash" = artifact."sidebandOwnerTokenHash"
               AND lease."sidebandProtocolVersion" = 2
          )
          INSERT INTO realtime_control_grants (
            id, "companyId", "sessionId", "turnId", "artifactId",
            "contextRevision", "contextDigest", "controlKind", "sealedControl",
            "controlNonce", "controlTag", "controlPayloadHmac", "encryptionKeyVersion",
            "proofKeyVersion", "issuedAt", "expiresAt", "retentionExpiresAt"
          )
          SELECT ${input.grantId}::uuid, ${input.companyId}, ${input.sessionId}::uuid,
                 ${input.turnId}::uuid, ${input.artifactId}::uuid, ${input.contextRevision},
                 ${input.contextDigest}, ${input.controlKind}, ${asBytes(input.sealedControl)},
                 ${asBytes(input.controlNonce)}, ${asBytes(input.controlTag)},
                 ${input.controlPayloadHmac}, ${input.encryptionKeyVersion},
                 ${input.proofKeyVersion}, candidate.now, candidate."expiresAt",
                 candidate.now + interval '30 days'
            FROM candidate
           WHERE candidate."expiresAt" > candidate.now
          ON CONFLICT ("companyId", "sessionId", "turnId") DO NOTHING
          RETURNING id
        `;
        if (inserted[0]?.id?.toLowerCase() === input.grantId.toLowerCase()) {
          return { status: 'issued' as const, grantId: input.grantId.toLowerCase() };
        }
        const [existing] = await tx.$queryRaw<ExistingGrantRow[]>`
          SELECT id, "artifactId" AS "artifactId", "contextRevision" AS "contextRevision",
                 "contextDigest" AS "contextDigest", "controlKind" AS "controlKind",
                 "controlPayloadHmac" AS "controlPayloadHmac",
                 "encryptionKeyVersion" AS "encryptionKeyVersion",
                 "proofKeyVersion" AS "proofKeyVersion"
            FROM realtime_control_grants
           WHERE "companyId" = ${input.companyId}
             AND "sessionId" = ${input.sessionId}::uuid
             AND "turnId" = ${input.turnId}::uuid
           LIMIT 1
        `;
        if (!existing) return { status: 'not_found' as const };
        return sameIssuedGrant(existing, input)
          ? { status: 'already_issued' as const, grantId: existing.id.toLowerCase() }
          : { status: 'conflict' as const };
      });
    } catch (error) {
      const code = postgresErrorCode(error);
      return code === 'P2002' || code === '23505'
        ? { status: 'conflict' }
        : { status: 'unavailable' };
    }
  }

  async readConsumable(input: RealtimeControlGrantReadInput): Promise<RealtimeControlGrantReadResult> {
    if (!validRead(input)) return { status: 'not_found' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<ConsumableGrantRow[]>`
          SELECT control_grant.id,
                 control_grant."companyId" AS "companyId",
                 artifact."subjectHash" AS "subjectHash",
                 control_grant."sessionId" AS "sessionId",
                 control_grant."turnId" AS "turnId",
                 control_grant."artifactId" AS "artifactId",
                 control_grant."contextRevision" AS "contextRevision",
                 control_grant."contextDigest" AS "contextDigest",
                 artifact."sidebandOwnerEpoch" AS "sidebandOwnerEpoch",
                 artifact."sidebandOwnerTokenHash" AS "sidebandOwnerTokenHash",
                 control_grant."controlKind" AS "controlKind",
                 control_grant."sealedControl" AS "sealedControl",
                 control_grant."controlNonce" AS "controlNonce",
                 control_grant."controlTag" AS "controlTag",
                 control_grant."controlPayloadHmac" AS "controlPayloadHmac",
                 control_grant."encryptionKeyVersion" AS "encryptionKeyVersion",
                 control_grant."proofKeyVersion" AS "proofKeyVersion",
                 artifact."deliveryId" AS "acknowledgementId",
                 consumption."acknowledgementId" AS "existingAcknowledgementId",
                 clock_timestamp() AS "databaseNow",
                 control_grant."expiresAt" AS "expiresAt",
                 EXISTS (
                   SELECT 1
                     FROM realtime_session_leases AS lease
                    WHERE lease."companyId" = artifact."companyId"
                      AND lease."subjectHash" = artifact."subjectHash"
                      AND lease."sessionId" = artifact."sessionId"
                      AND lease.state = 'active'
                      AND lease."leaseExpiresAt" > clock_timestamp()
                      AND lease."hardExpiresAt" > clock_timestamp()
                      AND lease."contextRevision" = artifact."contextRevision"
                      AND lease."contextDigest" = artifact."contextDigest"
                      AND lease."contextAppliedRevision" = artifact."contextRevision"
                      AND lease."contextAppliedDigest" = artifact."contextDigest"
                      AND lease."contextAppliedOwnerEpoch" = artifact."sidebandOwnerEpoch"
                      AND lease."sidebandOwnerEpoch" = artifact."sidebandOwnerEpoch"
                      AND lease."sidebandOwnerTokenHash" = artifact."sidebandOwnerTokenHash"
                      AND lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
                      AND lease."sidebandProtocolVersion" = 2
                 ) AS "fenceCurrent"
            FROM realtime_control_grants AS control_grant
            JOIN realtime_speech_artifacts AS artifact
              ON artifact.id = control_grant."artifactId"
             AND artifact."companyId" = control_grant."companyId"
             AND artifact."sessionId" = control_grant."sessionId"
             AND artifact."turnId" = control_grant."turnId"
            LEFT JOIN realtime_control_consumptions AS consumption
              ON consumption."companyId" = control_grant."companyId"
             AND consumption."grantId" = control_grant.id
           WHERE control_grant."companyId" = ${input.companyId}
             AND artifact."subjectHash" = ${input.subjectHash}
             AND control_grant."sessionId" = ${input.sessionId}::uuid
             AND control_grant."turnId" = ${input.turnId}::uuid
             AND control_grant."contextRevision" = ${input.contextRevision}
             AND control_grant."contextDigest" = ${input.contextDigest}
             AND control_grant."expiresAt" > clock_timestamp()
             AND artifact.state = 'delivered'
             AND artifact."deliveryId" = ${input.acknowledgementId}::uuid
           LIMIT 1
        `;
        if (!row) return { status: 'not_found' as const };
        const existingAck = row.existingAcknowledgementId?.toLowerCase() ?? null;
        if (existingAck !== null && existingAck !== input.acknowledgementId.toLowerCase()) {
          return { status: 'conflict' as const };
        }
        if (!row.fenceCurrent && existingAck === null) return { status: 'not_found' as const };
        const grant = mapConsumable(row);
        return grant
          ? { status: 'eligible' as const, grant }
          : { status: 'unavailable' as const };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async consume(input: RealtimeControlGrantConsumeInput): Promise<RealtimeControlGrantConsumeResult> {
    if (!validConsume(input)) return { status: 'not_found' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        // Ordre global : ticket -> artefact -> lease -> grant -> consumption. Il est identique aux
        // transitions delivery/complete et empêche les deadlocks entre deux répliques.
        const [ticket] = await tx.$queryRaw<LockedTicketRow[]>`
          SELECT state, "subjectHash" AS "subjectHash", "providerSessionId" AS "providerSessionId",
                 "providerTermination" AS "providerTermination",
                 "contextRevision" AS "contextRevision", "contextDigest" AS "contextDigest"
           FROM realtime_mistral_ingress_tickets
           WHERE "companyId" = ${input.companyId}
             AND "sessionId" = ${input.sessionId}::uuid
             AND id = ${input.turnId}::uuid
           FOR UPDATE
        `;
        const [artifact] = await tx.$queryRaw<LockedArtifactRow[]>`
          SELECT "subjectHash" AS "subjectHash", state, "deliveryId" AS "deliveryId",
                 "contextRevision" AS "contextRevision", "contextDigest" AS "contextDigest",
                 "sidebandOwnerEpoch" AS "sidebandOwnerEpoch",
                 "sidebandOwnerTokenHash" AS "sidebandOwnerTokenHash"
            FROM realtime_speech_artifacts
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
             AND "turnId" = ${input.turnId}::uuid
             AND id = ${input.artifactId}::uuid
           FOR UPDATE
        `;
        if (!artifact) return { status: 'not_found' as const };
        const [lease] = await tx.$queryRaw<LockedLeaseRow[]>`
          SELECT state, "providerId" AS "providerId", "providerCallId" AS "providerCallId",
                 "contextRevision" AS "contextRevision", "contextDigest" AS "contextDigest",
                 "contextAppliedRevision" AS "contextAppliedRevision",
                 "contextAppliedDigest" AS "contextAppliedDigest",
                 "contextAppliedOwnerEpoch" AS "contextAppliedOwnerEpoch",
                 "sidebandOwnerEpoch" AS "sidebandOwnerEpoch",
                 "sidebandOwnerTokenHash" AS "sidebandOwnerTokenHash",
                 (
                   state = 'active'
                   AND "leaseExpiresAt" > clock_timestamp()
                   AND "hardExpiresAt" > clock_timestamp()
                   AND "sidebandOwnerLeaseExpiresAt" > clock_timestamp()
                   AND "sidebandProtocolVersion" = 2
                 ) AS live
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
           FOR UPDATE
        `;
        const [grant] = await tx.$queryRaw<LockedGrantRow[]>`
          SELECT id, "companyId" AS "companyId", "sessionId" AS "sessionId",
                 "turnId" AS "turnId", "artifactId" AS "artifactId",
                 "contextRevision" AS "contextRevision", "contextDigest" AS "contextDigest",
                 "controlKind" AS "controlKind", "controlPayloadHmac" AS "controlPayloadHmac",
                 "encryptionKeyVersion" AS "encryptionKeyVersion",
                 "proofKeyVersion" AS "proofKeyVersion", "expiresAt" AS "expiresAt",
                 clock_timestamp() AS "databaseNow"
            FROM realtime_control_grants
           WHERE "companyId" = ${input.companyId}
             AND "sessionId" = ${input.sessionId}::uuid
             AND "turnId" = ${input.turnId}::uuid
             AND id = ${input.grantId}::uuid
           FOR UPDATE
        `;
        if (!grant || !sameConsumeBinding(input, artifact, grant)) {
          return { status: 'not_found' as const };
        }
        const [existing] = await tx.$queryRaw<ConsumptionRow[]>`
          SELECT "acknowledgementId" AS "acknowledgementId"
            FROM realtime_control_consumptions
           WHERE "companyId" = ${input.companyId}
             AND "grantId" = ${input.grantId}::uuid
           FOR UPDATE
        `;
        if (existing) {
          return existing.acknowledgementId.toLowerCase() === input.acknowledgementId.toLowerCase()
            ? { status: 'consumed' as const, idempotent: true }
            : { status: 'conflict' as const };
        }
        if (!lease
          || !sameLiveFence(input, artifact, lease)
          || !(grant.databaseNow instanceof Date)
          || !(grant.expiresAt instanceof Date)
          || grant.expiresAt.getTime() <= grant.databaseNow.getTime()) {
          return { status: 'not_found' as const };
        }
        const inserted = await tx.$executeRaw`
          INSERT INTO realtime_control_consumptions (
            "companyId", "grantId", "acknowledgementId", "sessionId", "turnId",
            "consumedAt", "retentionExpiresAt"
          ) VALUES (
            ${input.companyId}, ${input.grantId}::uuid, ${input.acknowledgementId}::uuid,
            ${input.sessionId}::uuid, ${input.turnId}::uuid,
            clock_timestamp(), clock_timestamp() + interval '30 days'
          )
          ON CONFLICT ("companyId", "grantId") DO NOTHING
        `;
        if (inserted !== 1) {
          const [winner] = await tx.$queryRaw<ConsumptionRow[]>`
            SELECT "acknowledgementId" AS "acknowledgementId"
              FROM realtime_control_consumptions
             WHERE "companyId" = ${input.companyId}
               AND "grantId" = ${input.grantId}::uuid
          `;
          return winner?.acknowledgementId.toLowerCase() === input.acknowledgementId.toLowerCase()
            ? { status: 'consumed' as const, idempotent: true }
            : { status: 'conflict' as const };
        }
        await this.releaseCompletedMistralDrain(tx, input, artifact, lease, ticket);
        return { status: 'consumed' as const, idempotent: false };
      });
    } catch (error) {
      const code = postgresErrorCode(error);
      return code === 'P2002' || code === '23505'
        ? { status: 'conflict' }
        : { status: 'unavailable' };
    }
  }

  private async releaseCompletedMistralDrain(
    tx: Prisma.TransactionClient,
    input: RealtimeControlGrantConsumeInput,
    artifact: LockedArtifactRow,
    lease: LockedLeaseRow,
    ticket: LockedTicketRow | undefined,
  ): Promise<void> {
    if (!ticket
      || ticket.state !== 'completed'
      || ticket.providerTermination !== 'confirmed'
      || trim(ticket.subjectHash) !== input.subjectHash
      || ticket.providerSessionId !== lease.providerCallId
      || ticket.contextRevision !== input.contextRevision
      || trim(ticket.contextDigest) !== input.contextDigest
      || lease.providerId !== 'mistral') return;
    await tx.$executeRaw`
      DELETE FROM realtime_session_leases AS lease
       WHERE lease."companyId" = ${input.companyId}
         AND lease."subjectHash" = ${input.subjectHash}
         AND lease."sessionId" = ${input.sessionId}::uuid
         AND lease.state = 'active'
         AND lease."providerId" = 'mistral'
         AND lease."providerCallId" = ${ticket.providerSessionId}
         AND lease."contextRevision" = ${artifact.contextRevision}
         AND lease."contextDigest" = ${trim(artifact.contextDigest)}
         AND lease."contextAppliedRevision" = ${artifact.contextRevision}
         AND lease."contextAppliedDigest" = ${trim(artifact.contextDigest)}
         AND lease."contextAppliedOwnerEpoch" = ${artifact.sidebandOwnerEpoch}
         AND lease."sidebandOwnerEpoch" = ${artifact.sidebandOwnerEpoch}
         AND lease."sidebandOwnerTokenHash" = ${trim(artifact.sidebandOwnerTokenHash)}
         AND NOT EXISTS (
           SELECT 1
             FROM realtime_speech_artifacts AS pending
            WHERE pending."companyId" = lease."companyId"
              AND pending."subjectHash" = lease."subjectHash"
              AND pending."sessionId" = lease."sessionId"
              AND pending.state IN ('rendering', 'ready')
         )
         AND NOT EXISTS (
           SELECT 1
             FROM realtime_control_grants AS active_grant
            WHERE active_grant."companyId" = lease."companyId"
              AND active_grant."sessionId" = lease."sessionId"
              AND active_grant."expiresAt" > clock_timestamp()
              AND NOT EXISTS (
                SELECT 1
                  FROM realtime_control_consumptions AS consumed
                 WHERE consumed."companyId" = active_grant."companyId"
                   AND consumed."grantId" = active_grant.id
              )
         )
    `;
  }
}

function sameConsumeBinding(
  input: RealtimeControlGrantConsumeInput,
  artifact: LockedArtifactRow,
  grant: LockedGrantRow,
): boolean {
  return trim(artifact.subjectHash) === input.subjectHash
    && artifact.state === 'delivered'
    && artifact.deliveryId?.toLowerCase() === input.acknowledgementId.toLowerCase()
    && artifact.contextRevision === input.contextRevision
    && trim(artifact.contextDigest) === input.contextDigest
    && artifact.sidebandOwnerEpoch === input.sidebandOwnerEpoch
    && trim(artifact.sidebandOwnerTokenHash) === input.sidebandOwnerTokenHash
    && grant.artifactId.toLowerCase() === input.artifactId.toLowerCase()
    && grant.contextRevision === input.contextRevision
    && trim(grant.contextDigest) === input.contextDigest
    && trim(grant.controlPayloadHmac) === input.controlPayloadHmac;
}

function sameLiveFence(
  input: RealtimeControlGrantConsumeInput,
  artifact: LockedArtifactRow,
  lease: LockedLeaseRow,
): boolean {
  return lease.live
    && lease.contextRevision === input.contextRevision
    && trim(lease.contextDigest) === input.contextDigest
    && lease.contextAppliedRevision === input.contextRevision
    && trim(lease.contextAppliedDigest) === input.contextDigest
    && lease.contextAppliedOwnerEpoch === artifact.sidebandOwnerEpoch
    && lease.sidebandOwnerEpoch === artifact.sidebandOwnerEpoch
    && trim(lease.sidebandOwnerTokenHash) === input.sidebandOwnerTokenHash;
}
