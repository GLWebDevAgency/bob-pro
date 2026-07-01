import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SystemClock, buildRelance, type RelanceTone } from '@bob/core';
import { PERSISTENCE, type Persistence } from '../persistence/persistence';
import { AppLogger } from '../observability/logger';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00.000Z`).getTime();
  const db = new Date(`${b}T00:00:00.000Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}

function toneForDaysLate(days: number): RelanceTone {
  if (days >= 45) return 'miseendemeure';
  if (days >= 30) return 'ferme';
  if (days >= 15) return 'neutre';
  return 'cordial';
}

/** Relances automatiques. V1 : cron in-process (@nestjs/schedule). Prod : BullMQ/Redis (même port). */
@Injectable()
export class RelanceService {
  private readonly clock = new SystemClock();

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    private readonly notificationDelivery: NotificationDeliveryService,
    private readonly tenants: ScheduledTenantDirectory,
    private readonly logger: AppLogger,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  scheduled(): void {
    void this.runRelances();
  }

  async runRelancesForCompany(companyId: string): Promise<{ scanned: number; sent: number }> {
    const today = this.clock.today();
    return this.p.runWithTenant(companyId, async () => {
      const invoices = await this.p.invoices.listByCompany(companyId);
      let sent = 0;
      for (const inv of invoices) {
        const overdue =
          (inv.status === 'issued' || inv.status === 'partially_paid' || inv.status === 'late') &&
          inv.dueAt !== null &&
          inv.dueAt < today;
        if (!overdue || inv.dueAt === null) continue;
        const daysLate = daysBetween(inv.dueAt, today);
        const customer = await this.p.customers.findById(inv.customerId);
        const email = customer?.toProps().email;
        if (!email) {
          this.logger.audit('relance.email_skipped', { invoiceId: inv.id, reason: 'customer_email_missing' });
          continue;
        }
        const message = buildRelance({
          customerName: customer?.name ?? 'le client',
          docNumber: inv.number ?? '',
          amountCents: inv.totals().netToPay - inv.paid,
          daysLate,
          tone: toneForDaysLate(daysLate),
          personality: 'Pote',
        });
        const job = await this.notificationDelivery.enqueue({
          companyId: inv.companyId,
          kind: 'invoice-relance',
          dedupeKey: `invoice:${inv.id}:relance:${today}`,
          notification: { channel: 'email', to: email, subject: message.subject, body: message.body },
        });
        if (job.status !== 'done' && job.notification !== null && (await this.notificationDelivery.tryDeliver(inv.companyId, { ...job, notification: job.notification }))) {
          sent += 1;
        }
      }
      this.logger.audit('relances.run', { scanned: invoices.length, sent });
      return { scanned: invoices.length, sent };
    });
  }

  async runRelances(): Promise<{ companies: number; scanned: number; sent: number }> {
    const companyIds = await this.tenants.listCompanyIds();
    let scanned = 0;
    let sent = 0;
    for (const companyId of companyIds) {
      const result = await this.runRelancesForCompany(companyId);
      scanned += result.scanned;
      sent += result.sent;
    }
    this.logger.audit('relances.run_all', { companies: companyIds.length, scanned, sent });
    return { companies: companyIds.length, scanned, sent };
  }
}
