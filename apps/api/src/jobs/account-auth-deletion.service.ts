import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  SUPABASE_ADMIN,
  SupabaseUserDeletionError,
  type SupabaseAdminPort,
} from '../auth/supabase-admin';
import { AppLogger } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import type {
  AuthUserDeletionErrorCode,
  ClaimedAuthUserDeletionJob,
} from '../persistence/auth-user-deletion-jobs';

// 10 × timeout provider 12 s laisse plus de trois minutes de marge dans la lease SQL de 5 min.
export const AUTH_USER_DELETION_PAGE_SIZE = 10;
export const AUTH_USER_DELETION_MAX_PAGES_PER_SWEEP = 4;

export function nextAuthUserDeletionRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(7, Math.trunc(attempts) - 1));
  return Math.min(120 * 60_000, 2 ** exponent * 60_000);
}

export interface AccountAuthDeletionSweepSummary {
  readonly skipped: boolean;
  readonly claimed: number;
  readonly completed: number;
  readonly retried: number;
  readonly leaseLost: number;
  readonly operationalFailures: number;
}

/** Worker global borné : la persistance n'expose que les RPC claim/ack/retry à l'app runtime. */
@Injectable()
export class AccountAuthDeletionService {
  private running = false;

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    @Inject(SUPABASE_ADMIN) private readonly supabaseAdmin: SupabaseAdminPort,
    private readonly logger: AppLogger,
  ) {}

  @Cron('* * * * *')
  scheduled(): void {
    void this.run().catch(() => {
      // Le détail est volontairement fermé : aucune erreur provider ou identité dans les logs.
      this.logger.warn('Sweep de suppression Auth indisponible.', 'account-deletion');
    });
  }

  async run(): Promise<AccountAuthDeletionSweepSummary> {
    if (this.running) {
      return {
        skipped: true,
        claimed: 0,
        completed: 0,
        retried: 0,
        leaseLost: 0,
        operationalFailures: 0,
      };
    }
    this.running = true;
    let claimed = 0;
    let completed = 0;
    let retried = 0;
    let leaseLost = 0;
    let operationalFailures = 0;
    try {
      for (let page = 0; page < AUTH_USER_DELETION_MAX_PAGES_PER_SWEEP; page += 1) {
        const jobs = await this.p.authUserDeletionJobs.claimDue(AUTH_USER_DELETION_PAGE_SIZE);
        claimed += jobs.length;
        // Une page est entièrement tentée : l'échec d'un tenant ne court-circuite jamais les autres.
        for (const job of jobs) {
          try {
            const outcome = await this.attempt(job);
            if (outcome === 'completed') completed += 1;
            if (outcome === 'retried') retried += 1;
            if (outcome === 'lease_lost') leaseLost += 1;
          } catch {
            // Une panne de persistance laisse le job dû après expiration de sa lease. Elle ne doit
            // jamais empêcher les autres lignes déjà possédées par cette page d'être tentées.
            operationalFailures += 1;
            this.logger.warn('Ack de suppression Auth indisponible.', 'account-deletion');
          }
        }
        if (jobs.length < AUTH_USER_DELETION_PAGE_SIZE) break;
      }
      const summary = {
        skipped: false,
        claimed,
        completed,
        retried,
        leaseLost,
        operationalFailures,
      };
      if (claimed > 0) this.logger.audit('account.auth_deletion.sweep', summary);
      return summary;
    } finally {
      this.running = false;
    }
  }

  private async attempt(
    job: ClaimedAuthUserDeletionJob,
  ): Promise<'completed' | 'retried' | 'lease_lost'> {
    try {
      await this.supabaseAdmin.deleteUser(job.userId);
      const completed = await this.p.authUserDeletionJobs.markDone(job.id, job.leaseToken);
      if (!completed) {
        this.logger.audit('account.auth_deletion.lease_lost', {
          companyId: job.companyId,
          jobId: job.id,
          phase: 'complete',
        });
        return 'lease_lost';
      }
      this.logger.audit('account.auth_deletion.done', {
        companyId: job.companyId,
        jobId: job.id,
        attempts: job.attempts,
      });
      return 'completed';
    } catch (cause) {
      const errorCode: AuthUserDeletionErrorCode =
        cause instanceof SupabaseUserDeletionError ? cause.code : 'unknown';
      const persisted = await this.p.authUserDeletionJobs.markFailed(
        job.id,
        job.leaseToken,
        errorCode,
        nextAuthUserDeletionRetryDelayMs(job.attempts),
      );
      this.logger.audit('account.auth_deletion.retry', {
        companyId: job.companyId,
        jobId: job.id,
        attempts: job.attempts,
        errorCode,
        persisted,
      });
      return persisted ? 'retried' : 'lease_lost';
    }
  }
}
