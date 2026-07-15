import { Prisma } from '@prisma/client';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type {
  RealtimeSpeechCancellationMutationInput,
  RealtimeSpeechCancellationMutationResult,
  RealtimeSpeechDeliveryArtifact,
  RealtimeSpeechDeliveryMutationInput,
  RealtimeSpeechDeliveryMutationResult,
  RealtimeSpeechDeliveryReadResult,
  RealtimeSpeechDeliveryRepositoryPort,
  RealtimeSpeechReadyFenceInput,
  RealtimeSpeechReadyFenceResult,
} from './realtime-speech-delivery.repository';

interface ArtifactRow {
  artifactId: string;
  companyId: string;
  subjectHash: string;
  sessionId: string;
  turnId: string;
  sequence: number;
  state: string;
  classification: string;
  source: string | null;
  contextRevision: number;
  contextDigest: string;
  sidebandOwnerEpoch: number;
  sidebandOwnerTokenHash: string;
  storageKey: string | null;
  storageExpiresAt: Date | null;
  mimeType: string | null;
  byteLength: number | null;
  durationMs: number | null;
  canonicalSpeechHmac: string;
  auditTranscriptHmac: string | null;
  factsHmac: string;
  evidenceHmac: string | null;
  audioSha256: string | null;
  proofKeyVersion: number | null;
  synthesisAdapterId: string | null;
  synthesisTrustDomain: string | null;
  auditAdapterId: string | null;
  auditTrustDomain: string | null;
  objectPurgedAt: Date | null;
  deliveryId: string | null;
  cancellationId: string | null;
  cancellationReasonCode: string | null;
  failureReasonCode: string | null;
  version: number;
  fenceCurrent: boolean;
  databaseNow: Date;
}

interface LockedMutationRow {
  state: string;
  contextRevision: number;
  contextDigest: string;
  sidebandOwnerEpoch: number;
  sidebandOwnerTokenHash: string;
  storageKey: string | null;
  storageExpiresAt: Date | null;
  objectPurgedAt: Date | null;
  evidenceHmac: string | null;
  audioSha256: string | null;
  deliveryId: string | null;
  cancellationId: string | null;
  cancellationReasonCode: string | null;
  version: number;
}

interface BooleanRow { ok: boolean }
interface UpdatedDeliveryRow { contextRevision: number; contextDigest: string }

interface MistralDeliveryTicketRow {
  state: string;
  subjectHash: string;
  providerSessionId: string | null;
  providerTermination: string | null;
  contextRevision: number;
  contextDigest: string;
}

const POSTGRES_INT_MAX = 2_147_483_647;
const STATES = new Set(['rendering', 'ready', 'delivered', 'cancelled', 'failed']);

