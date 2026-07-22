import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { isRealtimeCompanyId } from './realtime-admission';
import {
  REALTIME_REAPER_DIRECTORY_MAX_TENANTS,
  type RealtimeReaperDirectoryAckResult,
  type RealtimeReaperDirectoryClaimInput,
  type RealtimeReaperDirectoryListInput,
  type RealtimeReaperDirectoryListResult,
  type RealtimeReaperDirectoryPort,
  type RealtimeReaperDirectoryRenewResult,
} from './realtime-reaper-directory';

const DIRECTORY_TRANSACTION_OPTIONS = { maxWaitMs: 1_000, timeoutMs: 4_000 } as const;
const DIRECTORY_STATEMENT_TIMEOUT = '3s';
const DIRECTORY_LOCK_TIMEOUT = '1s';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface DueTenantRow {
  readonly companyId: string;
  readonly hasMore: boolean;
  readonly claimId: string;
}

interface BooleanResultRow {
  readonly result: boolean;
}

interface DirectoryTimeoutRow {
  readonly statementTimeout: string;
  readonly lockTimeout: string;
}

function validClaim(input: RealtimeReaperDirectoryClaimInput): boolean {
  return typeof input === 'object'
    && input !== null
    && typeof input.claimId === 'string'
    && UUID.test(input.claimId);
}

/**
 * Adapter global borné. Les fonctions appelées sont SECURITY DEFINER et détenues par un rôle
 * NOLOGIN en lecture seule sur les leases ; le rôle runtime ne peut jamais lire la table globale
 * du curseur ni contourner les mutations tenantées.
 */
export class PrismaRealtimeReaperDirectory implements RealtimeReaperDirectoryPort {
  constructor(private readonly prisma: PrismaService) {}

  private withBoundedDirectory<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withIsolatedGlobal(async (tx) => {
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
      ) throw new Error('realtime_reaper_directory_timeout_fence_rejected');
      return operation(tx);
    }, DIRECTORY_TRANSACTION_OPTIONS);
  }

  async listDueCompanyIds(
    input: RealtimeReaperDirectoryListInput,
  ): Promise<RealtimeReaperDirectoryListResult> {
    if (
      !input
      || typeof input !== 'object'
      || !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > REALTIME_REAPER_DIRECTORY_MAX_TENANTS
    ) return { status: 'unavailable' };
    try {
      const requestedClaimId = randomUUID();
      return await this.withBoundedDirectory(async (tx) => {
        const rows = await tx.$queryRaw<DueTenantRow[]>(Prisma.sql`
          SELECT due."companyId" AS "companyId", due."hasMore" AS "hasMore",
                 due."claimId" AS "claimId"
            FROM public.list_realtime_reaper_tenants_v1(
              ${input.limit}::integer, ${requestedClaimId}::uuid
            ) AS due
        `);
        const companyIds = rows.map((row) => row.companyId);
        const hasMore = rows[0]?.hasMore ?? false;
        const returnedClaimId = rows[0]?.claimId ?? null;
        // Une page persistée est immuable et peut avoir été créée avant un downgrade 100 -> 25.
        // Elle reste sûre jusqu'au plafond absolu ; la nouvelle limite s'applique à la page suivante.
        if (
          companyIds.length > REALTIME_REAPER_DIRECTORY_MAX_TENANTS
          || companyIds.some((companyId) => !isRealtimeCompanyId(companyId))
          || new Set(companyIds).size !== companyIds.length
          || rows.some((row) => typeof row.hasMore !== 'boolean' || row.hasMore !== hasMore)
          || rows.some((row) => !UUID.test(row.claimId) || row.claimId !== returnedClaimId)
          || (returnedClaimId !== null && returnedClaimId !== requestedClaimId)
        ) throw new Error('realtime_reaper_directory_projection_rejected');
        return { status: 'succeeded' as const, companyIds, hasMore, claimId: returnedClaimId };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async renewClaim(
    input: RealtimeReaperDirectoryClaimInput,
  ): Promise<RealtimeReaperDirectoryRenewResult> {
    if (!validClaim(input)) return { status: 'unavailable' };
    try {
      return await this.withBoundedDirectory(async (tx) => {
        const [row] = await tx.$queryRaw<BooleanResultRow[]>(Prisma.sql`
          SELECT public.renew_realtime_reaper_tenants_claim_v1(
            ${input.claimId}::uuid
          ) AS result
        `);
        if (!row || typeof row.result !== 'boolean') {
          throw new Error('realtime_reaper_directory_renew_projection_rejected');
        }
        return { status: 'succeeded' as const, renewed: row.result };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async acknowledgeClaim(
    input: RealtimeReaperDirectoryClaimInput,
  ): Promise<RealtimeReaperDirectoryAckResult> {
    if (!validClaim(input)) return { status: 'unavailable' };
    try {
      return await this.withBoundedDirectory(async (tx) => {
        const [row] = await tx.$queryRaw<BooleanResultRow[]>(Prisma.sql`
          SELECT public.ack_realtime_reaper_tenants_v1(
            ${input.claimId}::uuid
          ) AS result
        `);
        if (!row || typeof row.result !== 'boolean') {
          throw new Error('realtime_reaper_directory_ack_projection_rejected');
        }
        return { status: 'succeeded' as const, acknowledged: row.result };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }
}
