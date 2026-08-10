import { Prisma } from '@prisma/client';
import type { AccountIdentityDeletionRequestResult } from '@bob/core';
import {
  AUTH_USER_DELETION_ERROR_CODES,
  type AuthUserDeletionErrorCode,
  type AuthUserDeletionJobRepository,
  type ClaimedAuthUserDeletionJob,
} from '../auth-user-deletion-jobs';
import { PrismaService } from './prisma.service';
import { isCanonicalCompanyOwnerBinding } from '../../auth/company-owner-binding';

const GLOBAL_TRANSACTION_OPTIONS = { maxWaitMs: 1_000, timeoutMs: 4_000 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ERROR_CODE = new Set<string>(AUTH_USER_DELETION_ERROR_CODES);

interface RequestRow {
  outcome: 'accepted' | 'rejected';
  requestId: string | null;
  status: string | null;
  alreadyRequested: boolean | null;
  rejectionReason: string | null;
}

interface ClaimRow {
  id: string;
  companyId: string;
  userId: string;
  leaseToken: string;
  attempts: number;
}

interface BooleanRow {
  result: boolean;
}

type DatabaseClient = PrismaService | Prisma.TransactionClient;

/**
 * Adapter hybride : request est tenantée et participe à CloseAccount ; claim/ack/retry passent
 * uniquement par les RPC globales bornées possédées par l'autorité NOLOGIN.
 */
export class PrismaAuthUserDeletionJobRepository implements AuthUserDeletionJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async ensureRequested(input: {
    requestId: string;
    companyId: string;
    userId: string;
    requestedAt: string;
  }): Promise<AccountIdentityDeletionRequestResult> {
    void input.requestedAt; // Horloge autoritaire PostgreSQL.
    if (!this.prisma.inTransaction()) {
      throw new Error('auth_user_deletion_request_requires_tenant_transaction');
    }
    const tx = this.prisma.client();
    await this.installDatabaseTimeouts(tx);
    const rows = await tx.$queryRaw<RequestRow[]>(Prisma.sql`
      SELECT request.outcome,
             request."requestId" AS "requestId",
             request.status,
             request."alreadyRequested" AS "alreadyRequested",
             request."rejectionReason" AS "rejectionReason"
        FROM public.request_auth_user_deletion_v1(
          ${input.requestId}::uuid,
          ${input.companyId}::text,
          ${input.userId}::text
        ) AS request
    `);
    const row = rows[0];
    if (!row || rows.length !== 1) throw new Error('auth_user_deletion_request_projection_rejected');
    if (row.outcome === 'rejected') {
      if (
        row.requestId !== null ||
        row.status !== null ||
        row.alreadyRequested !== null ||
        (row.rejectionReason !== 'company_owner_binding_mismatch' &&
          row.rejectionReason !== 'active_cabinet_memberships')
      ) {
        throw new Error('auth_user_deletion_rejection_projection_rejected');
      }
      return { outcome: 'rejected', reason: row.rejectionReason };
    }
    if (
      row.outcome !== 'accepted' ||
      row.requestId === null ||
      !UUID.test(row.requestId) ||
      (row.status !== 'pending' && row.status !== 'failed' && row.status !== 'done') ||
      typeof row.alreadyRequested !== 'boolean' ||
      row.rejectionReason !== null
    ) {
      throw new Error('auth_user_deletion_acceptance_projection_rejected');
    }
    return {
      outcome: 'accepted',
      request: {
        requestId: row.requestId,
        status: row.status === 'done' ? 'done' : 'pending',
        alreadyRequested: row.alreadyRequested,
      },
    };
  }

  async claimDue(limit: number): Promise<readonly ClaimedAuthUserDeletionJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('auth_user_deletion_claim_limit_invalid');
    }
    return this.prisma.withIsolatedGlobal(async (tx) => {
      await this.installDatabaseTimeouts(tx);
      const rows = await tx.$queryRaw<ClaimRow[]>(Prisma.sql`
        SELECT claimed.id,
               claimed."companyId" AS "companyId",
               claimed."userId" AS "userId",
               claimed."leaseToken" AS "leaseToken",
               claimed.attempts
          FROM public.claim_auth_user_deletions_v1(${limit}::integer) AS claimed
      `);
      if (
        rows.length > limit ||
        rows.some(
          (row) =>
            !UUID.test(row.id) ||
            !isCanonicalCompanyOwnerBinding(row.userId, row.companyId) ||
            !UUID.test(row.leaseToken) ||
            !Number.isSafeInteger(row.attempts) ||
            row.attempts < 1,
        ) ||
        new Set(rows.map((row) => row.id)).size !== rows.length ||
        new Set(rows.map((row) => row.leaseToken)).size !== rows.length
      ) {
        throw new Error('auth_user_deletion_claim_projection_rejected');
      }
      return rows;
    }, GLOBAL_TRANSACTION_OPTIONS);
  }

  async markDone(id: string, leaseToken: string): Promise<boolean> {
    if (!UUID.test(id) || !UUID.test(leaseToken)) return false;
    return this.prisma.withIsolatedGlobal(async (tx) => {
      await this.installDatabaseTimeouts(tx);
      const rows = await tx.$queryRaw<BooleanRow[]>(Prisma.sql`
        SELECT public.complete_auth_user_deletion_v1(
          ${id}::uuid,
          ${leaseToken}::uuid
        ) AS result
      `);
      if (rows.length !== 1 || typeof rows[0]?.result !== 'boolean') {
        throw new Error('auth_user_deletion_complete_projection_rejected');
      }
      return rows[0].result;
    }, GLOBAL_TRANSACTION_OPTIONS);
  }

  async markFailed(
    id: string,
    leaseToken: string,
    errorCode: AuthUserDeletionErrorCode,
    retryDelayMs: number,
  ): Promise<boolean> {
    if (
      !UUID.test(id) ||
      !UUID.test(leaseToken) ||
      !ERROR_CODE.has(errorCode) ||
      !Number.isSafeInteger(retryDelayMs) ||
      retryDelayMs < 1_000 ||
      retryDelayMs > 120 * 60_000
    ) {
      return false;
    }
    return this.prisma.withIsolatedGlobal(async (tx) => {
      await this.installDatabaseTimeouts(tx);
      const rows = await tx.$queryRaw<BooleanRow[]>(Prisma.sql`
        SELECT public.retry_auth_user_deletion_v1(
          ${id}::uuid,
          ${leaseToken}::uuid,
          ${errorCode}::text,
          ${retryDelayMs}::integer
        ) AS result
      `);
      if (rows.length !== 1 || typeof rows[0]?.result !== 'boolean') {
        throw new Error('auth_user_deletion_retry_projection_rejected');
      }
      return rows[0].result;
    }, GLOBAL_TRANSACTION_OPTIONS);
  }

  /**
   * Les limites Prisma bornent le callback côté client, pas la statement déjà lancée dans
   * PostgreSQL. Ces GUC transaction-locales sont donc posées dans une statement préalable : elles
   * couvrent réellement la RPC suivante et, pour request, le reste de la clôture atomique.
   */
  private async installDatabaseTimeouts(tx: DatabaseClient): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_catalog.set_config('lock_timeout', '1s', true),
             pg_catalog.set_config('statement_timeout', '4s', true)
    `);
  }

}
