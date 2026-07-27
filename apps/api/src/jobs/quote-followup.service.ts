import { Inject, Injectable } from '@nestjs/common';
import { quoteRelanceReminderDedupeKey } from './reminder-dedupe-keys';
export { quoteRelanceReminderDedupeKey, quoteIdOfQuoteRelanceReminderDedupeKey } from './reminder-dedupe-keys';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ExpireQuote,
  SystemClock,
  parisDateOnly,
  quoteRelancePalierOf,
  type Customer,
  type Quote,
} from '@bob/core';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { SUPABASE_ADMIN, type SupabaseAdminPort } from '../auth/supabase-admin';
import { AppLogger } from '../observability/logger';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';

/**
 * PR-05 « Encaisser » — suivi de vie des DEVIS au cron 6 h :
 *  1. SWEEP d'expiration : la bascule `expired` cesse d'être lazy — tout devis sent/viewed dont
 *     `validUntil` est dépassé (calendrier MÉTIER Europe/Paris) passe par ExpireQuote (le MÊME
 *     use case que la bascule à la volée : borne Paris, révocation des liens de signature).
 *     Idempotent : un devis déjà expiré n'est plus candidat.
 *  2. RAPPELS de relance par palier (J+15/J+30 ancrés sur `issuedAt` RÉEL — legacy sans date
 *     exclu fail-closed, même dérivation pure quoteRelancePalierOf que la carte Aujourd'hui) :
 *     notification INTERNE dédupliquée PAR PALIER (`quote:{id}:relance-reminder:{palier}`) —
 *     la relance au client reste MANUELLE (pré-rédigée en un tap, jamais envoyée seule).
 *     Extinction par l'état réel : signé/refusé/expiré n'est plus candidat, et une transition
 *     survenue entre l'enqueue et la livraison ANNULE le job (revalidation du worker).
 */

const COMPANY_ID_PREFIX = 'company-';

@Injectable()
export class QuoteFollowupService {
  private readonly clock = new SystemClock();

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    private readonly notificationDelivery: NotificationDeliveryService,
    private readonly tenants: ScheduledTenantDirectory,
    @Inject(SUPABASE_ADMIN) private readonly supabaseAdmin: SupabaseAdminPort,
    private readonly logger: AppLogger,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  scheduled(): void {
    void this.runAll().catch((e: unknown) => {
      this.logger.warn(
        `Suivi des devis interrompu: ${e instanceof Error ? e.message : String(e)}`,
        'quote-followup',
      );
    });
  }

  async runAll(): Promise<{
    companies: number;
    expired: number;
    reminders: number;
    deduplicated: number;
  }> {
    const companyIds = await this.tenants.listCompanyIds();
    let expired = 0;
    let reminders = 0;
    let deduplicated = 0;
    for (const companyId of companyIds) {
      try {
        const result = await this.runForCompany(companyId);
        expired += result.expired;
        reminders += result.reminders;
        deduplicated += result.deduplicated;
      } catch (e) {
        // Un tenant en échec ne prive jamais les autres de leur suivi.
        this.logger.warn(
          `Suivi des devis indisponible pour company=${companyId}: ${e instanceof Error ? e.message : String(e)}`,
          'quote-followup',
        );
      }
    }
    this.logger.audit('quote_followup.run_all', {
      companies: companyIds.length,
      expired,
      reminders,
      deduplicated,
    });
    return { companies: companyIds.length, expired, reminders, deduplicated };
  }

