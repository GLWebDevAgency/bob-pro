import { randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  hashRealtimeLeaseToken,
  isRealtimeCompanyId,
  isRealtimeLeaseCredential,
  isRealtimeProviderCallId,
  isRealtimeProviderId,
  isRealtimeSessionId,
  isRealtimeSubjectHash,
  prepareRealtimeContext,
  validateRealtimeAdmissionPolicy,
  type RealtimeAdmissionDenial,
  type RealtimeAdmissionMutationResult,
  type RealtimeAdmissionPolicy,
  type RealtimeAdmissionPort,
  type RealtimeAdmissionReserveInput,
  type RealtimeAdmissionResult,
  type RealtimeContextIdentity,
  type RealtimeContextReadResult,
  type RealtimeContextUpdateInput,
  type RealtimeContextUpdateResult,
  type RealtimeLeaseCredential,
  type RealtimeProviderId,
  type RealtimeReapingBatchResult,
  type RealtimeReapingClaim,
  type RealtimeReleaseInput,
  type RealtimeTerminationClaimResult,
} from './realtime-admission';

interface ClockRow {
  now: Date;
}

interface LeaseRow {
  companyId: string;
  subjectHash: string;
  sessionId: string;
  state: string;
  providerId: RealtimeProviderId | null;
  providerCallId: string | null;
  leaseExpiresAt: Date;
  hardExpiresAt: Date;
  version: number;
}

interface QuotaRow {
  userMinute: number;
  userHour: number;
  tenantMinute: number;
  tenantHour: number;
  userMinuteOldest: Date | null;
  userHourOldest: Date | null;
  tenantMinuteOldest: Date | null;
  tenantHourOldest: Date | null;
}

interface UpdatedLeaseRow {
  leaseExpiresAt: Date;
}

interface ReapingRow extends LeaseRow {
  reaperLeaseExpiresAt?: Date;
  databaseNow: Date;
}

