import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SystemClock, type Notification, type NotificationPort } from '@bob/core';
import { PERSISTENCE, type Persistence } from '../persistence/persistence';
import { type DeliverableNotificationJob, type NotificationJob } from '../persistence/notification-jobs';
import { NOTIFIER } from '../notifications/notifier';
import { EXPO_PUSH, type ExpoPushService } from '../notifications/expo-push';
import { notificationRoute } from '../notifications/notification-route';
import { AppLogger } from '../observability/logger';
import { ScheduledTenantDirectory } from './tenant-directory';

function addMinutesIso(instant: string, minutes: number): string {
  const d = new Date(instant);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

function nextNotificationRetryAt(now: string, attempts: number): string {
  const delayMinutes = Math.min(120, Math.max(1, 2 ** attempts));
  return addMinutesIso(now, delayMinutes);
}

/** Corps de push : l'email peut être long — on tronque proprement pour la bannière. */
function pushBody(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= 178 ? flat : `${flat.slice(0, 177)}…`;
}

@Injectable()
export class NotificationDeliveryService {
  private readonly clock = new SystemClock();

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    @Inject(NOTIFIER) private readonly notifier: NotificationPort,
    private readonly tenants: ScheduledTenantDirectory,
    private readonly logger: AppLogger,
    // Optionnel pour compat tests/hôtes historiques : sans service push, le canal est simplement absent (loggé).
    @Optional() @Inject(EXPO_PUSH) private readonly push: ExpoPushService | null = null,
  ) {}

  @Cron('*/5 * * * *')
  scheduled(): void {
    void this.runAllCompanies(10)
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
        // Push Expo (C25) : MIROIR de l'envoi RÉUSSI vers les appareils de l'artisan — jamais
        // avant (on ne notifie pas « Bob a relancé X » si l'email a échoué). Best-effort loggé.
        await this.pushMirror(companyId, job);
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

  /** Notifie les devices du tenant (chunké côté ExpoPushService) — échecs par ticket loggés,
   * tokens invalidés purgés, absence d'appareil tracée (jamais silencieux). Ne lève pas. */
  private async pushMirror(companyId: string, job: DeliverableNotificationJob): Promise<void> {
    if (!this.push) {
      this.logger.audit('notification.push.skipped', { companyId, jobId: job.id, reason: 'push_channel_absent' });
      return;
    }
    const devices = await this.p.devices.listByCompany(companyId);
    if (devices.length === 0) {
      this.logger.audit('notification.push.skipped', { companyId, jobId: job.id, reason: 'no_device_registered' });
      return;
    }
    const route = notificationRoute(job);
    const outcome = await this.push.send(
      devices.map((d) => ({
        to: d.expoPushToken,
        title: job.subject,
        body: pushBody(job.notification.body),
        ...(route !== null ? { data: { route } } : {}),
      })),
    );
    for (const rejection of outcome.rejected) {
      // Token expiré/désinstallé : purge — la table devices reste un reflet fidèle du parc.
      if (rejection.error === 'DeviceNotRegistered') {
        await this.p.devices.removeByToken(companyId, rejection.token);
      }
    }
    this.logger.audit('notification.push.sent', {
      companyId,
      jobId: job.id,
      devices: devices.length,
      accepted: outcome.accepted,
      rejected: outcome.rejected.length,
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

  async runAllCompanies(limitPerCompany = 25): Promise<{ companies: number; scanned: number; sent: number; failed: number }> {
    const companyIds = await this.tenants.listCompanyIds();
    let scanned = 0;
    let sent = 0;
    let failed = 0;
    for (const companyId of companyIds) {
      const result = await this.runForCompany(companyId, limitPerCompany);
      scanned += result.scanned;
      sent += result.sent;
      failed += result.failed;
    }
    return { companies: companyIds.length, scanned, sent, failed };
  }

  run(): Promise<{ companies: number; scanned: number; sent: number; failed: number }> {
    return this.runAllCompanies(25);
  }
}
