import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SystemClock, buildRelance, MERCIER_PROPS, type NotificationPort, type RelanceTone } from '@bob/core';
import { PERSISTENCE, type Persistence } from '../persistence/persistence';
import { NOTIFIER } from '../notifications/notifier';
import { AppLogger } from '../observability/logger';

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
    @Inject(NOTIFIER) private readonly notifier: NotificationPort,
    private readonly logger: AppLogger,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  scheduled(): void {
    void this.runRelances();
  }

  async runRelances(): Promise<{ scanned: number; sent: number }> {
    const today = this.clock.today();
    const invoices = await this.p.invoices.listByCompany(MERCIER_PROPS.id);
    let sent = 0;
    for (const inv of invoices) {
      const overdue =
        (inv.status === 'issued' || inv.status === 'partially_paid' || inv.status === 'late') &&
        inv.dueAt !== null &&
        inv.dueAt < today;
      if (!overdue || inv.dueAt === null) continue;
      const daysLate = daysBetween(inv.dueAt, today);
      const customer = await this.p.customers.findById(inv.customerId);
      const message = buildRelance({
        customerName: customer?.name ?? 'le client',
        docNumber: inv.number ?? '',
        amountCents: inv.totals().netToPay - inv.paid,
        daysLate,
        tone: toneForDaysLate(daysLate),
        personality: 'Pote',
      });
      await this.notifier.send({ channel: 'email', to: customer?.name ?? 'client', subject: message.subject, body: message.body });
      sent += 1;
    }
    this.logger.audit('relances.run', { scanned: invoices.length, sent });
    return { scanned: invoices.length, sent };
  }
}