function trim(value: string | null): string | null {
  return value === null ? null : value.trim();
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

function mapArtifact(row: ArtifactRow): RealtimeSpeechDeliveryArtifact | null {
  const state = row.state;
  const classification = row.classification;
  const source = row.source;
  const mimeType = row.mimeType;
  if (!STATES.has(state)
    || (classification !== 'fixed_safe' && classification !== 'dynamic_sensitive')
    || (source !== null && source !== 'preapproved_static' && source !== 'synthesized_audited')
    || (mimeType !== null && mimeType !== 'audio/mpeg' && mimeType !== 'audio/wav')
    || !(row.databaseNow instanceof Date)
    || Number.isNaN(row.databaseNow.getTime())) return null;
  return {
    ...row,
    state: state as RealtimeSpeechDeliveryArtifact['state'],
    classification,
    source,
    mimeType,
    subjectHash: trim(row.subjectHash) ?? '',
    contextDigest: trim(row.contextDigest) ?? '',
    sidebandOwnerTokenHash: trim(row.sidebandOwnerTokenHash) ?? '',
    canonicalSpeechHmac: trim(row.canonicalSpeechHmac) ?? '',
    auditTranscriptHmac: trim(row.auditTranscriptHmac),
    factsHmac: trim(row.factsHmac) ?? '',
    evidenceHmac: trim(row.evidenceHmac),
    audioSha256: trim(row.audioSha256),
  };
}

export class PrismaRealtimeSpeechDeliveryRepository implements RealtimeSpeechDeliveryRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async readNext(input: {
    readonly companyId: string;
    readonly subjectHash: string;
    readonly sessionId: string;
    readonly afterSequence: number;
  }): Promise<RealtimeSpeechDeliveryReadResult> {
    if (!Number.isSafeInteger(input.afterSequence)
      || input.afterSequence < 0
      || input.afterSequence > POSTGRES_INT_MAX) return { status: 'unavailable' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<ArtifactRow[]>`
          SELECT artifact.id AS "artifactId",
                 artifact."companyId" AS "companyId",
                 artifact."subjectHash" AS "subjectHash",
                 artifact."sessionId" AS "sessionId",
                 artifact."turnId" AS "turnId",
                 artifact.sequence,
                 artifact.state,
                 artifact.classification,
                 artifact.source,
                 artifact."contextRevision" AS "contextRevision",
                 artifact."contextDigest" AS "contextDigest",
                 artifact."sidebandOwnerEpoch" AS "sidebandOwnerEpoch",
                 artifact."sidebandOwnerTokenHash" AS "sidebandOwnerTokenHash",
                 artifact."storageKey" AS "storageKey",
                 artifact."storageExpiresAt" AS "storageExpiresAt",
                 artifact."mimeType" AS "mimeType",
                 artifact."byteLength" AS "byteLength",
                 artifact."durationMs" AS "durationMs",
                 artifact."canonicalSpeechHmac" AS "canonicalSpeechHmac",
                 artifact."auditTranscriptHmac" AS "auditTranscriptHmac",
                 artifact."factsHmac" AS "factsHmac",
                 artifact."evidenceHmac" AS "evidenceHmac",
                 artifact."audioSha256" AS "audioSha256",
                 artifact."proofKeyVersion" AS "proofKeyVersion",
                 artifact."synthesisAdapterId" AS "synthesisAdapterId",
                 artifact."synthesisTrustDomain" AS "synthesisTrustDomain",
                 artifact."auditAdapterId" AS "auditAdapterId",
                 artifact."auditTrustDomain" AS "auditTrustDomain",
                 artifact."objectPurgedAt" AS "objectPurgedAt",
                 artifact."deliveryId" AS "deliveryId",
                 artifact."cancellationId" AS "cancellationId",
                 artifact."cancellationReasonCode" AS "cancellationReasonCode",
                 artifact."failureReasonCode" AS "failureReasonCode",
                 artifact.version,
                 clock_timestamp() AS "databaseNow",
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
            FROM realtime_speech_artifacts AS artifact
           WHERE artifact."companyId" = ${input.companyId}
             AND artifact."subjectHash" = ${input.subjectHash}
             AND artifact."sessionId" = ${input.sessionId}::uuid
             AND artifact.sequence > ${input.afterSequence}
           ORDER BY artifact.sequence ASC
           LIMIT 1
        `;
        if (!row) return { status: 'none' as const };
        const artifact = mapArtifact(row);
        return artifact
          ? { status: 'found' as const, artifact }
          : { status: 'unavailable' as const };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async readExact(input: {
    readonly companyId: string;
    readonly subjectHash: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly artifactId: string;
  }): Promise<RealtimeSpeechDeliveryReadResult> {
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<ArtifactRow[]>`
          SELECT artifact.id AS "artifactId",
                 artifact."companyId" AS "companyId",
                 artifact."subjectHash" AS "subjectHash",
                 artifact."sessionId" AS "sessionId",
                 artifact."turnId" AS "turnId",
                 artifact.sequence,
                 artifact.state,
                 artifact.classification,
                 artifact.source,
                 artifact."contextRevision" AS "contextRevision",
                 artifact."contextDigest" AS "contextDigest",
                 artifact."sidebandOwnerEpoch" AS "sidebandOwnerEpoch",
                 artifact."sidebandOwnerTokenHash" AS "sidebandOwnerTokenHash",
                 artifact."storageKey" AS "storageKey",
                 artifact."storageExpiresAt" AS "storageExpiresAt",
                 artifact."mimeType" AS "mimeType",
                 artifact."byteLength" AS "byteLength",
                 artifact."durationMs" AS "durationMs",
                 artifact."canonicalSpeechHmac" AS "canonicalSpeechHmac",
                 artifact."auditTranscriptHmac" AS "auditTranscriptHmac",
                 artifact."factsHmac" AS "factsHmac",
                 artifact."evidenceHmac" AS "evidenceHmac",
                 artifact."audioSha256" AS "audioSha256",
                 artifact."proofKeyVersion" AS "proofKeyVersion",
                 artifact."synthesisAdapterId" AS "synthesisAdapterId",
                 artifact."synthesisTrustDomain" AS "synthesisTrustDomain",
                 artifact."auditAdapterId" AS "auditAdapterId",
                 artifact."auditTrustDomain" AS "auditTrustDomain",
                 artifact."objectPurgedAt" AS "objectPurgedAt",
                 artifact."deliveryId" AS "deliveryId",
                 artifact."cancellationId" AS "cancellationId",
                 artifact."cancellationReasonCode" AS "cancellationReasonCode",
                 artifact."failureReasonCode" AS "failureReasonCode",
                 artifact.version,
                 clock_timestamp() AS "databaseNow",
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
            FROM realtime_speech_artifacts AS artifact
           WHERE artifact."companyId" = ${input.companyId}
             AND artifact."subjectHash" = ${input.subjectHash}
             AND artifact."sessionId" = ${input.sessionId}::uuid
             AND artifact."turnId" = ${input.turnId}::uuid
             AND artifact.id = ${input.artifactId}::uuid
           LIMIT 1
        `;
        if (!row) return { status: 'none' as const };
        const artifact = mapArtifact(row);
        return artifact
          ? { status: 'found' as const, artifact }
          : { status: 'unavailable' as const };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async validateReadyFence(input: RealtimeSpeechReadyFenceInput): Promise<RealtimeSpeechReadyFenceResult> {
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<BooleanRow[]>`
          SELECT EXISTS (
            SELECT 1
              FROM realtime_speech_artifacts AS artifact
              JOIN realtime_session_leases AS lease
                ON lease."companyId" = artifact."companyId"
               AND lease."subjectHash" = artifact."subjectHash"
               AND lease."sessionId" = artifact."sessionId"
             WHERE artifact."companyId" = ${input.companyId}
               AND artifact."subjectHash" = ${input.subjectHash}
               AND artifact."sessionId" = ${input.sessionId}::uuid
               AND artifact."turnId" = ${input.turnId}::uuid
               AND artifact.id = ${input.artifactId}::uuid
               AND artifact.state = 'ready'
               AND artifact.version = ${input.version}
               AND artifact."evidenceHmac" = ${input.evidenceHmac}
               AND artifact."audioSha256" = ${input.audioSha256}
               AND artifact."storageKey" = ${input.storageKey}
               AND artifact."storageExpiresAt" > clock_timestamp()
               AND artifact."objectPurgedAt" IS NULL
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
          ) AS ok
        `;
        if (row?.ok) return 'current' as const;
        return 'terminal' as const;
      });
    } catch {
      return 'unavailable';
    }
  }

  async acknowledgeDelivery(
    input: RealtimeSpeechDeliveryMutationInput,
  ): Promise<RealtimeSpeechDeliveryMutationResult> {
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        // Ordre de locks commun avec ticket.complete : ticket -> artefact -> lease. La ligne
        // n'existe pas pour OpenAI, ce qui conserve le chemin historique sans branche provider.
        const terminalTicket = await this.lockMistralDeliveryTicket(tx, input);
        const row = await this.lockMutationRow(tx, input);
        if (!row) return { status: 'not_found' as const };
        if (row.state === 'delivered') {
          if (row.deliveryId !== input.deliveryId || trim(row.audioSha256) !== input.audioSha256) {
            return { status: 'conflict' as const };
          }
          const released = await this.releaseCompletedMistralLease(tx, input, row, terminalTicket);
          const controlCurrent = !released
            && await this.hasLiveExactUnconsumedControlGrant(tx, input, row);
          return {
            status: 'delivered' as const,
            idempotent: true,
            controlCurrent,
            contextRevision: row.contextRevision,
            contextDigest: trim(row.contextDigest) ?? '',
          };
        }
        if (row.state !== 'ready') return { status: 'terminal' as const };
        if (row.version !== input.version
          || trim(row.evidenceHmac) !== input.evidenceHmac
          || trim(row.audioSha256) !== input.audioSha256
          || row.storageKey !== input.storageKey
          || row.objectPurgedAt !== null
          || !(row.storageExpiresAt instanceof Date)) {
          return { status: 'terminal' as const };
        }
        if (!(await this.hasCurrentFence(tx, input, row))) return { status: 'terminal' as const };

        const [updated] = await tx.$queryRaw<UpdatedDeliveryRow[]>`
          UPDATE realtime_speech_artifacts
             SET state = 'delivered',
                 "deliveryId" = ${input.deliveryId}::uuid,
                 "deliveredAt" = clock_timestamp(),
                 "updatedAt" = clock_timestamp(),
                 version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
             AND "turnId" = ${input.turnId}::uuid
             AND id = ${input.artifactId}::uuid
             AND state = 'ready'
             AND version = ${input.version}
             AND "evidenceHmac" = ${input.evidenceHmac}
             AND "audioSha256" = ${input.audioSha256}
             AND "storageKey" = ${input.storageKey}
             AND "storageExpiresAt" > clock_timestamp()
             AND "objectPurgedAt" IS NULL
          RETURNING "contextRevision" AS "contextRevision", "contextDigest" AS "contextDigest"
        `;
        if (!updated) return { status: 'terminal' as const };
        // La transition ready -> delivered et la libération du drain Mistral partagent la même
        // transaction. Un ACK ne peut donc jamais être visible sans que son lease terminal soit
        // libéré, ni l'inverse. Un autre artefact non terminal interdit volontairement le DELETE.
        const released = await this.releaseCompletedMistralLease(tx, input, row, terminalTicket);
        const controlCurrent = !released
          && await this.hasLiveExactUnconsumedControlGrant(tx, input, row);
        return {
          status: 'delivered' as const,
          idempotent: false,
          controlCurrent,
          contextRevision: updated.contextRevision,
          contextDigest: trim(updated.contextDigest) ?? '',
        };
      });
    } catch (error) {
      const code = postgresErrorCode(error);
      return code === 'P2002' || code === '23505'
        ? { status: 'conflict' }
        : { status: 'unavailable' };
    }
  }

  async cancel(
    input: RealtimeSpeechCancellationMutationInput,
  ): Promise<RealtimeSpeechCancellationMutationResult> {
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<LockedMutationRow[]>`
          SELECT state,
                 "contextRevision" AS "contextRevision",
                 "contextDigest" AS "contextDigest",
                 "sidebandOwnerEpoch" AS "sidebandOwnerEpoch",
                 "sidebandOwnerTokenHash" AS "sidebandOwnerTokenHash",
                 "storageKey" AS "storageKey", "storageExpiresAt" AS "storageExpiresAt",
                 "objectPurgedAt" AS "objectPurgedAt", "evidenceHmac" AS "evidenceHmac",
                 "audioSha256" AS "audioSha256", "deliveryId" AS "deliveryId",
                 "cancellationId" AS "cancellationId",
                 "cancellationReasonCode" AS "cancellationReasonCode", version
            FROM realtime_speech_artifacts
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
             AND "turnId" = ${input.turnId}::uuid
             AND id = ${input.artifactId}::uuid
           FOR UPDATE
        `;
        if (!row) return { status: 'not_found' as const };
        if (row.state === 'cancelled') {
          return row.cancellationId === input.cancellationId
            && row.cancellationReasonCode === input.reason
            ? { status: 'cancelled' as const, idempotent: true }
            : { status: 'conflict' as const };
        }
        if (row.state !== 'rendering' && row.state !== 'ready') {
          return { status: 'terminal' as const };
        }
        const [updated] = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE realtime_speech_artifacts
             SET state = 'cancelled',
                 "renderLeaseExpiresAt" = NULL,
                 "cancellationId" = ${input.cancellationId}::uuid,
                 "cancellationReasonCode" = ${input.reason},
                 "cancelledAt" = clock_timestamp(),
                 "updatedAt" = clock_timestamp(),
                 version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
             AND "turnId" = ${input.turnId}::uuid
             AND id = ${input.artifactId}::uuid
             AND state IN ('rendering', 'ready')
             AND version = ${row.version}
          RETURNING id
        `;
        return updated
          ? { status: 'cancelled' as const, idempotent: false }
          : { status: 'terminal' as const };
      });
    } catch (error) {
      const code = postgresErrorCode(error);
      return code === 'P2002' || code === '23505'
        ? { status: 'conflict' }
        : { status: 'unavailable' };
    }
  }

  private async lockMutationRow(
    tx: Prisma.TransactionClient,
    input: RealtimeSpeechReadyFenceInput,
  ): Promise<LockedMutationRow | undefined> {
    const [row] = await tx.$queryRaw<LockedMutationRow[]>`
      SELECT state,
             "contextRevision" AS "contextRevision",
             "contextDigest" AS "contextDigest",
             "sidebandOwnerEpoch" AS "sidebandOwnerEpoch",
             "sidebandOwnerTokenHash" AS "sidebandOwnerTokenHash",
             "storageKey" AS "storageKey", "storageExpiresAt" AS "storageExpiresAt",
             "objectPurgedAt" AS "objectPurgedAt", "evidenceHmac" AS "evidenceHmac",
             "audioSha256" AS "audioSha256", "deliveryId" AS "deliveryId",
             "cancellationId" AS "cancellationId",
             "cancellationReasonCode" AS "cancellationReasonCode", version
        FROM realtime_speech_artifacts
       WHERE "companyId" = ${input.companyId}
         AND "subjectHash" = ${input.subjectHash}
         AND "sessionId" = ${input.sessionId}::uuid
         AND "turnId" = ${input.turnId}::uuid
         AND id = ${input.artifactId}::uuid
       FOR UPDATE
    `;
    return row;
  }

  private async lockMistralDeliveryTicket(
    tx: Prisma.TransactionClient,
    input: Pick<
    RealtimeSpeechReadyFenceInput,
      'companyId' | 'subjectHash' | 'sessionId' | 'turnId'
    >,
  ): Promise<MistralDeliveryTicketRow | null> {
    const [row] = await tx.$queryRaw<MistralDeliveryTicketRow[]>`
      SELECT state, "subjectHash", "providerSessionId", "providerTermination",
             "contextRevision", "contextDigest"
        FROM realtime_mistral_ingress_tickets
       WHERE "companyId" = ${input.companyId}
         AND "subjectHash" = ${input.subjectHash}
         AND "sessionId" = ${input.sessionId}::uuid
         AND id = ${input.turnId}::uuid
       FOR UPDATE
    `;
    return row ?? null;
  }

  private async releaseCompletedMistralLease(
    tx: Prisma.TransactionClient,
    input: RealtimeSpeechReadyFenceInput,
    artifact: Pick<
    LockedMutationRow,
      'contextRevision' | 'contextDigest' | 'sidebandOwnerEpoch' | 'sidebandOwnerTokenHash'
    >,
    ticket: MistralDeliveryTicketRow | null,
  ): Promise<boolean> {
    if (
      ticket?.state !== 'completed'
      || ticket.providerTermination !== 'confirmed'
      || ticket.providerSessionId === null
      || trim(ticket.subjectHash) !== input.subjectHash
      || ticket.contextRevision !== artifact.contextRevision
      || trim(ticket.contextDigest) !== trim(artifact.contextDigest)
    ) return false;
    const deleted = await tx.$executeRaw`
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
              AND pending.id <> ${input.artifactId}::uuid
              AND pending.state IN ('rendering', 'ready')
         )
         AND NOT EXISTS (
           SELECT 1
             FROM realtime_control_grants AS control_grant
            WHERE control_grant."companyId" = lease."companyId"
              AND control_grant."sessionId" = lease."sessionId"
              AND control_grant."turnId" = ${input.turnId}::uuid
              AND control_grant."artifactId" = ${input.artifactId}::uuid
              AND control_grant."expiresAt" > clock_timestamp()
              AND NOT EXISTS (
                SELECT 1
                  FROM realtime_control_consumptions AS consumption
                 WHERE consumption."companyId" = control_grant."companyId"
                   AND consumption."grantId" = control_grant.id
              )
         )
    `;
    return deleted === 1;
  }

  private async hasCurrentFence(
    tx: Prisma.TransactionClient,
    input: Pick<RealtimeSpeechReadyFenceInput, 'companyId' | 'subjectHash' | 'sessionId'>,
    artifact: Pick<
      LockedMutationRow,
      'contextRevision' | 'contextDigest' | 'sidebandOwnerEpoch' | 'sidebandOwnerTokenHash'
        | 'storageExpiresAt' | 'objectPurgedAt'
    >,
  ): Promise<boolean> {
    if (!(artifact.storageExpiresAt instanceof Date) || artifact.objectPurgedAt !== null) return false;
    const [row] = await tx.$queryRaw<BooleanRow[]>`
      SELECT EXISTS (
        SELECT 1 FROM realtime_session_leases AS lease
         WHERE lease."companyId" = ${input.companyId}
           AND lease."subjectHash" = ${input.subjectHash}
           AND lease."sessionId" = ${input.sessionId}::uuid
           AND lease.state = 'active'
           AND lease."leaseExpiresAt" > clock_timestamp()
           AND lease."hardExpiresAt" > clock_timestamp()
           AND lease."contextRevision" = ${artifact.contextRevision}
           AND lease."contextDigest" = ${trim(artifact.contextDigest)}
           AND lease."contextAppliedRevision" = ${artifact.contextRevision}
           AND lease."contextAppliedDigest" = ${trim(artifact.contextDigest)}
           AND lease."contextAppliedOwnerEpoch" = ${artifact.sidebandOwnerEpoch}
           AND lease."sidebandOwnerEpoch" = ${artifact.sidebandOwnerEpoch}
           AND lease."sidebandOwnerTokenHash" = ${trim(artifact.sidebandOwnerTokenHash)}
           AND lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
           AND lease."sidebandProtocolVersion" = 2
           AND ${artifact.storageExpiresAt} > clock_timestamp()
      ) AS ok
    `;
    return row?.ok === true;
  }

  /**
   * Ne publie une référence de contrôle que pour le grant durable exact de l'artefact acquitté.
   * Cette projection est volontairement plus stricte que le simple fence de session : elle lie
   * tenant, sujet, tour, artefact, ACK, contexte et owner, puis exclut tout grant expiré ou déjà
   * consommé. L'autorité de consommation revalide ensuite les mêmes invariants sous locks.
   */
  private async hasLiveExactUnconsumedControlGrant(
    tx: Prisma.TransactionClient,
    input: RealtimeSpeechDeliveryMutationInput,
    artifact: Pick<
    LockedMutationRow,
      'contextRevision' | 'contextDigest' | 'sidebandOwnerEpoch' | 'sidebandOwnerTokenHash'
    >,
  ): Promise<boolean> {
    const [row] = await tx.$queryRaw<BooleanRow[]>`
      SELECT EXISTS (
        SELECT 1
          FROM realtime_control_grants AS control_grant
          JOIN realtime_speech_artifacts AS exact_artifact
            ON exact_artifact.id = control_grant."artifactId"
           AND exact_artifact."companyId" = control_grant."companyId"
           AND exact_artifact."sessionId" = control_grant."sessionId"
           AND exact_artifact."turnId" = control_grant."turnId"
          JOIN realtime_session_leases AS lease
            ON lease."companyId" = exact_artifact."companyId"
           AND lease."subjectHash" = exact_artifact."subjectHash"
           AND lease."sessionId" = exact_artifact."sessionId"
         WHERE control_grant."companyId" = ${input.companyId}
           AND exact_artifact."subjectHash" = ${input.subjectHash}
           AND control_grant."sessionId" = ${input.sessionId}::uuid
           AND control_grant."turnId" = ${input.turnId}::uuid
           AND control_grant."artifactId" = ${input.artifactId}::uuid
           AND control_grant."contextRevision" = ${artifact.contextRevision}
           AND control_grant."contextDigest" = ${trim(artifact.contextDigest)}
           AND control_grant."expiresAt" > clock_timestamp()
           AND exact_artifact.state = 'delivered'
           AND exact_artifact."deliveryId" = ${input.deliveryId}::uuid
           AND exact_artifact."contextRevision" = ${artifact.contextRevision}
           AND exact_artifact."contextDigest" = ${trim(artifact.contextDigest)}
           AND exact_artifact."sidebandOwnerEpoch" = ${artifact.sidebandOwnerEpoch}
           AND exact_artifact."sidebandOwnerTokenHash" = ${trim(artifact.sidebandOwnerTokenHash)}
           AND lease.state = 'active'
           AND lease."leaseExpiresAt" > clock_timestamp()
           AND lease."hardExpiresAt" > clock_timestamp()
           AND lease."contextRevision" = exact_artifact."contextRevision"
           AND lease."contextDigest" = exact_artifact."contextDigest"
           AND lease."contextAppliedRevision" = exact_artifact."contextRevision"
           AND lease."contextAppliedDigest" = exact_artifact."contextDigest"
           AND lease."contextAppliedOwnerEpoch" = exact_artifact."sidebandOwnerEpoch"
           AND lease."sidebandOwnerEpoch" = exact_artifact."sidebandOwnerEpoch"
           AND lease."sidebandOwnerTokenHash" = exact_artifact."sidebandOwnerTokenHash"
           AND lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
           AND lease."sidebandProtocolVersion" = 2
           AND NOT EXISTS (
             SELECT 1
               FROM realtime_control_consumptions AS consumption
              WHERE consumption."companyId" = control_grant."companyId"
                AND consumption."grantId" = control_grant.id
                AND consumption."sessionId" = control_grant."sessionId"
                AND consumption."turnId" = control_grant."turnId"
           )
      ) AS ok
    `;
    return row?.ok === true;
  }
}
