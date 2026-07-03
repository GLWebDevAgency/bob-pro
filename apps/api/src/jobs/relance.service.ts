import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  SystemClock,
  deriveRelancePlan,
  ok,
  appNotFound,
  type AppError,
  type Customer,
  type Invoice,
  type RelancePlanEntry,
  type Result,
} from '@bob/core';
import { PERSISTENCE, type Persistence } from '../persistence/persistence';
import { AppLogger, requireTenant } from '../observability/logger';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';

/**
 * Relances automatiques (C25). UNE SEULE politique fait foi : DEFAULT_RELANCE_POLICY de
 * @bob/core (deriveRelancePlan — J+3 cordial · J+10 neutre · J+20 ferme · J+30 mise en demeure),
 * le MÊME moteur que l'écran mobile et que l'agent (fini le toneForDaysLate local 15/30/45).
 * Le cron envoie cordial → ferme ; la MISE EN DEMEURE (L441-10 + indemnité 40 €) n'est JAMAIS
 * envoyée sans validation explicite (garde-fou proto/relance.medWarning) : elle attend le
 * déclenchement ciblé POST /invoices/:id/relance (sendRelanceForInvoice).
 * V1 : cron in-process (@nestjs/schedule). Prod : BullMQ/Redis (même port).
 */
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

  /** Projections agrégats → moteur core (mêmes champs que les vues api-client du mobile). */
  private async planForCompany(
    companyId: string,
  ): Promise<{ plan: RelancePlanEntry[]; emails: Map<string, string | null> }> {
    const [invoices, customers] = await Promise.all([
      this.p.invoices.listByCompany(companyId),
      this.p.customers.listByCompany(companyId),
    ]);
    const plan = deriveRelancePlan({
      invoices: invoices.map((i: Invoice) => ({
        id: i.id,
        customerId: i.customerId,
        kind: i.kind,
        status: i.status,
        number: i.number,
        parentQuoteId: i.parentQuoteId,
        totals: i.totals(),
        dueAt: i.dueAt,
        paid: i.paid,
      })),
      customers: customers.map((c: Customer) => ({ id: c.id, name: c.name })),
      today: this.clock.today(),
    });
    const emails = new Map(customers.map((c) => [c.id, c.toProps().email ?? null]));
    return { plan, emails };
  }

  /** Enfile la relance d'une entrée du plan puis tente la livraison immédiate (email + miroir push). */
  private async dispatchEntry(
    companyId: string,
    entry: RelancePlanEntry,
    email: string,
  ): Promise<{ jobId: string; status: 'done' | 'pending' | 'failed' }> {
    const today = this.clock.today();
    const job = await this.notificationDelivery.enqueue({
      companyId,
      kind: 'invoice-relance',
      dedupeKey: `invoice:${entry.invoiceId}:relance:${today}`,
      notification: { channel: 'email', to: email, subject: entry.message.subject, body: entry.message.body },
    });
    if (job.status === 'done') return { jobId: job.id, status: 'done' }; // déjà relancée aujourd'hui (dédup)
    if (job.notification === null) return { jobId: job.id, status: job.status === 'failed' ? 'failed' : 'pending' };
    const delivered = await this.notificationDelivery.tryDeliver(companyId, { ...job, notification: job.notification });
    return { jobId: job.id, status: delivered ? 'done' : 'failed' };
  }

  async runRelancesForCompany(companyId: string): Promise<{ scanned: number; sent: number }> {
    return this.p.runWithTenant(companyId, async () => {
      const { plan, emails } = await this.planForCompany(companyId);
      let sent = 0;
      for (const entry of plan) {
        if (!entry.dueNow) continue; // palier pas encore atteint : planifiée, pas due
        if (entry.tone === 'miseendemeure') {
          // Garde-fou (proto + copy relance.medWarning) : mise en demeure = validation humaine
          // obligatoire → POST /invoices/:id/relance. Le cron trace, n'envoie pas.
          this.logger.audit('relance.med_awaiting_validation', {
            invoiceId: entry.invoiceId,
            daysLate: entry.daysLate,
          });
          continue;
        }
        const email = emails.get(entry.customerId);
        if (!email) {
          this.logger.audit('relance.email_skipped', { invoiceId: entry.invoiceId, reason: 'customer_email_missing' });
          continue;
        }
        const dispatched = await this.dispatchEntry(companyId, entry, email);
        if (dispatched.status === 'done') sent += 1;
      }
      this.logger.audit('relances.run', { scanned: plan.length, sent });
      return { scanned: plan.length, sent };
    });
  }

  /**
   * ENVOI CIBLÉ, validé par l'utilisateur (C25 ② — POST /invoices/:id/relance : le contrat
   * BobClient.sendRelance devient réel). Tous les tons sont permis ici : le geste EST la
   * validation (y compris la mise en demeure L441-10). Refus honnête sinon.
   */
  /** Variante requête HTTP : tenant du Principal authentifié (même règle que BackendService —
   * C24b : tenant OBLIGATOIRE, le repli société de démo est supprimé). */
  sendRelance(invoiceId: string): Promise<Result<{ jobId: string; status: string; tone: string }, AppError>> {
    return this.sendRelanceForInvoice(requireTenant(), invoiceId);
  }

  async sendRelanceForInvoice(
    companyId: string,
    invoiceId: string,
  ): Promise<Result<{ jobId: string; status: string; tone: string }, AppError>> {
    return this.p.runWithTenant(companyId, async () => {
      const { plan, emails } = await this.planForCompany(companyId);
      const entry = plan.find((e) => e.invoiceId === invoiceId);
      if (!entry) {
        const invoice = await this.p.invoices.findById(invoiceId);
        if (!invoice || invoice.companyId !== companyId) {
          return { ok: false as const, error: appNotFound('invoice', invoiceId) };
        }
        return {
          ok: false as const,
          error: {
            kind: 'validation' as const,
            issues: [{ field: 'invoiceId', message: 'Facture non relançable — réglée, annulée ou pas encore échue.' }],
          },
        };
      }
      const email = emails.get(entry.customerId);
      if (!email) {
        return {
          ok: false as const,
          error: {
            kind: 'validation' as const,
            issues: [{ field: 'customer.email', message: 'Email du client manquant — complète sa fiche avant de relancer.' }],
          },
        };
      }
      const dispatched = await this.dispatchEntry(companyId, entry, email);
      this.logger.audit('relance.sent_manual', {
        invoiceId,
        tone: entry.tone,
        jobId: dispatched.jobId,
        status: dispatched.status,
      });
      return ok({ jobId: dispatched.jobId, status: dispatched.status, tone: entry.tone });
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
