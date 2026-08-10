import { randomUUID } from 'node:crypto';
import { isCanonicalCompanyOwnerBinding } from '../auth/company-owner-binding';
import {
  acceptedDeletionRequest,
  authUserDeletionSubjectHash,
  type AuthUserDeletionErrorCode,
  type AuthUserDeletionJob,
  type AuthUserDeletionJobRepository,
  type ClaimedAuthUserDeletionJob,
} from './auth-user-deletion-jobs';

type Snapshot = {
  rows: AuthUserDeletionJob[];
  blockingUserIds: string[];
};

/** Double transactionnel explicite ; le harness Persistence orchestre snapshot/restore. */
export class InMemoryAuthUserDeletionJobRepository implements AuthUserDeletionJobRepository {
  private readonly rows = new Map<string, AuthUserDeletionJob>();
  private readonly blockingUserIds = new Set<string>();

  setBlockingCabinetMembership(userId: string, blocking: boolean): void {
    if (blocking) this.blockingUserIds.add(userId);
    else this.blockingUserIds.delete(userId);
  }

  async ensureRequested(input: {
    requestId: string;
    companyId: string;
    userId: string;
    requestedAt: string;
  }) {
    if (!isCanonicalCompanyOwnerBinding(input.userId, input.companyId)) {
      return { outcome: 'rejected' as const, reason: 'company_owner_binding_mismatch' as const };
    }
    if (this.blockingUserIds.has(input.userId)) {
      return { outcome: 'rejected' as const, reason: 'active_cabinet_memberships' as const };
    }
    const subjectHash = authUserDeletionSubjectHash(input.userId);
    const existing = [...this.rows.values()].find(
      (row) => row.provider === 'supabase' && row.subjectHash === subjectHash,
    );
    if (existing) return acceptedDeletionRequest(existing, true);
    const created: AuthUserDeletionJob = {
      id: input.requestId,
      companyId: input.companyId,
      provider: 'supabase',
      userId: input.userId,
      subjectHash,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: input.requestedAt,
      leaseToken: null,
      lastErrorCode: null,
      completedAt: null,
      createdAt: input.requestedAt,
      updatedAt: input.requestedAt,
    };
    this.rows.set(created.id, created);
    return acceptedDeletionRequest(created, false);
  }

  async claimDue(limit: number): Promise<readonly ClaimedAuthUserDeletionJob[]> {
    const now = new Date().toISOString();
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return [...this.rows.values()]
      .filter((row) => (row.status === 'pending' || row.status === 'failed') && row.userId !== null)
      .filter((row) => row.nextAttemptAt <= now)
      .sort((left, right) =>
        left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.id.localeCompare(right.id),
      )
      .slice(0, safeLimit)
      .map((row) => {
        const leaseToken = randomUUID();
        const claimed: AuthUserDeletionJob = {
          ...row,
          attempts: row.attempts + 1,
          leaseToken,
          nextAttemptAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          updatedAt: now,
        };
        this.rows.set(row.id, claimed);
        return {
          id: row.id,
          companyId: row.companyId,
          userId: row.userId!,
          leaseToken,
          attempts: claimed.attempts,
        };
      });
  }

  async markDone(id: string, leaseToken: string): Promise<boolean> {
    const row = this.rows.get(id);
    const now = new Date().toISOString();
    if (
      !row ||
      row.leaseToken !== leaseToken ||
      row.status === 'done' ||
      row.nextAttemptAt <= now
    ) {
      return false;
    }
    this.rows.set(id, {
      ...row,
      userId: null,
      status: 'done',
      leaseToken: null,
      lastErrorCode: null,
      completedAt: now,
      nextAttemptAt: now,
      updatedAt: now,
    });
    return true;
  }

  async markFailed(
    id: string,
    leaseToken: string,
    errorCode: AuthUserDeletionErrorCode,
    retryDelayMs: number,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    const now = new Date().toISOString();
    if (
      !row ||
      row.leaseToken !== leaseToken ||
      row.status === 'done' ||
      row.nextAttemptAt <= now
    ) {
      return false;
    }
    const safeDelayMs = Math.max(1_000, Math.min(120 * 60_000, Math.trunc(retryDelayMs)));
    this.rows.set(id, {
      ...row,
      status: 'failed',
      leaseToken: null,
      lastErrorCode: errorCode,
      nextAttemptAt: new Date(Date.parse(now) + safeDelayMs).toISOString(),
      updatedAt: now,
    });
    return true;
  }

  async findByCompanyId(companyId: string): Promise<AuthUserDeletionJob | null> {
    const row = [...this.rows.values()].find((candidate) => candidate.companyId === companyId);
    return row ? { ...row } : null;
  }

  snapshot(): Snapshot {
    return {
      rows: [...this.rows.values()].map((row) => ({ ...row })),
      blockingUserIds: [...this.blockingUserIds],
    };
  }

  restore(snapshot: Snapshot): void {
    this.rows.clear();
    for (const row of snapshot.rows) this.rows.set(row.id, { ...row });
    this.blockingUserIds.clear();
    for (const userId of snapshot.blockingUserIds) this.blockingUserIds.add(userId);
  }
}
