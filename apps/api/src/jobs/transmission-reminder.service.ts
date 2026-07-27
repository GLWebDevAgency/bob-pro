import { Inject, Injectable } from '@nestjs/common';
import { invoiceTransmissionReminderDedupeKey } from './reminder-dedupe-keys';
export { invoiceTransmissionReminderDedupeKey, invoiceIdOfTransmissionReminderDedupeKey } from './reminder-dedupe-keys';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SystemClock, type Customer, type Invoice } from '@bob/core';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { SUPABASE_ADMIN, type SupabaseAdminPort } from '../auth/supabase-admin';
import { AppLogger } from '../observability/logger';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';

/**
 * PR-03 « Encaisser » — rappel de DÉPÔT portail/Chorus à J+2 (cas RATP EPIC : le dépôt Cegedim
 * oublié = 60 jours de délai perdus). Au cron 6 h : pour toute facture ÉMISE dont le client
 * facture par `chorus`/`portail` et dont AUCUN dépôt n'est déclaré (`transmission.depositedAt`
 * null) 2 jours après l'émission, UNE notification interne (fil + push miroir) rappelle le
 * dépôt. Règles :
 *  · UN SEUL rappel par facture, à vie — dedupeKey STABLE `invoice:{id}:transmission-reminder`
 *    (l'outbox déduplique, le cron peut repasser tous les jours sans bruit) ;
 *  · extinction par l'état réel : dépôt déclaré → plus jamais candidat ; et si la déclaration
 *    arrive APRÈS l'enqueue, la revalidation du worker ANNULE le job avant l'I/O provider ;
 *  · canal email : JAMAIS de rappel (l'envoi email a son propre chemin, PR-01/PR-02) ;
 *  · rappel INTERNE à l'artisan (e-mail du compte, pattern digest) — jamais un sortant client.
 */

const REMINDER_AFTER_DAYS = 2;
const COMPANY_ID_PREFIX = 'company-';

const MS_PER_DAY = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY,
  );
}

/** Candidate au rappel : émise (statut vivant, y compris déjà en retard — un dépôt oublié reste
 *  dû), canal dépôt, aucun dépôt déclaré, émission vieille d'au moins J+2. Fonction PURE. */
export function isTransmissionReminderDue(input: {
  invoice: Pick<Invoice, 'kind' | 'status' | 'number' | 'issuedAt' | 'transmission'>;
  billingChannelType: string | null;
  today: string;
}): boolean {
  const { invoice } = input;
  if (invoice.kind === 'credit_note') return false;
  if (invoice.number === null || invoice.issuedAt === null) return false;
  if (invoice.status !== 'issued' && invoice.status !== 'late') return false;
  if (input.billingChannelType !== 'chorus' && input.billingChannelType !== 'portail')
    return false;
  if (invoice.transmission?.depositedAt != null) return false;
  return daysBetween(invoice.issuedAt, input.today) >= REMINDER_AFTER_DAYS;
}

@Injectable()
export class TransmissionReminderService {
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
        `Rappels de dépôt interrompus: ${e instanceof Error ? e.message : String(e)}`,
        'transmission-reminder',
      );
    });
  }

  async runAll(): Promise<{ companies: number; queued: number; deduplicated: number }> {
    const companyIds = await this.tenants.listCompanyIds();
    let queued = 0;
    let deduplicated = 0;
    for (const companyId of companyIds) {
      try {
        const result = await this.runForCompany(companyId);
        queued += result.queued;
        deduplicated += result.deduplicated;
      } catch (e) {
        // Un tenant en échec ne prive jamais les autres de leurs rappels.
        this.logger.warn(
          `Rappel de dépôt indisponible pour company=${companyId}: ${e instanceof Error ? e.message : String(e)}`,
          'transmission-reminder',
        );
      }
    }
    this.logger.audit('transmission_reminders.run_all', {
      companies: companyIds.length,
      queued,
      deduplicated,
    });
    return { companies: companyIds.length, queued, deduplicated };
  }

  async runForCompany(companyId: string): Promise<{ queued: number; deduplicated: number }> {
    const today = this.clock.today();
    const due = await this.p.runWithTenant(companyId, async () => {
      const [invoices, customers] = await Promise.all([
        this.p.invoices.listByCompany(companyId),
        this.p.customers.listByCompany(companyId),
      ]);
      const channelByCustomer = new Map<string, string | null>(
        customers.map((c: Customer) => [c.id, c.billingChannel?.type ?? null]),
      );
      return invoices.filter((invoice: Invoice) =>
        isTransmissionReminderDue({
          invoice,
          billingChannelType: channelByCustomer.get(invoice.customerId) ?? null,
          today,
        }),
      );
    });
    if (due.length === 0) return { queued: 0, deduplicated: 0 };

    // Réseau Supabase HORS transaction tenant (même hygiène que le digest).
    const email = await this.accountEmail(companyId);
    if (email === null) {
      this.logger.audit('transmission_reminder.email_skipped', {
        companyId,
        reason: 'account_email_missing',
      });
      return { queued: 0, deduplicated: 0 };
    }

    let queued = 0;
    let deduplicated = 0;
    for (const invoice of due) {
      const number = invoice.number ?? invoice.id;
      const job = await this.p.runWithTenant(companyId, () =>
        this.notificationDelivery.enqueue({
          companyId,
          kind: 'invoice-transmission-reminder',
          dedupeKey: invoiceTransmissionReminderDedupeKey(invoice.id),
          notification: {
            channel: 'email',
            to: email,
            subject: `Facture ${number} — dépôt à faire`,
            body: [
              `La facture ${number} est émise depuis plus de ${REMINDER_AFTER_DAYS} jours, et aucun dépôt n'est déclaré sur le portail de votre client (Chorus Pro ou portail fournisseur).`,
              '',
              'Tant que la pièce n’est pas déposée, le délai de paiement ne court pas : chaque jour perdu ici est un jour d’encaissement en moins.',
              '',
              'Ouvrez la facture dans Bob, suivez le guide de dépôt, puis déclarez « Déposée le » — ce rappel s’éteindra de lui-même.',
            ].join('\n'),
          },
        }),
      );
      // `done` = rappel déjà livré un jour précédent (clé stable) — un seul rappel, jamais deux.
      if (job.status === 'done') deduplicated += 1;
      else queued += 1;
    }
    this.logger.audit('transmission_reminders.run', { companyId, queued, deduplicated });
    return { queued, deduplicated };
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
