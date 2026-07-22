import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { isRealtimeCompanyId } from './realtime-admission';
import {
  OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH,
  OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_TENANTS,
  type OpenAiNativeSpeechDueTenantsResult,
  type OpenAiNativeSpeechClaimAckResult,
  type OpenAiNativeSpeechClaimRenewResult,
  type OpenAiNativeSpeechMaintenanceClaimInput,
  type OpenAiNativeSpeechMaintenanceDueTenantsInput,
  type OpenAiNativeSpeechMaintenanceInput,
  type OpenAiNativeSpeechMaintenancePort,
  type OpenAiNativeSpeechPurgeResult,
  type OpenAiNativeSpeechReapResult,
} from './openai-native-speech-maintenance';

const POSTGRES_INT_MAX = 2_147_483_647;
const MAINTENANCE_TRANSACTION_OPTIONS = { maxWaitMs: 1_000, timeoutMs: 4_000 } as const;
const DIRECTORY_STATEMENT_TIMEOUT = '3s';
const DIRECTORY_LOCK_TIMEOUT = '1s';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface DueTenantRow {
  readonly companyId: string;
  readonly hasMore: boolean;
  readonly claimId: string;
}

interface ClaimAckRow {
  readonly acknowledged: boolean;
}

interface ClaimRenewRow {
  readonly renewed: boolean;
}

interface DirectoryTimeoutRow {
  readonly statementTimeout: string;
  readonly lockTimeout: string;
}

interface ReapedRow {
  readonly deliveryId: string;
  readonly revision: number;
  readonly phase: string;
  readonly expiresAt: Date;
  readonly terminalAt: Date | null;
  readonly hasMore: boolean;
}

interface PurgeSummaryRow {
  readonly purgedCount: number;
  readonly dependenciesBlocked: number;
  readonly hasMore: boolean;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date
    && Number.isSafeInteger(value.getTime())
    && value.getTime() >= 0;
}

function validInput(input: OpenAiNativeSpeechMaintenanceInput): boolean {
  return typeof input === 'object'
    && input !== null
    && typeof input.companyId === 'string'
    && isRealtimeCompanyId(input.companyId)
    && Number.isSafeInteger(input.limit)
    && input.limit >= 1
    && input.limit <= OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH;
}

function validReapedRow(row: ReapedRow): boolean {
  return typeof row === 'object'
    && row !== null
    && typeof row.deliveryId === 'string'
    && UUID.test(row.deliveryId)
    && Number.isSafeInteger(row.revision)
    && row.revision >= 2
    && row.revision <= POSTGRES_INT_MAX
    && row.phase === 'expired'
    && validDate(row.expiresAt)
    && validDate(row.terminalAt)
    && row.terminalAt.getTime() === row.expiresAt.getTime()
    && typeof row.hasMore === 'boolean';
}

/**
 * Maintenance PostgreSQL tenantée et bornée. Chaque geste ouvre sa propre transaction afin de ne
 * jamais hériter d'une transaction HTTP déjà avortée et utilise exclusivement l'horloge DB.
 */
