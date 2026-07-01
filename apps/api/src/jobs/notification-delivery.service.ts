import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MERCIER_PROPS, SystemClock, type Notification, type NotificationPort } from '@bob/core';
import { PERSISTENCE, type Persistence } from '../persistence/persistence';
import { type DeliverableNotificationJob, type NotificationJob } from '../persistence/notification-jobs';
import { NOTIFIER } from '../notifications/notifier';
import { AppLogger } from '../observability/logger';

function addMinutesIso(instant: string, minutes: number): string {
  const d = new Date(instant);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

function nextNotificationRetryAt(now: string, attempts: number): string {
  const delayMinutes = Math.min(120, Math.max(1, 2 ** attempts));
  return addMinutesIso(now, delayMinutes);
}

@Injectable()
export class NotificationDeliveryService {
  private readonly clock = new SystemClock();

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    @Inject(NOTIFIER) private readonly notifier: NotificationPort,
    private readonly logger: AppLogger,
  ) {}

  @Cron('*/5 * * * *')
  scheduled(): void {
    void this.runForCompany(MERCIER_PROPS.id, 10)
      .then((r) => {
        if (r.scanned > 0) this.logger.audit('notification.jobs.scheduled', r);
      })
      .catch((e: unknown) => {
        this.logger.warn(`Retry notifications inattendu: ${e instanceof Error ? e.message : String(e)}`, 'notifications');
      });
  }

  async enqueue(input: {
    companyId: string;
    kind: NotificationJob['kind'];
    dedupeKey: string;
    notification: Notification;
  }): Promise<NotificationJob> {
    const now = this.clock.now();
    return this.p.notificationJobs.enqueue({
      id: randomUUID(),
      companyId: input.companyId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      notification: input.notification,
      now,
    });
  }

  async tryDeliver(companyId: string, job: DeliverableNotificationJob): Promise<boolean> {
    return this.p.runWithTenant(companyId, async () => {
      try {
        await this.notifier.send(job.notification);
        await this.p.notificationJobs.markDone(job.id, this.clock.now());
        this.logger.audit('notification.job.done', {
          companyId,
          kind: job.kind,
          jobId: job.id,
          channel: job.channel,
          to: job.recipient,
          subject: job.subject,
        });
        return true;
      } catch (e) {
        const failedAt = this.clock.now();
        const cause = e instanceof Error ? e.message : String(e);
        await this.p.notificationJobs.markFailed(job.id, failedAt, nextNotificationRetryAt(failedAt, job.attempts), cause);
        this.logger.warn(`Notification en retry (${job.kind}): ${cause}`, 'notifications');
        return false;
      }
    });
  }

  async runForCompany(companyId: string, limit = 25): Promise<{ scanned: number; sent: number; failed: number }> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    return this.p.runWithTenant(companyId, async () => {
      const jobs = await this.p.notificationJobs.listDue(companyId, this.clock.now(), safeLimit);
      let sent = 0;
      let failed = 0;
      for (const job of jobs) {
        if (await this.tryDeliver(companyId, job)) sent += 1;
        else failed += 1;
      }
      return { scanned: jobs.length, sent, failed };
    });
  }

  run(): Promise<{ scanned: number; sent: number; failed: number }> {
    return this.runForCompany(MERCIER_PROPS.id, 25);
  }
}
