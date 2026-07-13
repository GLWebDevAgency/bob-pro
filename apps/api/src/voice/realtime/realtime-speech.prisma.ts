import { Prisma } from '@prisma/client';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type {
  RealtimeSpeechArtifactClaim,
  RealtimeSpeechArtifactClaimInput,
  RealtimeSpeechArtifactFinalizeResult,
  RealtimeSpeechArtifactReadyInput,
  RealtimeSpeechArtifactRepositoryPort,
  RealtimeSpeechCancellationReason,
} from './realtime-speech-publisher';
import { buildRealtimeSpeechStorageKey } from './realtime-speech-storage';

const SHA256_HEX = /^[a-f0-9]{64}$/u;
// PostgreSQL rend uuid::text en minuscules et la clé objet durable reprend cette forme exacte.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SAFE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const FAILURE_REASON = /^[a-z][a-z0-9_]{0,63}$/u;
const POSTGRES_INT_MAX = 2_147_483_647;
const MAX_SEGMENT_INDEX = 127;
const RENDER_LEASE_SECONDS = 60;
const READY_STORAGE_SECONDS = 15 * 60;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;

const CANCELLATION_REASONS = new Set<RealtimeSpeechCancellationReason>([
  'barge_in',
  'user_cancel',
  'context_changed',
  'session_end',
  'superseded',
  'playback_error',
]);

interface ClockRow {
  now: Date;
}

interface ArtifactIdentityRow {
  id: string;
  companyId: string;
  subjectHash: string;
  sessionId: string;
  turnId: string;
  sequence: number;
  segmentIndex: number;
  renderTokenHash: string;
  state: string;
  classification: string;
  source: string | null;
  contextRevision: number;
  contextDigest: string;
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
  renderLeaseExpiresAt: Date | null;
  cancellationId: string | null;
  cancellationReasonCode: string | null;
  failureReasonCode: string | null;
  retentionExpiresAt: Date;
  version: number;
}

interface ClaimedArtifactRow {
  id: string;
  sequence: number;
}

interface FenceRow {
  ok: number;
}

function trimmed(value: string | null): string | null {
  return value === null ? null : value.trim();
}

function validPositivePostgresInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= POSTGRES_INT_MAX;
}

function validClaim(input: RealtimeSpeechArtifactClaimInput): boolean {
  return COMPANY_ID.test(input.companyId)
    && SHA256_HEX.test(input.subjectHash)
    && UUID.test(input.sessionId)
    && UUID.test(input.turnId)
    && UUID.test(input.candidateArtifactId)
    && Number.isSafeInteger(input.segmentIndex)
    && input.segmentIndex >= 0
    && input.segmentIndex <= MAX_SEGMENT_INDEX
    && validPositivePostgresInt(input.contextRevision)
    && SHA256_HEX.test(input.contextDigest)
    && (input.classification === 'fixed_safe' || input.classification === 'dynamic_sensitive')
    && SHA256_HEX.test(input.canonicalSpeechHmac)
    && SHA256_HEX.test(input.factsHmac)
    && SHA256_HEX.test(input.renderTokenHash);
}

function validReady(input: RealtimeSpeechArtifactReadyInput): boolean {
  if (!COMPANY_ID.test(input.companyId)
    || !SHA256_HEX.test(input.subjectHash)
    || !UUID.test(input.sessionId)
    || !UUID.test(input.turnId)
    || !UUID.test(input.artifactId)
    || !validPositivePostgresInt(input.sequence)
    || !SHA256_HEX.test(input.renderTokenHash)
    || !validPositivePostgresInt(input.contextRevision)
    || !SHA256_HEX.test(input.contextDigest)
    || (input.classification !== 'fixed_safe' && input.classification !== 'dynamic_sensitive')
    || !SHA256_HEX.test(input.canonicalSpeechHmac)
    || !SHA256_HEX.test(input.factsHmac)
    || !SHA256_HEX.test(input.evidenceHmac)
    || !SHA256_HEX.test(input.audioSha256)
    || !validPositivePostgresInt(input.proofKeyVersion)
    || !SAFE_OPAQUE_ID.test(input.synthesisAdapterId)
    || !SAFE_OPAQUE_ID.test(input.synthesisTrustDomain)
    || !Number.isSafeInteger(input.byteLength)
    || input.byteLength < 256
    || input.byteLength > 2_097_152
    || !Number.isSafeInteger(input.durationMs)
    || input.durationMs < 100
    || input.durationMs > 45_000
    // Le schéma durable v1 n'accepte volontairement que ces deux conteneurs auditables.
    || (input.mimeType !== 'audio/mpeg' && input.mimeType !== 'audio/wav')) {
    return false;
  }

  let expectedStorageKey: string;
  try {
    expectedStorageKey = buildRealtimeSpeechStorageKey({
      companyId: input.companyId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      artifactId: input.artifactId,
    });
  } catch {
    return false;
  }
  if (input.storageKey !== expectedStorageKey) return false;

  if (input.source === 'preapproved_static') {
    return input.classification === 'fixed_safe'
      && input.auditTranscriptHmac === null
      && input.auditAdapterId === null
      && input.auditTrustDomain === null;
  }
  return input.source === 'synthesized_audited'
    && input.auditTranscriptHmac !== null
    && SHA256_HEX.test(input.auditTranscriptHmac)
    && input.auditAdapterId !== null
    && SAFE_OPAQUE_ID.test(input.auditAdapterId)
    && input.auditTrustDomain !== null
    && SAFE_OPAQUE_ID.test(input.auditTrustDomain)
    && input.auditTrustDomain !== input.synthesisTrustDomain;
}

