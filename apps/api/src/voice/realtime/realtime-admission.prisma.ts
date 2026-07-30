import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
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
  type RealtimeAdmissionSessionLookupInput,
  type RealtimeAgentMissionBootstrapAcknowledgementInput,
  type RealtimeAgentMissionBootstrapAcknowledgementResult,
  type RealtimeContextIdentity,
  type RealtimeContextReadResult,
  type RealtimeContextUpdateInput,
  type RealtimeContextUpdateResult,
  type RealtimeLeaseCredential,
  type RealtimeProviderId,
  type RealtimeReapingBatchResult,
  type RealtimeReapingClaim,
  type RealtimeReleaseInput,
  type RealtimeSessionIdentityResolution,
  type RealtimeTerminationClaimResult,
} from './realtime-admission';

interface ClockRow {
  now: Date;
}

interface CancellationFenceClockRow {
  cancelledAt: Date;
}

interface ReaperTimeoutRow {
  statementTimeout: string;
  lockTimeout: string;
}

interface AdmissionTimeoutRow {
  statementTimeout: string;
  lockTimeout: string;
}

const REAPER_EVENT_CLEANUP_LIMIT = 1_000;
const REAPER_CANCELLATION_CLEANUP_LIMIT = 1_000;
const REAPER_TRANSACTION_OPTIONS = { maxWaitMs: 1_000, timeoutMs: 4_000 } as const;
const REAPER_STATEMENT_TIMEOUT = '3s';
const REAPER_LOCK_TIMEOUT = '1s';
const ADMISSION_TRANSACTION_OPTIONS = { maxWaitMs: 1_000, timeoutMs: 4_000 } as const;
const ADMISSION_STATEMENT_TIMEOUT = '3s';
const ADMISSION_LOCK_TIMEOUT = '1s';

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

interface InsertedLeaseRow {
  leaseExpiresAt: Date;
  hardExpiresAt: Date;
  agentMissionProtocolVersion: number | null;
  agentMissionProtocolBoundAt: Date | null;
  agentMissionCapabilityHash: string | null;
  agentMissionReleaseFlagVersion: number | null;
}

interface SessionIdentityRow {
  companyId: string;
  subjectHash: string;
  sessionId: string;
}

interface AgentMissionBootstrapReceiptRow {
  companyId: string;
  subjectHash: string;
  sessionId: string;
  state: string;
  providerId: RealtimeProviderId | null;
  providerCallId: string | null;
  leaseExpiresAt: Date;
  hardExpiresAt: Date;
  agentMissionProtocolVersion: number | null;
  agentMissionProtocolBoundAt: Date | null;
  agentMissionCapabilityHash: string | null;
  agentMissionBootstrapAcknowledgedAt: Date | null;
  version: number;
}

interface AgentMissionBootstrapReceiptMutationRow {
  acknowledgedAt: Date;
  leaseExpiresAt: Date;
}