export class PrismaOpenAiNativeSpeechMaintenance
implements OpenAiNativeSpeechMaintenancePort {
  constructor(private readonly prisma: PrismaService) {}

  private withBoundedDirectory<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withIsolatedGlobal(async (tx) => {
      // Un SET porté par `proconfig` commence trop tard pour armer le timer du statement appelant.
      // Cette première instruction distincte borne donc réellement l'attente du verrou de curseur
      // et l'exécution de la fonction ; le timeout Prisma reste une seconde ceinture process.
      const [timeouts] = await tx.$queryRaw<DirectoryTimeoutRow[]>(Prisma.sql`
        SELECT pg_catalog.set_config(
                 'statement_timeout', ${DIRECTORY_STATEMENT_TIMEOUT}, true
               ) AS "statementTimeout",
               pg_catalog.set_config(
                 'lock_timeout', ${DIRECTORY_LOCK_TIMEOUT}, true
               ) AS "lockTimeout"
      `);
      if (
        timeouts?.statementTimeout !== DIRECTORY_STATEMENT_TIMEOUT
        || timeouts.lockTimeout !== DIRECTORY_LOCK_TIMEOUT
      ) throw new Error('openai_native_directory_timeout_fence_rejected');
      return operation(tx);
    }, MAINTENANCE_TRANSACTION_OPTIONS);
  }

  async listDueCompanyIds(
    input: OpenAiNativeSpeechMaintenanceDueTenantsInput,
  ): Promise<OpenAiNativeSpeechDueTenantsResult> {
    if (
      !input
      || typeof input !== 'object'
      || (input.lane !== 'expiry' && input.lane !== 'retention')
      || !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_TENANTS
    ) return { status: 'unavailable' };
    try {
      const claimId = randomUUID();
      const rows = await this.withBoundedDirectory((tx) =>
        tx.$queryRaw<DueTenantRow[]>(Prisma.sql`
          SELECT due."companyId" AS "companyId", due."hasMore" AS "hasMore",
                 due."claimId" AS "claimId"
            FROM public.list_realtime_native_speech_maintenance_tenants_v1(
              ${input.lane}::text, ${input.limit}::integer, ${claimId}::uuid
            ) AS due
        `));
      const companyIds = rows.map((row) => row.companyId);
      const hasMore = rows[0]?.hasMore ?? false;
      const returnedClaimId = rows[0]?.claimId ?? null;
      if (
        companyIds.length > input.limit
        || companyIds.some((companyId) => !isRealtimeCompanyId(companyId))
        || new Set(companyIds).size !== companyIds.length
        || rows.some((row) => typeof row.hasMore !== 'boolean' || row.hasMore !== hasMore)
        || rows.some((row) => !UUID.test(row.claimId) || row.claimId !== returnedClaimId)
      ) {
        return { status: 'unavailable' };
      }
      return { status: 'succeeded', companyIds, hasMore, claimId: returnedClaimId };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async acknowledgeDueCompanyIds(
    input: OpenAiNativeSpeechMaintenanceClaimInput,
  ): Promise<OpenAiNativeSpeechClaimAckResult> {
    if (
      !input
      || typeof input !== 'object'
      || (input.lane !== 'expiry' && input.lane !== 'retention')
      || typeof input.claimId !== 'string'
      || !UUID.test(input.claimId)
    ) return { status: 'unavailable' };
    try {
      const [row] = await this.withBoundedDirectory((tx) =>
        tx.$queryRaw<ClaimAckRow[]>(Prisma.sql`
          SELECT public.ack_realtime_native_speech_maintenance_tenants_v1(
            ${input.lane}::text, ${input.claimId}::uuid
          ) AS acknowledged
        `));
      if (!row || typeof row.acknowledged !== 'boolean') return { status: 'unavailable' };
      return { status: 'succeeded', acknowledged: row.acknowledged };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async renewDueCompanyIdsClaim(
    input: OpenAiNativeSpeechMaintenanceClaimInput,
  ): Promise<OpenAiNativeSpeechClaimRenewResult> {
    if (
      !input
      || typeof input !== 'object'
      || (input.lane !== 'expiry' && input.lane !== 'retention')
      || typeof input.claimId !== 'string'
      || !UUID.test(input.claimId)
    ) return { status: 'unavailable' };
    try {
      const [row] = await this.withBoundedDirectory((tx) =>
        tx.$queryRaw<ClaimRenewRow[]>(Prisma.sql`
          SELECT public.renew_realtime_native_speech_maintenance_claim_v1(
            ${input.lane}::text, ${input.claimId}::uuid
          ) AS renewed
        `));
      if (!row || typeof row.renewed !== 'boolean') return { status: 'unavailable' };
      return { status: 'succeeded', renewed: row.renewed };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async reapExpired(
    input: OpenAiNativeSpeechMaintenanceInput,
  ): Promise<OpenAiNativeSpeechReapResult> {
    if (!validInput(input)) return { status: 'unavailable' };
    try {
      return await this.prisma.withIsolatedTenant(input.companyId, async (tx) => {
        const rows = await tx.$queryRaw<ReapedRow[]>(Prisma.sql`
          WITH locked AS MATERIALIZED (
            SELECT delivery."deliveryId", delivery.revision, delivery."expiresAt"
              FROM realtime_native_speech_deliveries AS delivery
             WHERE delivery."companyId" = ${input.companyId}
               AND delivery.phase NOT IN ('delivered', 'cancelled', 'failed', 'expired')
               AND delivery."expiresAt" <= statement_timestamp()
             ORDER BY delivery."expiresAt", delivery."deliveryId"
             FOR UPDATE OF delivery SKIP LOCKED
             LIMIT ${input.limit + 1}
          ), candidates AS MATERIALIZED (
            SELECT locked."deliveryId", locked.revision
              FROM locked
             ORDER BY locked."expiresAt", locked."deliveryId"
             LIMIT ${input.limit}
          ), updated AS (
          UPDATE realtime_native_speech_deliveries AS delivery
             SET revision = candidate.revision + 1,
                 phase = 'expired',
                 "terminalAt" = delivery."expiresAt"
            FROM candidates AS candidate
           WHERE delivery."companyId" = ${input.companyId}
             AND delivery."deliveryId" = candidate."deliveryId"
             AND delivery.revision = candidate.revision
          RETURNING delivery."deliveryId" AS "deliveryId", delivery.revision,
                    delivery.phase, delivery."expiresAt" AS "expiresAt",
                    delivery."terminalAt" AS "terminalAt"
          )
          SELECT updated.*,
                 ((SELECT COUNT(*) FROM locked) > ${input.limit}) AS "hasMore"
            FROM updated
        `);
        if (
          rows.length > input.limit
          || rows.some((row) => !validReapedRow(row) || row.hasMore !== rows[0]?.hasMore)
        ) {
          throw new Error('openai_native_delivery_reaper_projection_mismatch');
        }
        return {
          status: 'succeeded' as const,
          expiredCount: rows.length,
          hasMore: rows[0]?.hasMore ?? false,
        };
      }, MAINTENANCE_TRANSACTION_OPTIONS);
    } catch {
      return { status: 'unavailable' };
    }
  }

  async purgeRetained(
    input: OpenAiNativeSpeechMaintenanceInput,
  ): Promise<OpenAiNativeSpeechPurgeResult> {
    if (!validInput(input)) return { status: 'unavailable' };
    try {
      return await this.prisma.withIsolatedTenant(input.companyId, async (tx) => {
        const [summary] = await tx.$queryRaw<PurgeSummaryRow[]>(Prisma.sql`
          WITH locked AS MATERIALIZED (
            SELECT delivery."deliveryId", delivery."retentionExpiresAt"
              FROM realtime_native_speech_deliveries AS delivery
             WHERE delivery."companyId" = ${input.companyId}
               AND delivery.phase IN ('delivered', 'cancelled', 'failed', 'expired')
               AND delivery."retentionExpiresAt" <= statement_timestamp()
               AND NOT EXISTS (
                 SELECT 1
                   FROM realtime_control_grants AS control_grant
                  WHERE control_grant."companyId" = delivery."companyId"
                    AND control_grant."nativeDeliveryId" = delivery."deliveryId"
               )
             ORDER BY delivery."retentionExpiresAt", delivery."deliveryId"
             FOR UPDATE OF delivery SKIP LOCKED
             LIMIT ${input.limit + 1}
          ), candidates AS MATERIALIZED (
            SELECT locked."deliveryId"
              FROM locked
             ORDER BY locked."retentionExpiresAt", locked."deliveryId"
             LIMIT ${input.limit}
          ), deleted AS (
            DELETE FROM realtime_native_speech_deliveries AS delivery
             USING candidates AS candidate
             WHERE delivery."companyId" = ${input.companyId}
               AND delivery."deliveryId" = candidate."deliveryId"
            RETURNING delivery."deliveryId"
          )
          SELECT (SELECT COUNT(*)::integer FROM deleted) AS "purgedCount",
                 0::integer AS "dependenciesBlocked",
                 ((SELECT COUNT(*) FROM locked) > ${input.limit}) AS "hasMore"
        `);
        if (
          !summary
          || !Number.isSafeInteger(summary.purgedCount)
          || summary.purgedCount < 0
          || summary.purgedCount > input.limit
          || !Number.isSafeInteger(summary.dependenciesBlocked)
          || summary.dependenciesBlocked < 0
          || summary.dependenciesBlocked > input.limit
          || typeof summary.hasMore !== 'boolean'
        ) {
          throw new Error('openai_native_delivery_purge_projection_mismatch');
        }
        return {
          status: 'succeeded' as const,
          ...summary,
        };
      }, MAINTENANCE_TRANSACTION_OPTIONS);
    } catch {
      return { status: 'unavailable' };
    }
  }
}