function bindingMatchesClaim(
  row: ArtifactIdentityRow,
  input: RealtimeSpeechArtifactClaimInput,
): boolean {
  return trimmed(row.subjectHash) === input.subjectHash
    && row.sessionId === input.sessionId
    && row.turnId === input.turnId
    && row.segmentIndex === input.segmentIndex
    && row.contextRevision === input.contextRevision
    && trimmed(row.contextDigest) === input.contextDigest
    && row.classification === input.classification
    && trimmed(row.canonicalSpeechHmac) === input.canonicalSpeechHmac
    && trimmed(row.factsHmac) === input.factsHmac;
}

function bindingMatchesReady(
  row: ArtifactIdentityRow,
  input: RealtimeSpeechArtifactReadyInput,
): boolean {
  return row.id === input.artifactId
    && trimmed(row.subjectHash) === input.subjectHash
    && row.sessionId === input.sessionId
    && row.turnId === input.turnId
    && row.sequence === input.sequence
    && row.contextRevision === input.contextRevision
    && trimmed(row.contextDigest) === input.contextDigest
    && row.classification === input.classification
    && trimmed(row.canonicalSpeechHmac) === input.canonicalSpeechHmac
    && trimmed(row.factsHmac) === input.factsHmac;
}

function readyProofMatches(
  row: ArtifactIdentityRow,
  input: RealtimeSpeechArtifactReadyInput,
): boolean {
  return bindingMatchesReady(row, input)
    && trimmed(row.renderTokenHash) === input.renderTokenHash
    && row.source === input.source
    && row.storageKey === input.storageKey
    && row.mimeType === input.mimeType
    && row.byteLength === input.byteLength
    && row.durationMs === input.durationMs
    && trimmed(row.auditTranscriptHmac) === input.auditTranscriptHmac
    && trimmed(row.evidenceHmac) === input.evidenceHmac
    && trimmed(row.audioSha256) === input.audioSha256
    && row.proofKeyVersion === input.proofKeyVersion
    && row.synthesisAdapterId === input.synthesisAdapterId
    && row.synthesisTrustDomain === input.synthesisTrustDomain
    && row.auditAdapterId === input.auditAdapterId
    && row.auditTrustDomain === input.auditTrustDomain;
}

function validFailureInput(input: Parameters<RealtimeSpeechArtifactRepositoryPort['failRender']>[0]): boolean {
  return COMPANY_ID.test(input.companyId)
    && UUID.test(input.sessionId)
    && UUID.test(input.turnId)
    && UUID.test(input.artifactId)
    && SHA256_HEX.test(input.renderTokenHash)
    && FAILURE_REASON.test(input.reasonCode);
}

function validCancellationInput(input: Parameters<RealtimeSpeechArtifactRepositoryPort['cancel']>[0]): boolean {
  return COMPANY_ID.test(input.companyId)
    && UUID.test(input.sessionId)
    && UUID.test(input.turnId)
    && UUID.test(input.artifactId)
    && UUID.test(input.cancellationId)
    && CANCELLATION_REASONS.has(input.reason);
}

/**
 * Adaptateur PostgreSQL du port acoustique durable. Toutes les transactions sont tenant-scoped,
 * courtes et sans appel réseau. Les triggers SQL restent l'autorité finale des transitions : les
 * vérifications applicatives servent à classer proprement les retries et à éviter les écritures
 * que la base rejetterait.
 */