  async runForCompany(companyId: string): Promise<{
    expired: number;
    reminders: number;
    deduplicated: number;
  }> {
    // 1) Sweep d'expiration AVANT les rappels : un devis périmé ce matin ne sera jamais
    //    « à relancer » le même matin.
    const expired = await this.sweepExpiredQuotes(companyId);

    // 2) Paliers atteints — même dérivation pure que la carte Aujourd'hui.
    const today = parisDateOnly(this.clock.now());
    const due = await this.p.runWithTenant(companyId, async () => {
      const quotes = await this.p.quotes.listByCompany(companyId);
      return quotes
        .map((quote: Quote) => ({
          quote,
          reached: quoteRelancePalierOf({ status: quote.status, issuedAt: quote.issuedAt }, today),
        }))
        .filter(
          (candidate): candidate is { quote: Quote; reached: NonNullable<typeof candidate.reached> } =>
            candidate.reached !== null,
        );
    });
    if (due.length === 0) {
      if (expired > 0) this.logger.audit('quote_followup.run', { companyId, expired, reminders: 0 });
      return { expired, reminders: 0, deduplicated: 0 };
    }

    // Rappel INTERNE à l'artisan (pattern digest/PR-03) — jamais un sortant client.
    const email = await this.accountEmail(companyId);
    if (email === null) {
      this.logger.audit('quote_followup.email_skipped', {
        companyId,
        reason: 'account_email_missing',
      });
      return { expired, reminders: 0, deduplicated: 0 };
    }

    const names = await this.p.runWithTenant(companyId, async () => {
      const customers = await this.p.customers.listByCompany(companyId);
      return new Map(customers.map((c: Customer) => [c.id, c.name]));
    });

    let reminders = 0;
    let deduplicated = 0;
    for (const { quote, reached } of due) {
      const number = quote.number ?? quote.id;
      const customerName = names.get(quote.customerId) ?? 'votre client';
      const job = await this.p.runWithTenant(companyId, () =>
        this.notificationDelivery.enqueue({
          companyId,
          kind: 'quote-relance-reminder',
          dedupeKey: quoteRelanceReminderDedupeKey(quote.id, reached.palier),
          notification: {
            channel: 'email',
            to: email,
            subject: `Devis ${number} sans réponse depuis ${reached.daysSinceIssued} jours`,
            body: [
              `Le devis ${number} (${customerName}) est sans réponse depuis ${reached.daysSinceIssued} jours.`,
              '',
              'Une relance courtoise multiplie les chances de signature. Ouvrez le devis dans Bob : un message pré-rédigé vous attend — rien ne part sans votre geste.',
            ].join('\n'),
          },
        }),
      );
      if (job.status === 'done') deduplicated += 1;
      else reminders += 1;
    }
    this.logger.audit('quote_followup.run', { companyId, expired, reminders, deduplicated });
    return { expired, reminders, deduplicated };
  }

  /** Sweep quotidien : la bascule `expired` cesse d'être lazy (le MÊME use case ExpireQuote,
   *  borne calendrier Paris, révocation des liens). Idempotent — déjà expiré = plus candidat. */
  private async sweepExpiredQuotes(companyId: string): Promise<number> {
    const today = parisDateOnly(this.clock.now());
    const candidates = await this.p.runWithTenant(companyId, async () => {
      const quotes = await this.p.quotes.listByCompany(companyId);
      return quotes.filter(
        (quote: Quote) =>
          (quote.status === 'sent' || quote.status === 'viewed') &&
          quote.validUntil !== null &&
          quote.validUntil < today,
      );
    });
    let expired = 0;
    for (const quote of candidates) {
      const result = await this.p.runWithTenant(companyId, () =>
        new ExpireQuote({
          quotes: this.p.quotes,
          publicAccessTokens: this.p.publicAccessTokens,
          uow: this.p,
          clock: this.clock,
        }).execute({ quoteId: quote.id }),
      );
      if (result.ok) expired += 1;
      else {
        // Course avec une signature/bascule concurrente : refus honnête du use case, tracé.
        this.logger.audit('quote_followup.expire_skipped', {
          companyId,
          quoteId: quote.id,
        });
      }
    }
    return expired;
  }

  /** E-mail du COMPTE propriétaire (pattern digest) — rappel interne, jamais un sortant client. */
  private async accountEmail(companyId: string): Promise<string | null> {
    if (!companyId.startsWith(COMPANY_ID_PREFIX)) return null;
    const userId = companyId.slice(COMPANY_ID_PREFIX.length);
    if (userId === '' || this.supabaseAdmin.getUserIdentity === undefined) return null;
    try {
      const identity = await this.supabaseAdmin.getUserIdentity(userId);
      return identity.email;
    } catch {
      return null;
    }
  }
}
