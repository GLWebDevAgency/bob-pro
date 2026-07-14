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
import { BackendService } from '../backend.service';

/** Port ÉTROIT de l'autorité d'abonnement vue par le cron — satisfait structurellement par
 *  BackendService (token DI), stubable en une ligne dans les tests (jamais tout le backend). */
export interface AutoDunningEntitlements {
  autoDunningEntitlement(companyId: string): { allowed: boolean; plan: import('@bob/core').PlanTier };
}
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';

/**
 * Version de la politique d'envoi automatique. Elle fait partie de la clé de déduplication :
 * une facture ne reçoit qu'un message par palier, même si le cron tourne tous les jours.
 * À incrémenter uniquement si la cadence ou la copy change assez pour justifier un nouvel envoi.
 */
const RELANCE_POLICY_VERSION = 'v1';

/**
 * Relances automatiques (C25). UNE SEULE politique fait foi : DEFAULT_RELANCE_POLICY de
 * @bob/core (deriveRelancePlan — J+3 cordial · J+10 neutre · J+20 ferme · J+30 mise en demeure),
 * le MÊME moteur que l'écran mobile et que l'agent (fini le toneForDaysLate local 15/30/45).
 * Le cron envoie cordial → ferme ; la MISE EN DEMEURE (régime légal du type de client — P01 :
 * b2b L441-10 + 40 €, b2c code civil sans 40 €, b2g CCP BCE+8 + 40 €) n'est JAMAIS envoyée sans
 * validation explicite (garde-fou proto/relance.medWarning) : elle attend le déclenchement ciblé
 * POST /invoices/:id/relance (sendRelanceForInvoice).
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
    // Autorité d'abonnement (subscriptionFor est LE point unique, backend.service.ts) — token
    // DI = la classe, type = le port étroit : le cron ne voit QUE l'entitlement.
    @Inject(BackendService) private readonly backend: AutoDunningEntitlements,
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
      // Le type pilote le régime de la mise en demeure (P01 C-EXP1) : la projection {id,name}
      // qui l'écrasait envoyait L441-10 + 40 € à des particuliers — non-conformité corrigée.
      customers: customers.map((c: Customer) => ({ id: c.id, name: c.name, type: c.type })),
      today: this.clock.today(),
    });
    const emails = new Map(customers.map((c) => [c.id, c.toProps().email ?? null]));
    return { plan, emails };
  }

  /**
   * Enfile la relance dans l'outbox transactionnelle. Aucun réseau tiers n'a lieu ici :
   * le worker NotificationDelivery ne verra le job qu'après commit et le livrera avec
   * l'idempotencyKey persistée. `done` signifie qu'un job dédupliqué a déjà été livré.
   */
  private async dispatchEntry(
    companyId: string,
    entry: RelancePlanEntry,
    email: string,
    source: 'automatic' | 'manual',
  ): Promise<{ jobId: string; status: 'done' | 'pending' | 'failed' }> {
    const today = this.clock.today();
    const dedupeKey =
      source === 'automatic'
        ? `invoice:${entry.invoiceId}:relance:auto:${RELANCE_POLICY_VERSION}:${entry.tone}`
        : `invoice:${entry.invoiceId}:relance:manual:${today}`;
    const message = source === 'automatic' ? entry.automaticMessage : entry.message;
    const job = await this.notificationDelivery.enqueue({
      companyId,
      kind: 'invoice-relance',
      dedupeKey,
      notification: { channel: 'email', to: email, subject: message.subject, body: message.body },
    });
    if (job.status === 'done') return { jobId: job.id, status: 'done' }; // déjà relancée aujourd'hui (dédup)
    if (job.notification === null) return { jobId: job.id, status: job.status === 'failed' ? 'failed' : 'pending' };
    return { jobId: job.id, status: 'pending' };
  }

  async runRelancesForCompany(
    companyId: string,
  ): Promise<{ scanned: number; queued: number; sent: number; deduplicated: number }> {
    // Enforcement serveur `auto_dunning` (Pro+, PLAN_CATALOG) : le batch automatique SAUTE le
    // tenant sans erreur — refus audité, comportement du cron inchangé pour les autres tenants.
    // La relance MANUELLE (sendRelanceForInvoice) n'est pas gated : auto_dunning = relance AUTO.
    // En early-access (business pour tous), ce garde ne refuse personne aujourd'hui.
    const entitlement = this.backend.autoDunningEntitlement(companyId);
    if (!entitlement.allowed) {
      this.logger.audit('relances.skipped_plan', {
        companyId,
        plan: entitlement.plan,
        feature: 'auto_dunning',
      });
      return { scanned: 0, queued: 0, sent: 0, deduplicated: 0 };
    }
    return this.p.runWithTenant(companyId, async () => {
      const { plan, emails } = await this.planForCompany(companyId);
      let queued = 0;
      const sent = 0; // ce job ne livre jamais : seul NotificationDelivery incrémente les envois
      let deduplicated = 0;
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
        const dispatched = await this.dispatchEntry(companyId, entry, email, 'automatic');
        if (dispatched.status === 'pending') queued += 1;
        if (dispatched.status === 'done') deduplicated += 1;
      }
      this.logger.audit('relances.run', { scanned: plan.length, queued, sent, deduplicated });
      return { scanned: plan.length, queued, sent, deduplicated };
    });
  }

  /**
   * ENVOI CIBLÉ, validé par l'utilisateur (C25 ② — POST /invoices/:id/relance : le contrat
   * BobClient.sendRelance devient réel). Tous les tons sont permis ici : le geste EST la
   * validation (y compris la mise en demeure, au régime du type de client). Refus honnête sinon.
   */
  /** Variante requête HTTP : tenant du Principal authentifié (même règle que BackendService —
   * C24b : tenant OBLIGATOIRE, le repli société de démo est supprimé). */
  sendRelance(invoiceId: string): Promise<Result<{ jobId: string; status: string; tone: string }, AppError>> {
    return this.sendRelanceForInvoice(requireTenant(), invoiceId);
  }

  /** Variante du job HTTP : strictement limitée au tenant du JWT courant. Le parcours global
   * reste réservé au cron interne (`scheduled`), jamais à une requête utilisateur. */
  runRelancesForCurrentTenant(): Promise<{
    scanned: number;
    queued: number;
    sent: number;
    deduplicated: number;
  }> {
    return this.runRelancesForCompany(requireTenant());
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
      const dispatched = await this.dispatchEntry(companyId, entry, email, 'manual');
      this.logger.audit('relance.queued_manual', {
        invoiceId,
        tone: entry.tone,
        jobId: dispatched.jobId,
        status: dispatched.status,
      });
      return ok({ jobId: dispatched.jobId, status: dispatched.status, tone: entry.tone });
    });
  }

  async runRelances(): Promise<{
    companies: number;
    scanned: number;
    queued: number;
    sent: number;
    deduplicated: number;
  }> {
    const companyIds = await this.tenants.listCompanyIds();
    let scanned = 0;
    let queued = 0;
    let sent = 0;
    let deduplicated = 0;
    for (const companyId of companyIds) {
      const result = await this.runRelancesForCompany(companyId);
      scanned += result.scanned;
      queued += result.queued;
      sent += result.sent;
      deduplicated += result.deduplicated;
    }
    this.logger.audit('relances.run_all', { companies: companyIds.length, scanned, queued, sent, deduplicated });
    return { companies: companyIds.length, scanned, queued, sent, deduplicated };
  }
}