export class PrismaRealtimeSpeechArtifactRepository implements RealtimeSpeechArtifactRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async claimRender(input: RealtimeSpeechArtifactClaimInput): Promise<RealtimeSpeechArtifactClaim> {
    if (!validClaim(input)) return { status: 'unavailable' };

    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        // Le verrou logique évite qu'un retry concurrent exécute le BEFORE INSERT et consomme une
        // séquence avant que l'unicité (session, tour, segment) ne le transforme en no-op.
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`bob-live:speech:${input.companyId}:${input.sessionId}:${input.turnId}:${input.segmentIndex}`}, 0)
          )
        `;
        const [clock] = await tx.$queryRaw<ClockRow[]>`
          SELECT clock_timestamp() AS now
        `;
        const now = clock?.now;
        if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { status: 'unavailable' as const };

        let existing = await this.lockSegment(tx, input);
        if (existing) return this.resolveClaim(input, existing, now);

        // Le BEFORE INSERT alloue la séquence en mettant à jour ce même bail. Un verrou exclusif
        // évite le TOCTOU assert -> allocation et sérialise les claims de segments différents sans
        // le deadlock qu'engendrerait une promotion simultanée de plusieurs FOR SHARE.
        if (!(await this.hasExactContextFenceForSequence(tx, input))) {
          return { status: 'terminal' as const };
        }

        const [inserted] = await tx.$queryRaw<ClaimedArtifactRow[]>`
          INSERT INTO realtime_speech_artifacts (
            id, "companyId", "subjectHash", "sessionId", "turnId", "segmentIndex",
            "renderTokenHash", state, classification, "contextRevision", "contextDigest",
            "canonicalSpeechHmac", "factsHmac", "renderLeaseExpiresAt",
            "createdAt", "updatedAt", "retentionExpiresAt", version
          ) VALUES (
            ${input.candidateArtifactId}::uuid,
            ${input.companyId},
            ${input.subjectHash},
            ${input.sessionId}::uuid,
            ${input.turnId}::uuid,
            ${input.segmentIndex},
            ${input.renderTokenHash},
            'rendering',
            ${input.classification},
            ${input.contextRevision},
            ${input.contextDigest},
            ${input.canonicalSpeechHmac},
            ${input.factsHmac},
            ${now} + make_interval(secs => ${RENDER_LEASE_SECONDS}),
            ${now},
            ${now},
            ${now} + make_interval(secs => ${RETENTION_SECONDS}),
            1
          )
          ON CONFLICT ("companyId", "sessionId", "turnId", "segmentIndex") DO NOTHING
          RETURNING id, sequence
        `;
        if (inserted) {
          return { status: 'claimed', artifactId: inserted.id, sequence: inserted.sequence };
        }

        // Défense contre un writer plus ancien qui n'aurait pas encore adopté le verrou logique.
        existing = await this.lockSegment(tx, input);
        return existing
          ? this.resolveClaim(input, existing, now)
          : { status: 'unavailable' as const };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async finalizeReady(
    input: RealtimeSpeechArtifactReadyInput,
  ): Promise<RealtimeSpeechArtifactFinalizeResult> {
    if (!validReady(input)) return { status: 'lost_claim' };

    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<ArtifactIdentityRow[]>`
          SELECT ${this.artifactColumns()}
            FROM realtime_speech_artifacts
           WHERE "companyId" = ${input.companyId}
             AND id = ${input.artifactId}::uuid
             AND "sessionId" = ${input.sessionId}::uuid
             AND "turnId" = ${input.turnId}::uuid
           FOR UPDATE
        `;
        if (!row || !bindingMatchesReady(row, input)) return { status: 'lost_claim' as const };
        if (row.state === 'cancelled') return { status: 'cancelled' as const };
        if (row.state !== 'ready' && row.state !== 'rendering') {
          return { status: 'lost_claim' as const };
        }
        if (row.state === 'rendering'
          && trimmed(row.renderTokenHash) !== input.renderTokenHash) {
          return { status: 'lost_claim' as const };
        }

        const [clock] = await tx.$queryRaw<ClockRow[]>`
          SELECT clock_timestamp() AS now
        `;
        const now = clock?.now;
        if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { status: 'unavailable' as const };
        if (row.state === 'ready') {
          return readyProofMatches(row, input)
            && row.storageExpiresAt instanceof Date
            && row.storageExpiresAt.getTime() > now.getTime()
            ? { status: 'ready' as const }
            : { status: 'lost_claim' as const };
        }
        if (row.retentionExpiresAt.getTime() <= now.getTime()) return { status: 'lost_claim' as const };
        if (!(await this.hasExactContextFence(tx, {
          companyId: input.companyId,
          subjectHash: input.subjectHash,
          sessionId: input.sessionId,
          contextRevision: input.contextRevision,
          contextDigest: input.contextDigest,
        }))) {
          return { status: 'stale_context' as const };
        }

        const [updated] = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE realtime_speech_artifacts
             SET state = 'ready',
                 source = ${input.source},
                 "storageKey" = ${input.storageKey},
                 "storageExpiresAt" = ${now} + make_interval(secs => ${READY_STORAGE_SECONDS}),
                 "mimeType" = ${input.mimeType},
                 "byteLength" = ${input.byteLength},
                 "durationMs" = ${input.durationMs},
                 "auditTranscriptHmac" = ${input.auditTranscriptHmac},
                 "evidenceHmac" = ${input.evidenceHmac},
                 "audioSha256" = ${input.audioSha256},
                 "proofKeyVersion" = ${input.proofKeyVersion},
                 "synthesisAdapterId" = ${input.synthesisAdapterId},
                 "synthesisTrustDomain" = ${input.synthesisTrustDomain},
                 "auditAdapterId" = ${input.auditAdapterId},
                 "auditTrustDomain" = ${input.auditTrustDomain},
                 "renderLeaseExpiresAt" = NULL,
                 "readyAt" = ${now},
                 "updatedAt" = ${now},
                 version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND id = ${input.artifactId}::uuid
             AND "sessionId" = ${input.sessionId}::uuid
             AND "turnId" = ${input.turnId}::uuid
             AND state = 'rendering'
             AND "renderTokenHash" = ${input.renderTokenHash}
             AND version = ${row.version}
          RETURNING id
        `;
        return updated ? { status: 'ready' as const } : { status: 'lost_claim' as const };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async failRender(
    input: Parameters<RealtimeSpeechArtifactRepositoryPort['failRender']>[0],
  ): Promise<void> {
    if (!validFailureInput(input)) return;
    await this.prisma.withTenant(input.companyId, async (tx) => {
      await tx.$queryRaw`
        UPDATE realtime_speech_artifacts
           SET state = 'failed',
               "renderLeaseExpiresAt" = NULL,
               "failureReasonCode" = ${input.reasonCode},
               "failedAt" = clock_timestamp(),
               "updatedAt" = clock_timestamp(),
               version = version + 1
         WHERE "companyId" = ${input.companyId}
           AND id = ${input.artifactId}::uuid
           AND "sessionId" = ${input.sessionId}::uuid
           AND "turnId" = ${input.turnId}::uuid
           AND state = 'rendering'
           AND "renderTokenHash" = ${input.renderTokenHash}
        RETURNING id
      `;
    });
  }

  async cancel(
    input: Parameters<RealtimeSpeechArtifactRepositoryPort['cancel']>[0],
  ): Promise<void> {
    if (!validCancellationInput(input)) return;
    await this.prisma.withTenant(input.companyId, async (tx) => {
      // Première annulation valide gagnante. Un retry exact devient un no-op ; un autre id ne peut
      // ni réécrire la cause ni déplacer les preuves d'un état terminal.
      await tx.$queryRaw`
        UPDATE realtime_speech_artifacts
           SET state = 'cancelled',
               "renderLeaseExpiresAt" = NULL,
               "cancellationId" = ${input.cancellationId}::uuid,
               "cancellationReasonCode" = ${input.reason},
               "cancelledAt" = clock_timestamp(),
               "updatedAt" = clock_timestamp(),
               version = version + 1
         WHERE "companyId" = ${input.companyId}
           AND id = ${input.artifactId}::uuid
           AND "sessionId" = ${input.sessionId}::uuid
           AND "turnId" = ${input.turnId}::uuid
           AND state IN ('rendering', 'ready')
        RETURNING id
      `;
    });
  }

  private async lockSegment(
    tx: Prisma.TransactionClient,
    input: RealtimeSpeechArtifactClaimInput,
  ): Promise<ArtifactIdentityRow | undefined> {
    const [row] = await tx.$queryRaw<ArtifactIdentityRow[]>`
      SELECT ${this.artifactColumns()}
        FROM realtime_speech_artifacts
       WHERE "companyId" = ${input.companyId}
         AND "sessionId" = ${input.sessionId}::uuid
         AND "turnId" = ${input.turnId}::uuid
         AND "segmentIndex" = ${input.segmentIndex}
       FOR UPDATE
    `;
    return row;
  }

  private resolveClaim(
    input: RealtimeSpeechArtifactClaimInput,
    row: ArtifactIdentityRow,
    now: Date,
  ): RealtimeSpeechArtifactClaim {
    if (!bindingMatchesClaim(row, input)) return { status: 'terminal' };
    if (row.state === 'ready') {
      return row.storageExpiresAt instanceof Date
        && row.storageExpiresAt.getTime() > now.getTime()
        ? { status: 'ready', artifactId: row.id, sequence: row.sequence }
        : { status: 'terminal' };
    }
    if (row.state !== 'rendering' || row.renderLeaseExpiresAt === null) {
      return { status: 'terminal' };
    }
    if (row.retentionExpiresAt.getTime() <= now.getTime()) return { status: 'terminal' };

    const leaseIsLive = row.renderLeaseExpiresAt.getTime() > now.getTime();
    if (!leaseIsLive) return { status: 'terminal' };
    return trimmed(row.renderTokenHash) === input.renderTokenHash
      ? { status: 'claimed', artifactId: row.id, sequence: row.sequence }
      : { status: 'busy' };
  }

  private async hasExactContextFence(
    tx: Prisma.TransactionClient,
    input: {
      companyId: string;
      subjectHash: string;
      sessionId: string;
      contextRevision: number;
      contextDigest: string;
    },
  ): Promise<boolean> {
    const [fence] = await tx.$queryRaw<FenceRow[]>`
      SELECT 1 AS ok
        FROM realtime_session_leases
       WHERE "companyId" = ${input.companyId}
         AND "subjectHash" = ${input.subjectHash}
         AND "sessionId" = ${input.sessionId}::uuid
         AND state = 'active'
         AND "leaseExpiresAt" > clock_timestamp()
         AND "hardExpiresAt" > clock_timestamp()
         AND "contextRevision" = ${input.contextRevision}
         AND "contextDigest" = ${input.contextDigest}
         AND "contextAppliedRevision" = ${input.contextRevision}
         AND "contextAppliedDigest" = ${input.contextDigest}
         AND "sidebandOwnerTokenHash" IS NOT NULL
         AND "sidebandOwnerLeaseExpiresAt" > clock_timestamp()
         AND "sidebandProtocolVersion" = 2
       FOR SHARE
    `;
    return fence?.ok === 1;
  }

  private async hasExactContextFenceForSequence(
    tx: Prisma.TransactionClient,
    input: {
      companyId: string;
      subjectHash: string;
      sessionId: string;
      contextRevision: number;
      contextDigest: string;
    },
  ): Promise<boolean> {
    const [fence] = await tx.$queryRaw<FenceRow[]>`
      SELECT 1 AS ok
        FROM realtime_session_leases
       WHERE "companyId" = ${input.companyId}
         AND "subjectHash" = ${input.subjectHash}
         AND "sessionId" = ${input.sessionId}::uuid
         AND state = 'active'
         AND "leaseExpiresAt" > clock_timestamp()
         AND "hardExpiresAt" > clock_timestamp()
         AND "contextRevision" = ${input.contextRevision}
         AND "contextDigest" = ${input.contextDigest}
         AND "contextAppliedRevision" = ${input.contextRevision}
         AND "contextAppliedDigest" = ${input.contextDigest}
         AND "sidebandOwnerTokenHash" IS NOT NULL
         AND "sidebandOwnerLeaseExpiresAt" > clock_timestamp()
         AND "sidebandProtocolVersion" = 2
       FOR UPDATE
    `;
    return fence?.ok === 1;
  }

  private artifactColumns(): Prisma.Sql {
    // Liste explicite : ni contextPayload, ni texte, ni audio ne peuvent fuir par cet adaptateur.
    return Prisma.sql`
      id, "companyId", "subjectHash", "sessionId", "turnId", sequence, "segmentIndex",
      "renderTokenHash", state, classification, source, "contextRevision", "contextDigest",
      "storageKey", "storageExpiresAt", "mimeType", "byteLength", "durationMs",
      "canonicalSpeechHmac", "auditTranscriptHmac", "factsHmac", "evidenceHmac",
      "audioSha256", "proofKeyVersion", "synthesisAdapterId", "synthesisTrustDomain",
      "auditAdapterId", "auditTrustDomain", "renderLeaseExpiresAt", "cancellationId",
      "cancellationReasonCode", "failureReasonCode", "retentionExpiresAt", version
    `;
  }
}
