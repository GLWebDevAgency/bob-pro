import { createHash } from 'node:crypto';
import type {
  AccountIdentityDeletionOutboxPort,
  AccountIdentityDeletionRequestResult,
} from '@bob/core';

export const AUTH_USER_DELETION_ERROR_CODES = [
  'network',
  'timeout',
  'http_408',
  'http_429',
  'http_4xx',
  'http_5xx',
  'misconfigured',
  'unknown',
] as const;

export const AUTH_USER_DELETION_JOB_STATUSES = ['pending', 'failed', 'done'] as const;

export type AuthUserDeletionErrorCode = (typeof AUTH_USER_DELETION_ERROR_CODES)[number];
export type AuthUserDeletionJobStatus = (typeof AUTH_USER_DELETION_JOB_STATUSES)[number];

export interface AuthUserDeletionJob {
  readonly id: string;
  readonly companyId: string;
  readonly provider: 'supabase';
  readonly userId: string | null;
  /** Donnée pseudonyme de reçu et de fence Cabinet, jamais présentée comme anonyme. */
  readonly subjectHash: string;
  readonly status: AuthUserDeletionJobStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly leaseToken: string | null;
  readonly lastErrorCode: AuthUserDeletionErrorCode | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClaimedAuthUserDeletionJob {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly leaseToken: string;
  readonly attempts: number;
}

export interface AuthUserDeletionJobRepository extends AccountIdentityDeletionOutboxPort {
  /** Capacité globale bornée : chaque ligne retournée porte sa propre lease. */
  claimDue(limit: number): Promise<readonly ClaimedAuthUserDeletionJob[]>;
  /** CAS sur la génération exacte ; false signifie lease perdue ou job déjà finalisé. */
  markDone(id: string, leaseToken: string): Promise<boolean>;
  /** L'erreur est une classe fermée ; le délai est borné par l'adapter. */
  markFailed(
    id: string,
    leaseToken: string,
    errorCode: AuthUserDeletionErrorCode,
    retryDelayMs: number,
  ): Promise<boolean>;
}

export const AUTH_USER_DELETION_HASH_DOMAIN = 'bob.auth-user-deletion.v1\0';

export function authUserDeletionSubjectHash(userId: string): string {
  return createHash('sha256').update(AUTH_USER_DELETION_HASH_DOMAIN).update(userId).digest('hex');
}

export function acceptedDeletionRequest(
  job: Pick<AuthUserDeletionJob, 'id' | 'status'>,
  alreadyRequested: boolean,
): AccountIdentityDeletionRequestResult {
  return {
    outcome: 'accepted',
    request: {
      requestId: job.id,
      status: job.status === 'done' ? 'done' : 'pending',
      alreadyRequested,
    },
  };
}