interface ContextLeaseRow {
  state: string;
  leaseExpiresAt: Date;
  hardExpiresAt: Date;
  contextSchemaVersion: number | null;
  contextRevision: number | null;
  contextPayload: unknown | null;
  contextDigest: string | null;
  contextUpdatedAt: Date | null;
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

function mutationUnavailable(): RealtimeAdmissionMutationResult {
  return { ok: false, reason: 'unavailable' };
}

function mutationRejected(): RealtimeAdmissionMutationResult {
  return { ok: false, reason: 'rejected' };
}

function mutationExpired(): RealtimeAdmissionMutationResult {
  return { ok: false, reason: 'expired' };
}

function deniedUnavailable(): RealtimeAdmissionResult {
  return { allowed: false, denial: 'unavailable', retryAt: null };
}

function validReserve(input: RealtimeAdmissionReserveInput): boolean {
  return isRealtimeCompanyId(input.companyId)
    && isRealtimeSubjectHash(input.subjectHash)
    && (input.sessionId === undefined || isRealtimeSessionId(input.sessionId))
    && Number.isInteger(input.maxSessionSeconds)
    && input.maxSessionSeconds >= 1
    && input.maxSessionSeconds <= 900;
}

/**
 * Admission distribuée Bob Live. Chaque réserve ouvre une transaction tenant très courte ; aucun
 * appel réseau provider n'est exécuté sous verrou. L'advisory lock tenant sérialise les compteurs
 * agrégés entre sujets et le lock sujet protège le bail composite entre toutes les répliques.
 */
export class PrismaRealtimeAdmission implements RealtimeAdmissionPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: RealtimeAdmissionPolicy,
  ) {
    validateRealtimeAdmissionPolicy(policy);
  }

  acquire(_input: { userId: string; companyId: string }): RealtimeAdmissionResult {
    return deniedUnavailable();
  }

  async reserve(input: RealtimeAdmissionReserveInput): Promise<RealtimeAdmissionResult> {
    if (!validReserve(input)) return deniedUnavailable();
    const sessionId = input.sessionId ?? randomUUID();
    const leaseToken = token();
    const leaseTokenHash = hashRealtimeLeaseToken(leaseToken);

    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        await this.lockAdmission(tx, input.companyId, input.subjectHash);
        const [{ now }] = await tx.$queryRaw<ClockRow[]>`SELECT clock_timestamp() AS now`;
        if (!now) return deniedUnavailable();

        const [existing] = await tx.$queryRaw<LeaseRow[]>`
          SELECT "companyId", "subjectHash", "sessionId", state, "providerId", "providerCallId",
                 "leaseExpiresAt", "hardExpiresAt", version
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
           FOR UPDATE
        `;
        if (existing) {
          if (existing.state === 'reaping' && existing.leaseExpiresAt.getTime() > now.getTime()) {
            return {
              allowed: false,
              denial: 'session_reaping',
              retryAt: existing.leaseExpiresAt.toISOString(),
            };
          }
          const stale = existing.leaseExpiresAt.getTime() <= now.getTime()
            || existing.hardExpiresAt.getTime() <= now.getTime();
          if (!stale) {
            return {
              allowed: false,
              denial: 'active_lease',
              retryAt: existing.leaseExpiresAt.toISOString(),
            };
          }
          if (existing.providerId === null && existing.providerCallId === null) {
            await tx.$executeRaw`
              DELETE FROM realtime_session_leases
               WHERE "companyId" = ${existing.companyId}
                 AND "subjectHash" = ${existing.subjectHash}
                 AND "sessionId" = ${existing.sessionId}::uuid
                 AND version = ${existing.version}
                 AND "providerId" IS NULL
                 AND "providerCallId" IS NULL
            `;
          } else {
            if (existing.providerId === null || existing.providerCallId === null) {
              return deniedUnavailable();
            }
            if (await this.hasConfirmedMistralTermination(tx, existing)) {
              const deleted = await tx.$executeRaw`
                DELETE FROM realtime_session_leases
                 WHERE "companyId" = ${existing.companyId}
                   AND "subjectHash" = ${existing.subjectHash}
                   AND "sessionId" = ${existing.sessionId}::uuid
                   AND version = ${existing.version}
                   AND "providerId" = 'mistral'
                   AND "providerCallId" = ${existing.providerCallId}
                   AND ("leaseExpiresAt" <= ${now} OR "hardExpiresAt" <= ${now})
              `;
              if (deleted !== 1) return deniedUnavailable();
            } else {
              const claim = await this.claimRowForReaping(tx, existing);
              return {
                allowed: false,
                denial: 'session_reaping',
                retryAt: claim?.reaperLeaseExpiresAt ?? existing.leaseExpiresAt.toISOString(),
                ...(claim ? { reapingClaim: claim } : {}),
              };
            }
          }
        }

        // Rétention bornée et tenant-scoped. Une heure suffit au quota ; la marge d'une heure
        // facilite l'investigation immédiate sans laisser croître le journal indéfiniment.
        await tx.$executeRaw`
          DELETE FROM realtime_admission_events
           WHERE "companyId" = ${input.companyId}
             AND "admittedAt" <= ${now} - interval '2 hours'
        `;
        if (input.sessionId) {
          const [replay] = await tx.$queryRaw<Array<{ subjectHash: string }>>`
            SELECT "subjectHash"
              FROM realtime_admission_events
             WHERE "companyId" = ${input.companyId}
               AND "sessionId" = ${input.sessionId}::uuid
          `;
          if (replay) {
            return replay.subjectHash.trim() === input.subjectHash
              ? { allowed: false as const, denial: 'active_lease' as const, retryAt: null }
              : { allowed: false as const, denial: 'unavailable' as const, retryAt: null };
          }
        }

        const [quota] = await tx.$queryRaw<QuotaRow[]>`
          SELECT
            count(*) FILTER (
              WHERE "subjectHash" = ${input.subjectHash}
                AND "admittedAt" > ${now} - interval '1 minute'
            )::int AS "userMinute",
            count(*) FILTER (
              WHERE "subjectHash" = ${input.subjectHash}
                AND "admittedAt" > ${now} - interval '1 hour'
            )::int AS "userHour",
            count(*) FILTER (WHERE "admittedAt" > ${now} - interval '1 minute')::int AS "tenantMinute",
            count(*) FILTER (WHERE "admittedAt" > ${now} - interval '1 hour')::int AS "tenantHour",
            min("admittedAt") FILTER (
              WHERE "subjectHash" = ${input.subjectHash}
                AND "admittedAt" > ${now} - interval '1 minute'
            ) AS "userMinuteOldest",
            min("admittedAt") FILTER (
              WHERE "subjectHash" = ${input.subjectHash}
                AND "admittedAt" > ${now} - interval '1 hour'
            ) AS "userHourOldest",
            min("admittedAt") FILTER (WHERE "admittedAt" > ${now} - interval '1 minute') AS "tenantMinuteOldest",
            min("admittedAt") FILTER (WHERE "admittedAt" > ${now} - interval '1 hour') AS "tenantHourOldest"
          FROM realtime_admission_events
          WHERE "companyId" = ${input.companyId}
            AND "admittedAt" > ${now} - interval '1 hour'
        `;
        if (!quota) return deniedUnavailable();
        const quotaDenial = this.quotaDenial(quota);
        if (quotaDenial) return quotaDenial;

        const [inserted] = await tx.$queryRaw<Array<{ leaseExpiresAt: Date; hardExpiresAt: Date }>>`
          INSERT INTO realtime_session_leases (
            "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
            "providerId", "providerCallId", "reaperTokenHash", "reservedAt", "leaseExpiresAt",
            "hardExpiresAt", "activatedAt", "updatedAt", version
          ) VALUES (
            ${input.companyId}, ${input.subjectHash}, ${sessionId}::uuid, ${leaseTokenHash}, 'reserved',
            NULL, NULL, NULL, ${now},
            LEAST(${now} + make_interval(secs => ${this.policy.reservationTtlSeconds}),
                  ${now} + make_interval(secs => ${input.maxSessionSeconds})),
            ${now} + make_interval(secs => ${input.maxSessionSeconds}),
            NULL, ${now}, 1
          )
          RETURNING "leaseExpiresAt", "hardExpiresAt"
        `;
        if (!inserted) return deniedUnavailable();
        await tx.$executeRaw`
          INSERT INTO realtime_admission_events (
            id, "companyId", "subjectHash", "sessionId", "admittedAt"
          ) VALUES (
            ${randomUUID()}::uuid, ${input.companyId}, ${input.subjectHash}, ${sessionId}::uuid, ${now}
          )
        `;
        return {
          allowed: true,
          denial: null,
          lease: {
            companyId: input.companyId,
            subjectHash: input.subjectHash,
            sessionId,
            leaseToken,
            state: 'reserved',
            leaseExpiresAt: inserted.leaseExpiresAt.toISOString(),
            hardExpiresAt: inserted.hardExpiresAt.toISOString(),
          },
        };
      });
    } catch {
      return deniedUnavailable();
    }
  }

  async bindProvider(
    input: RealtimeLeaseCredential & { providerId: RealtimeProviderId; providerCallId: string },
  ): Promise<RealtimeAdmissionMutationResult> {
    if (
      !isRealtimeLeaseCredential(input)
      || !isRealtimeProviderId(input.providerId)
      || !isRealtimeProviderCallId(input.providerCallId)
    ) {
      return mutationRejected();
    }
    return this.mutate(input.companyId, async (tx) => {
      const rows = await tx.$queryRaw<UpdatedLeaseRow[]>`
        UPDATE realtime_session_leases
           SET state = 'bound', "providerId" = ${input.providerId},
               "providerCallId" = ${input.providerCallId},
               "updatedAt" = clock_timestamp(), version = version + 1
         WHERE "companyId" = ${input.companyId}
           AND "subjectHash" = ${input.subjectHash}
           AND "sessionId" = ${input.sessionId}::uuid
           AND "leaseTokenHash" = ${hashRealtimeLeaseToken(input.leaseToken)}
           AND state = 'reserved'
           AND "providerId" IS NULL
           AND "providerCallId" IS NULL
           AND "leaseExpiresAt" > clock_timestamp()
           AND "hardExpiresAt" > clock_timestamp()
           AND NOT EXISTS (
             SELECT 1
               FROM realtime_session_leases AS provider_identity
              WHERE provider_identity."providerId" = ${input.providerId}
                AND provider_identity."providerCallId" = ${input.providerCallId}
           )
        RETURNING "leaseExpiresAt"
      `;
      if (rows[0]) return { ok: true, reason: null, leaseExpiresAt: rows[0].leaseExpiresAt.toISOString() };
      const [replayed] = await tx.$queryRaw<UpdatedLeaseRow[]>`
        SELECT "leaseExpiresAt"
          FROM realtime_session_leases
         WHERE "companyId" = ${input.companyId}
           AND "subjectHash" = ${input.subjectHash}
           AND "sessionId" = ${input.sessionId}::uuid
           AND "leaseTokenHash" = ${hashRealtimeLeaseToken(input.leaseToken)}
           AND "providerId" = ${input.providerId}
           AND "providerCallId" = ${input.providerCallId}
           AND state IN ('bound', 'active')
           AND "leaseExpiresAt" > clock_timestamp()
           AND "hardExpiresAt" > clock_timestamp()
      `;
      return replayed
        ? { ok: true, reason: null, leaseExpiresAt: replayed.leaseExpiresAt.toISOString() }
        : this.classifyMutationMiss(tx, input);
    });
  }

  async activate(input: RealtimeLeaseCredential): Promise<RealtimeAdmissionMutationResult> {
    if (!isRealtimeLeaseCredential(input)) return mutationRejected();
    return this.mutate(input.companyId, async (tx) => {
      const rows = await tx.$queryRaw<UpdatedLeaseRow[]>`
        UPDATE realtime_session_leases
           SET state = 'active', "activatedAt" = clock_timestamp(),
               "leaseExpiresAt" = LEAST(
                 clock_timestamp() + make_interval(secs => ${this.policy.activeLeaseSeconds}),
                 "hardExpiresAt"
               ),
               "updatedAt" = clock_timestamp(), version = version + 1
         WHERE "companyId" = ${input.companyId}
           AND "subjectHash" = ${input.subjectHash}
           AND "sessionId" = ${input.sessionId}::uuid
           AND "leaseTokenHash" = ${hashRealtimeLeaseToken(input.leaseToken)}
           AND state = 'bound'
           AND "providerId" IS NOT NULL
           AND "providerCallId" IS NOT NULL
           AND "leaseExpiresAt" > clock_timestamp()
           AND "hardExpiresAt" > clock_timestamp()
        RETURNING "leaseExpiresAt"
      `;
      if (rows[0]) return { ok: true, reason: null, leaseExpiresAt: rows[0].leaseExpiresAt.toISOString() };
      const [replayed] = await tx.$queryRaw<UpdatedLeaseRow[]>`
        SELECT "leaseExpiresAt"
          FROM realtime_session_leases
         WHERE "companyId" = ${input.companyId}
           AND "subjectHash" = ${input.subjectHash}
           AND "sessionId" = ${input.sessionId}::uuid
           AND "leaseTokenHash" = ${hashRealtimeLeaseToken(input.leaseToken)}
           AND state = 'active'
           AND "providerId" IS NOT NULL
           AND "providerCallId" IS NOT NULL
           AND "leaseExpiresAt" > clock_timestamp()
           AND "hardExpiresAt" > clock_timestamp()
      `;
      return replayed
        ? { ok: true, reason: null, leaseExpiresAt: replayed.leaseExpiresAt.toISOString() }
        : this.classifyMutationMiss(tx, input);
    });
  }

  async renew(input: RealtimeLeaseCredential): Promise<RealtimeAdmissionMutationResult> {
    if (!isRealtimeLeaseCredential(input)) return mutationRejected();
    return this.mutate(input.companyId, async (tx) => {
      const rows = await tx.$queryRaw<UpdatedLeaseRow[]>`
        UPDATE realtime_session_leases
           SET "leaseExpiresAt" = LEAST(
                 clock_timestamp() + make_interval(secs => ${this.policy.activeLeaseSeconds}),
                 "hardExpiresAt"
               ),
               "updatedAt" = clock_timestamp(), version = version + 1
         WHERE "companyId" = ${input.companyId}
           AND "subjectHash" = ${input.subjectHash}
           AND "sessionId" = ${input.sessionId}::uuid
           AND "leaseTokenHash" = ${hashRealtimeLeaseToken(input.leaseToken)}
           AND state = 'active'
           AND "providerId" IS NOT NULL
           AND "providerCallId" IS NOT NULL
           AND "leaseExpiresAt" > clock_timestamp()
           AND "hardExpiresAt" > clock_timestamp()
        RETURNING "leaseExpiresAt"
      `;
      return rows[0]
        ? { ok: true, reason: null, leaseExpiresAt: rows[0].leaseExpiresAt.toISOString() }
        : this.classifyMutationMiss(tx, input);
    });
  }

  async release(input: RealtimeReleaseInput): Promise<RealtimeAdmissionMutationResult> {
    if (!isRealtimeLeaseCredential(input)) return mutationRejected();
    return this.mutate(input.companyId, async (tx) => {
      const allowProvider = input.providerTermination === 'confirmed';
      const deleted = await tx.$executeRaw`
        DELETE FROM realtime_session_leases
         WHERE "companyId" = ${input.companyId}
           AND "subjectHash" = ${input.subjectHash}
           AND "sessionId" = ${input.sessionId}::uuid
           AND "leaseTokenHash" = ${hashRealtimeLeaseToken(input.leaseToken)}
           AND (
             ${allowProvider}
             OR ("providerId" IS NULL AND "providerCallId" IS NULL AND state = 'reserved')
           )
      `;
      return deleted === 1 ? { ok: true, reason: null } : mutationRejected();
    });
  }

  async claimExpired(input: { companyId: string; limit?: number }): Promise<RealtimeReapingBatchResult> {
    if (!isRealtimeCompanyId(input.companyId)) return { ok: false, reason: 'unavailable' };
    const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        await this.lockTenant(tx, input.companyId);
        await tx.$executeRaw`
          DELETE FROM realtime_admission_events
           WHERE "companyId" = ${input.companyId}
             AND "admittedAt" <= clock_timestamp() - interval '2 hours'
        `;
        await tx.$executeRaw`
          DELETE FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "providerId" IS NULL
             AND "providerCallId" IS NULL
             AND ("leaseExpiresAt" <= clock_timestamp() OR "hardExpiresAt" <= clock_timestamp())
        `;
        // Une preuve terminale Mistral confirmée signifie que le socket fournisseur est déjà
        // fermé. Après la grâce de livraison, supprimer localement le drain est la seule action
        // correcte : le transformer en claim reaper provoquerait un second hangup sans nécessité.
        await tx.$executeRaw`
          DELETE FROM realtime_session_leases AS lease
          USING realtime_mistral_ingress_tickets AS ticket
           WHERE lease."companyId" = ${input.companyId}
             AND ticket."companyId" = lease."companyId"
             AND ticket."subjectHash" = lease."subjectHash"
             AND ticket."sessionId" = lease."sessionId"
             AND ticket.state IN ('completed', 'abandoned')
             AND ticket."providerTermination" = 'confirmed'
             AND ticket."providerSessionId" = lease."providerCallId"
             AND lease."providerId" = 'mistral'
             AND lease."providerCallId" IS NOT NULL
             AND (lease."leaseExpiresAt" <= clock_timestamp()
               OR lease."hardExpiresAt" <= clock_timestamp())
        `;
        const rows = await tx.$queryRaw<LeaseRow[]>`
          SELECT "companyId", "subjectHash", "sessionId", state, "providerId", "providerCallId",
                 "leaseExpiresAt", "hardExpiresAt", version
           FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "providerId" IS NOT NULL
             AND "providerCallId" IS NOT NULL
             AND (
               (state <> 'reaping' AND ("leaseExpiresAt" <= clock_timestamp() OR "hardExpiresAt" <= clock_timestamp()))
               OR (state = 'reaping' AND "leaseExpiresAt" <= clock_timestamp())
             )
           ORDER BY "leaseExpiresAt" ASC
           FOR UPDATE SKIP LOCKED
           LIMIT ${limit}
        `;
        const claims: RealtimeReapingClaim[] = [];
        for (const row of rows) {
          const claim = await this.claimRowForReaping(tx, row);
          if (claim) claims.push(claim);
        }
        return { ok: true as const, claims };
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async claimTermination(input: {
    companyId: string;
    subjectHash: string;
    sessionId: string;
  }): Promise<RealtimeTerminationClaimResult> {
    if (
      !isRealtimeCompanyId(input.companyId)
      || !isRealtimeSubjectHash(input.subjectHash)
      || !isRealtimeSessionId(input.sessionId)
    ) return { ok: false, reason: 'unavailable' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        await this.lockAdmission(tx, input.companyId, input.subjectHash);
        const [{ now }] = await tx.$queryRaw<ClockRow[]>`SELECT clock_timestamp() AS now`;
        if (!now) return { ok: false as const, reason: 'unavailable' as const };
        const [row] = await tx.$queryRaw<LeaseRow[]>`
          SELECT "companyId", "subjectHash", "sessionId", state, "providerId", "providerCallId",
                 "leaseExpiresAt", "hardExpiresAt", version
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
           FOR UPDATE
        `;
        if (!row) return { ok: true as const, claim: null, pending: false };
        if (row.providerId === null && row.providerCallId === null) {
          await tx.$executeRaw`
            DELETE FROM realtime_session_leases
             WHERE "companyId" = ${row.companyId}
               AND "subjectHash" = ${row.subjectHash}
               AND "sessionId" = ${row.sessionId}::uuid
               AND version = ${row.version}
               AND "providerId" IS NULL
               AND "providerCallId" IS NULL
          `;
          return { ok: true as const, claim: null, pending: false };
        }
        if (row.providerId === null || row.providerCallId === null) {
          return { ok: false as const, reason: 'unavailable' as const };
        }
        if (await this.hasConfirmedMistralTermination(tx, row)) {
          // `claimTermination` peut être appelé automatiquement après la fermeture WSS. Le
          // provider est déjà terminé, mais le lease doit rester disponible pour l'ACK audio.
          return { ok: true as const, claim: null, pending: false };
        }
        if (row.state === 'reaping' && row.leaseExpiresAt.getTime() > now.getTime()) {
          return { ok: true as const, claim: null, pending: true };
        }
        const claim = await this.claimRowForReaping(tx, row);
        return { ok: true as const, claim, pending: claim === null };
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async completeReaping(
    input: Omit<
    RealtimeReapingClaim,
      'providerId' | 'providerCallId' | 'reaperLeaseExpiresAt' | 'hardExpiryProof'
    >,
  ): Promise<RealtimeAdmissionMutationResult> {
    if (
      !isRealtimeCompanyId(input.companyId)
      || !isRealtimeSubjectHash(input.subjectHash)
      || !isRealtimeSessionId(input.sessionId)
      || input.reaperToken.length < 32
    ) return mutationRejected();
    return this.mutate(input.companyId, async (tx) => {
      const deleted = await tx.$executeRaw`
        DELETE FROM realtime_session_leases
         WHERE "companyId" = ${input.companyId}
           AND "subjectHash" = ${input.subjectHash}
           AND "sessionId" = ${input.sessionId}::uuid
           AND state = 'reaping'
           AND "reaperTokenHash" = ${hashRealtimeLeaseToken(input.reaperToken)}
      `;
      return deleted === 1 ? { ok: true, reason: null } : mutationRejected();
    });
  }

  async updateContext(input: RealtimeContextUpdateInput): Promise<RealtimeContextUpdateResult> {
    if (!this.validContextIdentity(input)) return { ok: false, reason: 'rejected' };
    const prepared = prepareRealtimeContext(input);
    if (!prepared) return { ok: false, reason: 'rejected' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<ContextLeaseRow[]>`
          SELECT state, "leaseExpiresAt", "hardExpiresAt", "contextSchemaVersion",
                 "contextRevision", "contextPayload", "contextDigest", "contextUpdatedAt"
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
           FOR UPDATE
        `;
        if (!row) return { ok: false as const, reason: 'rejected' as const };
        const nowRows = await tx.$queryRaw<ClockRow[]>`SELECT clock_timestamp() AS now`;
        const now = nowRows[0]?.now;
        if (!now) return { ok: false as const, reason: 'unavailable' as const };
        if (row.leaseExpiresAt.getTime() <= now.getTime() || row.hardExpiresAt.getTime() <= now.getTime()) {
          return { ok: false as const, reason: 'expired' as const };
        }
        if (row.state !== 'bound' && row.state !== 'active') {
          return { ok: false as const, reason: 'rejected' as const };
        }

        const contextShape = this.contextShape(row);
        if (contextShape === 'corrupt') return { ok: false as const, reason: 'unavailable' as const };
        if (contextShape === 'stored') {
          const persisted = prepareRealtimeContext({
            version: row.contextSchemaVersion!,
            revision: row.contextRevision!,
            context: row.contextPayload,
          });
          if (!persisted || persisted.digest !== row.contextDigest!.trim()) {
            return { ok: false as const, reason: 'unavailable' as const };
          }
          if (prepared.snapshot.revision < persisted.snapshot.revision) {
            return { ok: false as const, reason: 'stale' as const };
          }
          if (prepared.snapshot.revision === persisted.snapshot.revision) {
            return persisted.digest === prepared.digest
              ? {
                  ok: true as const,
                  status: 'idempotent' as const,
                  revision: persisted.snapshot.revision,
                }
              : { ok: false as const, reason: 'conflict' as const };
          }
        }

        const rows = await tx.$queryRaw<Array<{ contextRevision: number }>>`
          UPDATE realtime_session_leases
             SET "contextSchemaVersion" = ${prepared.snapshot.version},
                 "contextRevision" = ${prepared.snapshot.revision},
                 "contextPayload" = ${prepared.serialized}::jsonb,
                 "contextDigest" = ${prepared.digest},
                 "contextUpdatedAt" = clock_timestamp(),
                 "updatedAt" = clock_timestamp()
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
             AND state IN ('bound', 'active')
             AND "leaseExpiresAt" > clock_timestamp()
             AND "hardExpiresAt" > clock_timestamp()
          RETURNING "contextRevision"
        `;
        const updated = rows[0];
        return updated
          ? { ok: true as const, status: 'updated' as const, revision: updated.contextRevision }
          : { ok: false as const, reason: 'unavailable' as const };
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async readContext(input: RealtimeContextIdentity): Promise<RealtimeContextReadResult> {
    if (!this.validContextIdentity(input)) return { ok: false, reason: 'rejected' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<ContextLeaseRow[]>`
          SELECT state, "leaseExpiresAt", "hardExpiresAt", "contextSchemaVersion",
                 "contextRevision", "contextPayload", "contextDigest", "contextUpdatedAt"
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
           FOR SHARE
        `;
        if (!row) return { ok: false as const, reason: 'rejected' as const };
        const nowRows = await tx.$queryRaw<ClockRow[]>`SELECT clock_timestamp() AS now`;
        const now = nowRows[0]?.now;
        if (!now) return { ok: false as const, reason: 'unavailable' as const };
        if (row.leaseExpiresAt.getTime() <= now.getTime() || row.hardExpiresAt.getTime() <= now.getTime()) {
          return { ok: false as const, reason: 'expired' as const };
        }
        if (row.state !== 'active') return { ok: false as const, reason: 'rejected' as const };

        const contextShape = this.contextShape(row);
        if (contextShape === 'empty') return { ok: true as const, snapshot: null };
        if (contextShape === 'corrupt') return { ok: false as const, reason: 'unavailable' as const };
        const prepared = prepareRealtimeContext({
          version: row.contextSchemaVersion!,
          revision: row.contextRevision!,
          context: row.contextPayload,
        });
        if (!prepared || prepared.digest !== row.contextDigest!.trim()) {
          return { ok: false as const, reason: 'unavailable' as const };
        }
        return { ok: true as const, snapshot: prepared.snapshot };
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  private async claimRowForReaping(
    tx: Prisma.TransactionClient,
    row: LeaseRow,
  ): Promise<RealtimeReapingClaim | null> {
    if (!row.providerId || !row.providerCallId) return null;
    const reaperToken = token();
    const [claimed] = await tx.$queryRaw<Array<ReapingRow & { reaperLeaseExpiresAt: Date }>>`
      UPDATE realtime_session_leases
         SET state = 'reaping', "reaperTokenHash" = ${hashRealtimeLeaseToken(reaperToken)},
             "leaseExpiresAt" = clock_timestamp() + make_interval(secs => ${this.policy.reaperLeaseSeconds}),
             "updatedAt" = clock_timestamp(), version = version + 1
       WHERE "companyId" = ${row.companyId}
         AND "subjectHash" = ${row.subjectHash}
         AND "sessionId" = ${row.sessionId}::uuid
         AND version = ${row.version}
         AND "providerId" = ${row.providerId}
         AND "providerCallId" = ${row.providerCallId}
      RETURNING "companyId", "subjectHash", "sessionId", state, "providerId", "providerCallId",
                "leaseExpiresAt" AS "reaperLeaseExpiresAt", "hardExpiresAt", version,
                clock_timestamp() AS "databaseNow"
    `;
    if (
      !claimed
      || !claimed.providerId
      || !isRealtimeProviderId(claimed.providerId)
      || !claimed.providerCallId
      || !(claimed.hardExpiresAt instanceof Date)
      || Number.isNaN(claimed.hardExpiresAt.getTime())
      || !(claimed.databaseNow instanceof Date)
      || Number.isNaN(claimed.databaseNow.getTime())
    ) return null;
    const hardExpiryProof = claimed.databaseNow.getTime() >= claimed.hardExpiresAt.getTime()
      ? {
          source: 'database_hard_expiry' as const,
          companyId: claimed.companyId,
          subjectHash: claimed.subjectHash.trim(),
          sessionId: claimed.sessionId,
          providerId: claimed.providerId,
          providerCallId: claimed.providerCallId,
          hardExpiresAt: claimed.hardExpiresAt.toISOString(),
          databaseObservedAt: claimed.databaseNow.toISOString(),
          leaseVersion: claimed.version,
        }
      : null;
    return {
      companyId: claimed.companyId,
      subjectHash: claimed.subjectHash,
      sessionId: claimed.sessionId,
      providerId: claimed.providerId,
      providerCallId: claimed.providerCallId,
      reaperToken,
      reaperLeaseExpiresAt: claimed.reaperLeaseExpiresAt.toISOString(),
      hardExpiryProof,
    };
  }

  private async hasConfirmedMistralTermination(
    tx: Prisma.TransactionClient,
    lease: Pick<LeaseRow, 'companyId' | 'subjectHash' | 'sessionId' | 'providerId' | 'providerCallId'>,
  ): Promise<boolean> {
    if (lease.providerId !== 'mistral' || lease.providerCallId === null) return false;
    const [proof] = await tx.$queryRaw<Array<{ ok: boolean }>>`
      SELECT true AS ok
        FROM realtime_mistral_ingress_tickets
       WHERE "companyId" = ${lease.companyId}
         AND "subjectHash" = ${lease.subjectHash}
         AND "sessionId" = ${lease.sessionId}::uuid
         AND state IN ('completed', 'abandoned')
         AND "providerTermination" = 'confirmed'
         AND "providerSessionId" = ${lease.providerCallId}
       LIMIT 1
    `;
    return proof?.ok === true;
  }

  private quotaDenial(quota: QuotaRow): Exclude<RealtimeAdmissionResult, { allowed: true }> | null {
    const rules: Array<{
      denial: RealtimeAdmissionDenial;
      count: number;
      limit: number;
      oldest: Date | null;
      windowMs: number;
    }> = [
      { denial: 'user_minute', count: quota.userMinute, limit: this.policy.userLimitPerMinute, oldest: quota.userMinuteOldest, windowMs: 60_000 },
      { denial: 'user_hour', count: quota.userHour, limit: this.policy.userLimitPerHour, oldest: quota.userHourOldest, windowMs: 3_600_000 },
      { denial: 'tenant_minute', count: quota.tenantMinute, limit: this.policy.tenantLimitPerMinute, oldest: quota.tenantMinuteOldest, windowMs: 60_000 },
      { denial: 'tenant_hour', count: quota.tenantHour, limit: this.policy.tenantLimitPerHour, oldest: quota.tenantHourOldest, windowMs: 3_600_000 },
    ];
    for (const rule of rules) {
      if (rule.count >= rule.limit) {
        return {
          allowed: false,
          denial: rule.denial,
          retryAt: rule.oldest ? new Date(rule.oldest.getTime() + rule.windowMs).toISOString() : null,
        };
      }
    }
    return null;
  }

  private async classifyMutationMiss(
    tx: Prisma.TransactionClient,
    input: RealtimeLeaseCredential,
  ): Promise<RealtimeAdmissionMutationResult> {
    const [row] = await tx.$queryRaw<Array<{ expired: boolean }>>`
      SELECT ("leaseExpiresAt" <= clock_timestamp() OR "hardExpiresAt" <= clock_timestamp()) AS expired
        FROM realtime_session_leases
       WHERE "companyId" = ${input.companyId}
         AND "subjectHash" = ${input.subjectHash}
         AND "sessionId" = ${input.sessionId}::uuid
         AND "leaseTokenHash" = ${hashRealtimeLeaseToken(input.leaseToken)}
    `;
    return row?.expired ? mutationExpired() : mutationRejected();
  }

  private validContextIdentity(input: RealtimeContextIdentity): boolean {
    return isRealtimeCompanyId(input.companyId)
      && isRealtimeSubjectHash(input.subjectHash)
      && isRealtimeSessionId(input.sessionId);
  }

  private contextShape(row: ContextLeaseRow): 'empty' | 'stored' | 'corrupt' {
    const fields = [
      row.contextSchemaVersion,
      row.contextRevision,
      row.contextPayload,
      row.contextDigest,
      row.contextUpdatedAt,
    ];
    if (fields.every((field) => field === null)) return 'empty';
    return fields.every((field) => field !== null) ? 'stored' : 'corrupt';
  }

  private async mutate(
    companyId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<RealtimeAdmissionMutationResult>,
  ): Promise<RealtimeAdmissionMutationResult> {
    try {
      return await this.prisma.withTenant(companyId, operation);
    } catch {
      return mutationUnavailable();
    }
  }

  private async lockAdmission(
    tx: Prisma.TransactionClient,
    companyId: string,
    subjectHash: string,
  ): Promise<void> {
    // Ordre global tenant -> sujet : évite les interblocages entre réservations concurrentes.
    await this.lockTenant(tx, companyId);
    // `$queryRaw` tenterait de désérialiser le pseudo-type PostgreSQL `void` retourné par
    // pg_advisory_xact_lock et ferait rollback côté Prisma avant la seconde serrure.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`bob-live:subject:${companyId}:${subjectHash}`}, 0))
    `;
  }

  private async lockTenant(tx: Prisma.TransactionClient, companyId: string): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`bob-live:tenant:${companyId}`}, 0))
    `;
  }
}