interface AgentMissionReleaseFlagRevalidationRow {
  accepted: boolean;
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

interface CapacityPreflightRow {
  status: 'allowed' | 'saturated' | 'unavailable';
  retryAt: Date | null;
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
  const candidates = input.subjectHashCandidates;
  const binding = input.agentMissionBinding;
  return isRealtimeCompanyId(input.companyId)
    && isRealtimeSubjectHash(input.subjectHash)
    && Array.isArray(candidates)
    && candidates.length >= 1
    && candidates.length <= 32
    && candidates.every(isRealtimeSubjectHash)
    && new Set(candidates).size === candidates.length
    && candidates.includes(input.subjectHash)
    && isRealtimeSubjectHash(input.principalBindingHash)
    && (
      binding === null
      || (
        (
          (
            binding.protocolVersion === 1
            && binding.releaseFlagKey === 'bob.agent_missions.quote.v1'
          )
          || (
            binding.protocolVersion === 2
            && binding.releaseFlagKey === 'bob.agent_missions.quote.m2a'
          )
        )
        && isRealtimeSubjectHash(binding.capabilityHash)
        && (
          binding.releaseEnvironment === 'development'
          || binding.releaseEnvironment === 'staging'
          || binding.releaseEnvironment === 'production'
        )
        && Number.isSafeInteger(binding.releaseFlagVersion)
        && binding.releaseFlagVersion >= 1
        && binding.releaseFlagVersion <= 2_147_483_647
        && binding.principalBindingHash === input.principalBindingHash
      )
    )
    && (input.sessionId === undefined || isRealtimeSessionId(input.sessionId))
    && Number.isInteger(input.maxSessionSeconds)
    && input.maxSessionSeconds >= 1
    && input.maxSessionSeconds <= 900;
}

function validSessionLookup(input: RealtimeAdmissionSessionLookupInput): boolean {
  const candidates = input.subjectHashCandidates;
  return isRealtimeCompanyId(input.companyId)
    && Array.isArray(candidates)
    && candidates.length >= 1
    && candidates.length <= 32
    && candidates.every(isRealtimeSubjectHash)
    && new Set(candidates).size === candidates.length
    && isRealtimeSubjectHash(input.principalBindingHash)
    && isRealtimeSessionId(input.sessionId);
}

function validAgentMissionBootstrapAcknowledgement(
  input: RealtimeAgentMissionBootstrapAcknowledgementInput,
): boolean {
  return validSessionLookup(input)
    && (input.protocolVersion === 1 || input.protocolVersion === 2)
    && isRealtimeSubjectHash(input.capabilityHash);
}

function capabilityHashesMatch(left: string, right: string): boolean {
  if (!isRealtimeSubjectHash(left) || !isRealtimeSubjectHash(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/**
 * Admission distribuée Bob Live. Chaque réserve ouvre une transaction tenant très courte ; aucun
 * appel réseau provider n'est exécuté sous verrou. L'advisory lock tenant sérialise les compteurs
 * agrégés entre sujets et le lock principal protège le bail à travers les rotations HMAC.
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
    if (!validReserve(input) || this.policy.globalCapacity === null) return deniedUnavailable();
    const capacity = this.policy.globalCapacity;
    const sessionId = input.sessionId ?? randomUUID();
    const leaseToken = token();
    const leaseTokenHash = hashRealtimeLeaseToken(leaseToken);
    const subjectHashCandidates = [...input.subjectHashCandidates].sort();

    try {
      return await this.prisma.withIsolatedTenant(input.companyId, async (tx) => {
        const [timeouts] = await tx.$queryRaw<AdmissionTimeoutRow[]>`
          SELECT set_config('statement_timeout', '3s', true) AS "statementTimeout",
                 set_config('lock_timeout', '1s', true) AS "lockTimeout"
        `;
        if (timeouts?.statementTimeout !== '3s' || timeouts.lockTimeout !== '1s') {
          return deniedUnavailable();
        }
        await this.lockAdmission(tx, input.companyId, input.principalBindingHash);
        const [{ now }] = await tx.$queryRaw<ClockRow[]>`SELECT clock_timestamp() AS now`;
        if (!now) return deniedUnavailable();

        if (input.sessionId) {
          // Le fence est insert/delete-only. Le lock advisory tenant+principal sérialise déjà
          // sa lecture avec cancel ; un row-lock exigerait à tort le privilège SQL UPDATE.
          const cancellationFences = await tx.$queryRaw<Array<{ subjectHash: string }>>`
            SELECT "subjectHash"
              FROM realtime_admission_cancellation_fences
             WHERE "companyId" = ${input.companyId}
               AND "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
             AND "sessionId" = ${input.sessionId}::uuid
             AND "expiresAt" > ${now}
             ORDER BY "subjectHash"
        `;
          if (cancellationFences.length > 0) {
            return { allowed: false, denial: 'active_lease', retryAt: null };
          }
        }

        const existingRows = await tx.$queryRaw<LeaseRow[]>`
          SELECT "companyId", "subjectHash", "sessionId", state, "providerId", "providerCallId",
                 "leaseExpiresAt", "hardExpiresAt", version
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
           ORDER BY "subjectHash", "sessionId"
           FOR UPDATE
        `;
        const blockingRows = existingRows.filter((existing) => (
          (existing.state === 'reaping' && existing.leaseExpiresAt.getTime() > now.getTime())
          || (
            existing.state !== 'reaping'
            && existing.leaseExpiresAt.getTime() > now.getTime()
            && existing.hardExpiresAt.getTime() > now.getTime()
          )
        ));
        if (blockingRows.length > 1) return deniedUnavailable();
        const blocking = blockingRows[0];
        if (blocking) {
          if (blocking.state === 'reaping') {
            return {
              allowed: false,
              denial: 'session_reaping',
              retryAt: blocking.leaseExpiresAt.toISOString(),
            };
          }
          return {
            allowed: false,
            denial: 'active_lease',
            retryAt: blocking.leaseExpiresAt.toISOString(),
          };
        }

        const staleProviderlessLeases: LeaseRow[] = [];
        for (const existing of existingRows) {
          if (existing.providerId === null && existing.providerCallId === null) {
            // Le DELETE prend le verrou global via trigger. Il est différé après les quotas pour
            // ne pas sérialiser purge et comptage de toutes les répliques sous ce verrou.
            staleProviderlessLeases.push(existing);
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
            return subjectHashCandidates.includes(replay.subjectHash.trim())
              ? { allowed: false as const, denial: 'active_lease' as const, retryAt: null }
              : { allowed: false as const, denial: 'unavailable' as const, retryAt: null };
          }
        }

        const [quota] = await tx.$queryRaw<QuotaRow[]>`
          SELECT
            count(*) FILTER (
              WHERE "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
                AND "admittedAt" > ${now} - interval '1 minute'
            )::int AS "userMinute",
            count(*) FILTER (
              WHERE "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
                AND "admittedAt" > ${now} - interval '1 hour'
            )::int AS "userHour",
            count(*) FILTER (WHERE "admittedAt" > ${now} - interval '1 minute')::int AS "tenantMinute",
            count(*) FILTER (WHERE "admittedAt" > ${now} - interval '1 hour')::int AS "tenantHour",
            min("admittedAt") FILTER (
              WHERE "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
                AND "admittedAt" > ${now} - interval '1 minute'
            ) AS "userMinuteOldest",
            min("admittedAt") FILTER (
              WHERE "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
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

        for (const staleProviderlessLease of staleProviderlessLeases) {
          const deleted = await tx.$executeRaw`
            DELETE FROM realtime_session_leases
             WHERE "companyId" = ${staleProviderlessLease.companyId}
               AND "subjectHash" = ${staleProviderlessLease.subjectHash}
               AND "sessionId" = ${staleProviderlessLease.sessionId}::uuid
               AND version = ${staleProviderlessLease.version}
               AND "providerId" IS NULL
               AND "providerCallId" IS NULL
               AND ("leaseExpiresAt" <= ${now} OR "hardExpiresAt" <= ${now})
          `;
          if (deleted !== 1) return deniedUnavailable();
        }

        if (input.agentMissionBinding !== null) {
          const [releaseFlag] = await tx.$queryRaw<AgentMissionReleaseFlagRevalidationRow[]>`
            SELECT public.revalidate_agent_mission_release_flag_v1(
              ${input.agentMissionBinding.releaseFlagKey},
              ${input.agentMissionBinding.releaseEnvironment},
              ${input.agentMissionBinding.releaseFlagVersion}::integer
            ) AS accepted
          `;
          if (releaseFlag?.accepted !== true) return deniedUnavailable();
        }

        // Dernier verrou de l'ordre tenant → sujet → singleton. Une autorisation conserve le
        // FOR UPDATE jusqu'au commit qui crée lease + événement ; aucun provider n'est appelé ici.
        const [preflight] = await tx.$queryRaw<CapacityPreflightRow[]>`
          SELECT status, "retryAt"
            FROM preflight_realtime_global_capacity_v1(
              ${capacity.providerId}, ${capacity.providerModel},
              ${capacity.globalMaxSessions}::integer, ${capacity.providerMaxSessions}::integer,
              ${capacity.configVersion}::integer
            )
        `;
        if (!preflight || preflight.status === 'unavailable') return deniedUnavailable();
        if (preflight.status === 'saturated') {
          return {
            allowed: false,
            denial: 'global_capacity',
            retryAt: preflight.retryAt?.toISOString() ?? null,
          };
        }
        if (preflight.status !== 'allowed' || preflight.retryAt !== null) {
          return deniedUnavailable();
        }

        const binding = input.agentMissionBinding;
        const [inserted] = await tx.$queryRaw<InsertedLeaseRow[]>`
          INSERT INTO realtime_session_leases (
            "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
            "providerId", "providerCallId", "reaperTokenHash", "reservedAt", "leaseExpiresAt",
            "hardExpiresAt", "activatedAt",
            "agentMissionProtocolVersion", "agentMissionProtocolBoundAt",
            "agentMissionCapabilityHash", "agentMissionReleaseFlagVersion",
            "updatedAt", version
          ) VALUES (
            ${input.companyId}, ${input.subjectHash}, ${sessionId}::uuid, ${leaseTokenHash}, 'reserved',
            NULL, NULL, NULL, ${now},
            LEAST(${now} + make_interval(secs => ${this.policy.reservationTtlSeconds}),
                  ${now} + make_interval(secs => ${input.maxSessionSeconds})),
            ${now} + make_interval(secs => ${input.maxSessionSeconds}),
            NULL,
            ${binding?.protocolVersion ?? null},
            ${binding === null ? null : now},
            ${binding?.capabilityHash ?? null},
            ${binding?.releaseFlagVersion ?? null},
            ${now}, 1
          )
          RETURNING "leaseExpiresAt", "hardExpiresAt",
                    "agentMissionProtocolVersion", "agentMissionProtocolBoundAt",
                    "agentMissionCapabilityHash", "agentMissionReleaseFlagVersion"
        `;
        if (!inserted) throw new Error('realtime_admission_insert_missing');
        const insertedCapabilityHash = inserted.agentMissionCapabilityHash?.trim() ?? null;
        const insertedProofMatches = binding === null
          ? inserted.agentMissionProtocolVersion === null
            && inserted.agentMissionProtocolBoundAt === null
            && insertedCapabilityHash === null
            && inserted.agentMissionReleaseFlagVersion === null
          : inserted.agentMissionProtocolVersion === binding.protocolVersion
            && inserted.agentMissionProtocolBoundAt?.getTime() === now.getTime()
            && insertedCapabilityHash === binding.capabilityHash
            && inserted.agentMissionReleaseFlagVersion === binding.releaseFlagVersion;
        if (!insertedProofMatches) {
          throw new Error('realtime_agent_mission_insert_proof_mismatch');
        }
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
          agentMissionProof: binding === null
            ? null
            : {
                protocolVersion: binding.protocolVersion,
                capabilityHash: insertedCapabilityHash!,
                releaseFlagVersion: binding.releaseFlagVersion,
              },
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
      }, ADMISSION_TRANSACTION_OPTIONS);
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
               "leaseExpiresAt" = CASE
                 WHEN "agentMissionProtocolVersion" IS NOT NULL
                      AND "agentMissionBootstrapAcknowledgedAt" IS NULL
                   THEN "leaseExpiresAt"
                 ELSE LEAST(
                   clock_timestamp() + make_interval(secs => ${this.policy.activeLeaseSeconds}),
                   "hardExpiresAt"
                 )
               END,
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
           AND (
             "agentMissionProtocolVersion" IS NULL
             OR "agentMissionBootstrapAcknowledgedAt" IS NOT NULL
           )
           AND "leaseExpiresAt" > clock_timestamp()
           AND "hardExpiresAt" > clock_timestamp()
        RETURNING "leaseExpiresAt"
      `;
      if (rows[0]) {
        return { ok: true, reason: null, leaseExpiresAt: rows[0].leaseExpiresAt.toISOString() };
      }
      const [pendingReceipt] = await tx.$queryRaw<UpdatedLeaseRow[]>`
        SELECT "leaseExpiresAt"
          FROM realtime_session_leases
         WHERE "companyId" = ${input.companyId}
           AND "subjectHash" = ${input.subjectHash}
           AND "sessionId" = ${input.sessionId}::uuid
           AND "leaseTokenHash" = ${hashRealtimeLeaseToken(input.leaseToken)}
           AND state = 'active'
           AND "providerId" IS NOT NULL
           AND "providerCallId" IS NOT NULL
           AND "agentMissionProtocolVersion" IS NOT NULL
           AND "agentMissionBootstrapAcknowledgedAt" IS NULL
           AND "leaseExpiresAt" > clock_timestamp()
           AND "hardExpiresAt" > clock_timestamp()
      `;
      return pendingReceipt
        ? {
            ok: true,
            reason: null,
            leaseExpiresAt: pendingReceipt.leaseExpiresAt.toISOString(),
          }
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
      return await this.withBoundedReaperTenant(input.companyId, async (tx) => {
        await this.lockTenant(tx, input.companyId);
        await tx.$executeRaw`
          -- Le verrou advisory tenant rend SKIP LOCKED inutile et conserve l'ACL minimale
          -- SELECT+DELETE de ce registre immuable.
          WITH candidates AS (
            SELECT event.id
              FROM realtime_admission_events AS event
             WHERE event."companyId" = ${input.companyId}
               AND event."admittedAt" <= clock_timestamp() - interval '2 hours'
             ORDER BY event."admittedAt", event.id
             FOR UPDATE OF event SKIP LOCKED
             LIMIT ${REAPER_EVENT_CLEANUP_LIMIT}
          )
          DELETE FROM realtime_admission_events AS event
          USING candidates
           WHERE event."companyId" = ${input.companyId}
             AND event.id = candidates.id
        `;
        await tx.$executeRaw`
          WITH candidates AS (
            SELECT fence."sessionId", fence."subjectHash"
              FROM realtime_admission_cancellation_fences AS fence
             WHERE fence."companyId" = ${input.companyId}
               AND fence."expiresAt" <= clock_timestamp()
             ORDER BY fence."expiresAt", fence."sessionId", fence."subjectHash"
             LIMIT ${REAPER_CANCELLATION_CLEANUP_LIMIT}
          )
          DELETE FROM realtime_admission_cancellation_fences AS fence
          USING candidates
           WHERE fence."companyId" = ${input.companyId}
             AND fence."sessionId" = candidates."sessionId"
             AND fence."subjectHash" = candidates."subjectHash"
        `;
        await tx.$executeRaw`
          WITH candidates AS (
            SELECT lease."subjectHash", lease."sessionId"
              FROM realtime_session_leases AS lease
             WHERE lease."companyId" = ${input.companyId}
               AND lease."providerId" IS NULL
               AND lease."providerCallId" IS NULL
               AND (
                 lease."leaseExpiresAt" <= clock_timestamp()
                 OR lease."hardExpiresAt" <= clock_timestamp()
               )
             ORDER BY LEAST(lease."leaseExpiresAt", lease."hardExpiresAt"), lease."sessionId"
             FOR UPDATE OF lease SKIP LOCKED
             LIMIT ${limit}
          )
          DELETE FROM realtime_session_leases AS lease
          USING candidates
           WHERE lease."companyId" = ${input.companyId}
             AND lease."subjectHash" = candidates."subjectHash"
             AND lease."sessionId" = candidates."sessionId"
        `;
        // Une preuve terminale Mistral confirmée signifie que le socket fournisseur est déjà
        // fermé. Après la grâce de livraison, supprimer localement le drain est la seule action
        // correcte : le transformer en claim reaper provoquerait un second hangup sans nécessité.
        await tx.$executeRaw`
          WITH candidates AS (
            SELECT lease."subjectHash", lease."sessionId"
              FROM realtime_session_leases AS lease
              JOIN realtime_mistral_ingress_tickets AS ticket
                ON ticket."companyId" = lease."companyId"
               AND ticket."subjectHash" = lease."subjectHash"
               AND ticket."sessionId" = lease."sessionId"
             WHERE lease."companyId" = ${input.companyId}
               AND ticket.state IN ('completed', 'abandoned')
               AND ticket."providerTermination" = 'confirmed'
               AND ticket."providerSessionId" = lease."providerCallId"
               AND lease."providerId" = 'mistral'
               AND lease."providerCallId" IS NOT NULL
               AND (
                 lease."leaseExpiresAt" <= clock_timestamp()
                 OR lease."hardExpiresAt" <= clock_timestamp()
               )
             ORDER BY LEAST(lease."leaseExpiresAt", lease."hardExpiresAt"), lease."sessionId"
             FOR UPDATE OF lease SKIP LOCKED
             LIMIT ${limit}
          )
          DELETE FROM realtime_session_leases AS lease
          USING candidates
           WHERE lease."companyId" = ${input.companyId}
             AND lease."subjectHash" = candidates."subjectHash"
             AND lease."sessionId" = candidates."sessionId"
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
        // Les triggers N-1/N ne déplacent les minima que vers le passé : ils ne peuvent donc
        // jamais masquer une échéance. Sous le même advisory lock tenant, le reaper est l'unique
        // autorité qui avance ou supprime ensuite cette projection conservative.
        await this.reconcileReaperSchedule(tx, input.companyId);
        return { ok: true as const, claims };
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async resolveSession(
    input: RealtimeAdmissionSessionLookupInput,
  ): Promise<RealtimeSessionIdentityResolution> {
    if (!validSessionLookup(input)) return { ok: false, reason: 'unavailable' };
    const subjectHashCandidates = [...input.subjectHashCandidates].sort();
    try {
      return await this.prisma.withIsolatedTenant(input.companyId, async (tx) => {
        const [timeouts] = await tx.$queryRaw<AdmissionTimeoutRow[]>`
          SELECT set_config('statement_timeout', ${ADMISSION_STATEMENT_TIMEOUT}, true)
                   AS "statementTimeout",
                 set_config('lock_timeout', ${ADMISSION_LOCK_TIMEOUT}, true) AS "lockTimeout"
        `;
        if (
          timeouts?.statementTimeout !== ADMISSION_STATEMENT_TIMEOUT
          || timeouts.lockTimeout !== ADMISSION_LOCK_TIMEOUT
        ) throw new Error('realtime_session_lookup_timeout_fence_rejected');
        await this.lockAdmission(tx, input.companyId, input.principalBindingHash);
        // Même invariant que reserve/cancel : sérialisation advisory, aucune autorité UPDATE.
        const cancellationFences = await tx.$queryRaw<Array<{ subjectHash: string }>>`
          SELECT "subjectHash"
            FROM realtime_admission_cancellation_fences
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
             AND "sessionId" = ${input.sessionId}::uuid
             AND "expiresAt" > clock_timestamp()
           ORDER BY "subjectHash"
        `;
        if (cancellationFences.length > 0) {
          return { ok: true as const, identity: null };
        }
        const rows = await tx.$queryRaw<SessionIdentityRow[]>`
          SELECT "companyId", "subjectHash", "sessionId"
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
             AND "sessionId" = ${input.sessionId}::uuid
             AND state = 'active'
             AND "providerId" IS NOT NULL
             AND "providerCallId" IS NOT NULL
             AND "leaseExpiresAt" > clock_timestamp()
             AND "hardExpiresAt" > clock_timestamp()
           ORDER BY "subjectHash", "sessionId"
           FOR UPDATE
        `;
        if (rows.length > 1) return { ok: false as const, reason: 'unavailable' as const };
        const row = rows[0];
        return {
          ok: true as const,
          identity: row
            ? {
                companyId: row.companyId,
                subjectHash: row.subjectHash.trim(),
                sessionId: row.sessionId,
              }
            : null,
        };
      }, ADMISSION_TRANSACTION_OPTIONS);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async acknowledgeAgentMissionBootstrap(
    input: RealtimeAgentMissionBootstrapAcknowledgementInput,
  ): Promise<RealtimeAgentMissionBootstrapAcknowledgementResult> {
    if (!validAgentMissionBootstrapAcknowledgement(input)) {
      return { ok: false, reason: 'malformed' };
    }
    const subjectHashCandidates = [...input.subjectHashCandidates].sort();
    try {
      return await this.prisma.withIsolatedTenant(input.companyId, async (tx) => {
        const [timeouts] = await tx.$queryRaw<AdmissionTimeoutRow[]>`
          SELECT set_config('statement_timeout', ${ADMISSION_STATEMENT_TIMEOUT}, true)
                   AS "statementTimeout",
                 set_config('lock_timeout', ${ADMISSION_LOCK_TIMEOUT}, true) AS "lockTimeout"
        `;
        if (
          timeouts?.statementTimeout !== ADMISSION_STATEMENT_TIMEOUT
          || timeouts.lockTimeout !== ADMISSION_LOCK_TIMEOUT
        ) throw new Error('agent_mission_bootstrap_receipt_timeout_fence_rejected');

        await this.lockAdmission(tx, input.companyId, input.principalBindingHash);
        // Un ACK ne row-lock jamais le fence insert/delete-only : bob_app n'a pas UPDATE.
        const cancellationFences = await tx.$queryRaw<Array<{ subjectHash: string }>>`
          SELECT "subjectHash"
            FROM realtime_admission_cancellation_fences
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
             AND "sessionId" = ${input.sessionId}::uuid
             AND "expiresAt" > clock_timestamp()
           ORDER BY "subjectHash"
        `;
        if (cancellationFences.length > 0) return { ok: false as const, reason: 'state' as const };

        const rows = await tx.$queryRaw<AgentMissionBootstrapReceiptRow[]>`
          SELECT "companyId", "subjectHash", "sessionId", state, "providerId", "providerCallId",
                 "leaseExpiresAt", "hardExpiresAt", "agentMissionProtocolVersion",
                 "agentMissionProtocolBoundAt", "agentMissionCapabilityHash",
                 "agentMissionBootstrapAcknowledgedAt", version
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
             AND "sessionId" = ${input.sessionId}::uuid
           ORDER BY "subjectHash", "sessionId"
           FOR UPDATE
        `;
        if (rows.length > 1) return { ok: false as const, reason: 'ambiguous' as const };
        const row = rows[0];
        if (!row) return { ok: false as const, reason: 'not_found' as const };

        const [{ now }] = await tx.$queryRaw<ClockRow[]>`SELECT clock_timestamp() AS now`;
        if (!now) return { ok: false as const, reason: 'unavailable' as const };
        if (
          row.state !== 'active'
          || row.providerId === null
          || row.providerCallId === null
          || row.agentMissionProtocolVersion !== input.protocolVersion
          || row.agentMissionProtocolBoundAt === null
          || row.agentMissionCapabilityHash === null
        ) return { ok: false as const, reason: 'state' as const };
        if (
          row.leaseExpiresAt.getTime() <= now.getTime()
          || row.hardExpiresAt.getTime() <= now.getTime()
        ) return { ok: false as const, reason: 'expired' as const };

        const storedCapabilityHash = row.agentMissionCapabilityHash.trim();
        if (!capabilityHashesMatch(storedCapabilityHash, input.capabilityHash)) {
          return { ok: false as const, reason: 'hash_mismatch' as const };
        }
        if (row.agentMissionBootstrapAcknowledgedAt !== null) {
          return {
            ok: true as const,
            status: 'replayed' as const,
            acknowledgedAt: row.agentMissionBootstrapAcknowledgedAt.toISOString(),
            leaseExpiresAt: row.leaseExpiresAt.toISOString(),
          };
        }

        const [acknowledged] = await tx.$queryRaw<AgentMissionBootstrapReceiptMutationRow[]>`
          UPDATE realtime_session_leases
             SET "agentMissionBootstrapAcknowledgedAt" = clock_timestamp(),
                 "leaseExpiresAt" = LEAST(
                   clock_timestamp() + make_interval(secs => ${this.policy.activeLeaseSeconds}),
                   "hardExpiresAt"
                 ),
                 "updatedAt" = clock_timestamp(),
                 version = version + 1
           WHERE "companyId" = ${row.companyId}
             AND "subjectHash" = ${row.subjectHash}
             AND "sessionId" = ${row.sessionId}::uuid
             AND version = ${row.version}
             AND state = 'active'
             AND "providerId" = ${row.providerId}
             AND "providerCallId" = ${row.providerCallId}
             AND "agentMissionProtocolVersion" = ${input.protocolVersion}
             AND "agentMissionCapabilityHash" = ${storedCapabilityHash}
             AND "agentMissionBootstrapAcknowledgedAt" IS NULL
             AND "leaseExpiresAt" > clock_timestamp()
             AND "hardExpiresAt" > clock_timestamp()
          RETURNING "agentMissionBootstrapAcknowledgedAt" AS "acknowledgedAt",
                    "leaseExpiresAt"
        `;
        if (!acknowledged) return { ok: false as const, reason: 'unavailable' as const };
        return {
          ok: true as const,
          status: 'acknowledged' as const,
          acknowledgedAt: acknowledged.acknowledgedAt.toISOString(),
          leaseExpiresAt: acknowledged.leaseExpiresAt.toISOString(),
        };
      }, ADMISSION_TRANSACTION_OPTIONS);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async claimTermination(
    input: RealtimeAdmissionSessionLookupInput,
  ): Promise<RealtimeTerminationClaimResult> {
    if (!validSessionLookup(input)) return { ok: false, reason: 'unavailable' };
    const subjectHashCandidates = [...input.subjectHashCandidates].sort();
    try {
      return await this.prisma.withIsolatedTenant(input.companyId, async (tx) => {
        const [timeouts] = await tx.$queryRaw<AdmissionTimeoutRow[]>`
          SELECT set_config('statement_timeout', ${ADMISSION_STATEMENT_TIMEOUT}, true)
                   AS "statementTimeout",
                 set_config('lock_timeout', ${ADMISSION_LOCK_TIMEOUT}, true) AS "lockTimeout"
        `;
        if (
          timeouts?.statementTimeout !== ADMISSION_STATEMENT_TIMEOUT
          || timeouts.lockTimeout !== ADMISSION_LOCK_TIMEOUT
        ) throw new Error('realtime_termination_timeout_fence_rejected');
        await this.lockAdmission(tx, input.companyId, input.principalBindingHash);
        const [{ now }] = await tx.$queryRaw<ClockRow[]>`SELECT clock_timestamp() AS now`;
        if (!now) return { ok: false as const, reason: 'unavailable' as const };
        // Le lock advisory protège la canonicalisation sans élargir les ACL du fence.
        const existingFences = await tx.$queryRaw<CancellationFenceClockRow[]>`
          SELECT "cancelledAt"
            FROM realtime_admission_cancellation_fences
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
             AND "sessionId" = ${input.sessionId}::uuid
           ORDER BY "subjectHash"
        `;
        const canonicalCancelledAt = existingFences.reduce(
          (earliest, fence) => (
            fence.cancelledAt.getTime() < earliest.getTime()
              ? fence.cancelledAt
              : earliest
          ),
          now,
        );
        const rows = await tx.$queryRaw<LeaseRow[]>`
          SELECT "companyId", "subjectHash", "sessionId", state, "providerId", "providerCallId",
                 "leaseExpiresAt", "hardExpiresAt", version
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" IN (${Prisma.join(subjectHashCandidates)})
             AND "sessionId" = ${input.sessionId}::uuid
           ORDER BY "subjectHash", "sessionId"
           FOR UPDATE
        `;
        const fenceValues = subjectHashCandidates.map((subjectHash) => Prisma.sql`
          (
            ${input.companyId}, ${input.sessionId}::uuid, ${subjectHash},
            ${canonicalCancelledAt}, ${canonicalCancelledAt} + interval '2 hours'
          )
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO realtime_admission_cancellation_fences (
            "companyId", "sessionId", "subjectHash", "cancelledAt", "expiresAt"
          ) VALUES ${Prisma.join(fenceValues)}
          ON CONFLICT ("companyId", "sessionId", "subjectHash") DO NOTHING
        `);
        if (rows.length > 1) return { ok: false as const, reason: 'unavailable' as const };
        const row = rows[0];
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
      }, ADMISSION_TRANSACTION_OPTIONS);
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
    try {
      return await this.withBoundedReaperTenant(input.companyId, async (tx) => {
        await this.lockTenant(tx, input.companyId);
        const deleted = await tx.$executeRaw`
          DELETE FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
             AND state = 'reaping'
             AND "reaperTokenHash" = ${hashRealtimeLeaseToken(input.reaperToken)}
        `;
        if (deleted !== 1) return mutationRejected();
        await this.reconcileReaperSchedule(tx, input.companyId);
        return { ok: true, reason: null };
      });
    } catch {
      return mutationUnavailable();
    }
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

  private withBoundedReaperTenant<T>(
    companyId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withIsolatedTenant(companyId, async (tx) => {
      const [timeouts] = await tx.$queryRaw<ReaperTimeoutRow[]>`
        SELECT set_config('statement_timeout', ${REAPER_STATEMENT_TIMEOUT}, true)
                 AS "statementTimeout",
               set_config('lock_timeout', ${REAPER_LOCK_TIMEOUT}, true) AS "lockTimeout"
      `;
      if (
        timeouts?.statementTimeout !== REAPER_STATEMENT_TIMEOUT
        || timeouts.lockTimeout !== REAPER_LOCK_TIMEOUT
      ) throw new Error('realtime_reaper_timeout_fence_rejected');
      return operation(tx);
    }, REAPER_TRANSACTION_OPTIONS);
  }

  private async reconcileReaperSchedule(
    tx: Prisma.TransactionClient,
    companyId: string,
  ): Promise<void> {
    // Verrouiller la projection AVANT de lire les sources. Un writer concurrent peut avoir déjà
    // modifié une lease puis attendre dans son trigger conservative : le reaper commitera sa vue,
    // puis ce trigger reprendra et appliquera LEAST. L'ordre inverse pourrait écraser une échéance
    // plus ancienne avec un snapshot antérieur et créer un faux négatif.
    await tx.$queryRaw`
      SELECT "companyId"
        FROM realtime_reaper_tenant_schedule
       WHERE "companyId" = ${companyId}
       FOR UPDATE
    `;
    await tx.$executeRaw`
      WITH projection AS (
        SELECT ${companyId}::text AS "companyId",
               (
                 SELECT min(event."admittedAt")
                   FROM realtime_admission_events AS event
                  WHERE event."companyId" = ${companyId}
               ) AS "oldestAdmissionAt",
               (
                 SELECT LEAST(
                   (
                     SELECT min(CASE
                       WHEN lease.state = 'reaping' THEN lease."leaseExpiresAt"
                       ELSE LEAST(lease."leaseExpiresAt", lease."hardExpiresAt")
                     END)
                       FROM realtime_session_leases AS lease
                      WHERE lease."companyId" = ${companyId}
                   ),
                   (
                     SELECT min(fence."expiresAt")
                       FROM realtime_admission_cancellation_fences AS fence
                      WHERE fence."companyId" = ${companyId}
                   )
                 )
               ) AS "nextLeaseDueAt"
      ), upserted AS (
        INSERT INTO realtime_reaper_tenant_schedule AS schedule (
          "companyId", "oldestAdmissionAt", "nextLeaseDueAt"
        )
        SELECT projection."companyId", projection."oldestAdmissionAt",
               projection."nextLeaseDueAt"
          FROM projection
         WHERE projection."oldestAdmissionAt" IS NOT NULL
            OR projection."nextLeaseDueAt" IS NOT NULL
        ON CONFLICT ("companyId") DO UPDATE
          SET "oldestAdmissionAt" = EXCLUDED."oldestAdmissionAt",
              "nextLeaseDueAt" = EXCLUDED."nextLeaseDueAt",
              revision = schedule.revision + 1
        RETURNING "companyId"
      )
      DELETE FROM realtime_reaper_tenant_schedule AS schedule
       WHERE schedule."companyId" = ${companyId}
         AND NOT EXISTS (SELECT 1 FROM upserted)
    `;
  }

  private async lockAdmission(
    tx: Prisma.TransactionClient,
    companyId: string,
    principalBindingHash: string,
  ): Promise<void> {
    // Ordre global tenant -> sujet : évite les interblocages entre réservations concurrentes.
    await this.lockTenant(tx, companyId);
    // `$queryRaw` tenterait de désérialiser le pseudo-type PostgreSQL `void` retourné par
    // pg_advisory_xact_lock et ferait rollback côté Prisma avant la seconde serrure.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`bob-live:principal:${companyId}:${principalBindingHash}`}, 0)
      )
    `;
  }

  private async lockTenant(tx: Prisma.TransactionClient, companyId: string): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`bob-live:tenant:${companyId}`}, 0))
    `;
  }
}
