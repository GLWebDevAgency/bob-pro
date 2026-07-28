import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  SystemClock,
  deriveAnnualBillingDue,
  deriveRenewalAlerts,
  formatDateOnlyFr,
  type ContractScheduleData,
  type MaintenanceContract,
} from '@bob/core';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { SUPABASE_ADMIN, type SupabaseAdminPort } from '../auth/supabase-admin';
import { AppLogger } from '../observability/logger';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';
import {
  contractAnnualInvoiceReminderDedupeKey,
  contractRenewalReminderDedupeKey,
} from './reminder-dedupe-keys';

/**
 * PR-13 « Le métier » — alertes de renouvellement de contrat (Bloc B §2.5). Au cron 6 h, le
 * service MATÉRIALISE des NotificationJob — il ne mute JAMAIS un état métier (doctrine §0 :
 * la reconduction tacite est un fait dérivé, aucune écriture contrat par un cron) :
 *  · `contract-renewal-reminder` — J-60/J-30 avant le prochain anniversaire CALCULÉ ; UN
 *    palier, le plus récent pertinent (amélioration 14 : deriveRenewalAlerts ne rend que
 *    lui — au réveil après une panne, jamais J-60 ET J-30 d'un coup, les paliers passés ne
 *    se rattrapent pas) ; clé `contract:{id}:renewal:{anniversaire}:{palier}` — la fenêtre
 *    revit chaque année (anniversaire différent) ;
 *  · `contract-annual-invoice-reminder` — « facture annuelle à émettre » dérivée
 *    (deriveAnnualBillingDue, fenêtre −30 j vivante TOUTES les années — annexe erratum
 *    n° 3) ; clé `contract:{id}:annual-invoice:{débutDePériode}` — dédup annuelle naturelle.
 * Règles :
 *  · alerte INTERNE à l'artisan (e-mail du compte, pattern digest/transmission-reminder) —
 *    JAMAIS un envoi client ;
 *  · extinction par l'état réel : contrat résilié → plus jamais candidat, et la revalidation
 *    du worker ANNULE tout job en attente avant l'I/O provider (staleDeliveryReason) ;
 *  · [annexe erratum n° 8] les factures de TOUS les contrats viennent d'UNE requête batchée
 *    par société (listContractInvoicesByCompany) — jamais N requêtes par contrat.
 */

const COMPANY_ID_PREFIX = 'company-';

function scheduleOf(contract: MaintenanceContract): ContractScheduleData {
  const props = contract.toProps();
  return {
    status: props.status,
    anniversaryDate: props.anniversaryDate,
    tacitRenewal: props.tacitRenewal,
    importCoveredUntil: props.importCoveredUntil,
    terminationEffectiveDate: props.terminationEffectiveDate,
  };
}

@Injectable()
export class ContractRenewalService {
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
        `Alertes de renouvellement interrompues: ${e instanceof Error ? e.message : String(e)}`,
        'contract-renewal',
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
        // Un tenant en échec ne prive jamais les autres de leurs alertes.
        this.logger.warn(
          `Alertes de renouvellement indisponibles pour company=${companyId}: ${e instanceof Error ? e.message : String(e)}`,
          'contract-renewal',
        );
      }
    }
    this.logger.audit('contract_renewals.run_all', {
      companies: companyIds.length,
      queued,
      deduplicated,
    });
    return { companies: companyIds.length, queued, deduplicated };
  }

  /** `today` injectable (tests pluriannuels) — le cron passe la date réelle. */
  async runForCompany(
    companyId: string,
    today: string = this.clock.today(),
  ): Promise<{ queued: number; deduplicated: number }> {
    // [Erratum n° 8] UNE requête batchée pour les factures de TOUS les contrats du tenant.
    const { contracts, projectionsByContract } = await this.p.runWithTenant(companyId, async () => {
      const [allContracts, grouped] = await Promise.all([
        this.p.maintenanceContracts.listByCompany(companyId),
        this.p.contractInvoices.listContractInvoicesByCompany(companyId),
      ]);
      return { contracts: allContracts, projectionsByContract: grouped };
    });
    // Extinction si résilié : un contrat non `active` n'est JAMAIS candidat (les dérivations
    // le refusent aussi — double rail, même verdict).
    const active = contracts.filter((contract) => contract.status === 'active');
    if (active.length === 0) return { queued: 0, deduplicated: 0 };

    // Réseau Supabase HORS transaction tenant (même hygiène que le digest). Alerte INTERNE :
    // le destinataire est TOUJOURS l'e-mail du compte — jamais un client.
    const email = await this.accountEmail(companyId);
    if (email === null) {
      this.logger.audit('contract_renewal.email_skipped', {
        companyId,
        reason: 'account_email_missing',
      });
      return { queued: 0, deduplicated: 0 };
    }

    let queued = 0;
    let deduplicated = 0;
    for (const contract of active) {
      const schedule = scheduleOf(contract);
      const noticeDays = contract.toProps().noticeDays;
      const alert = deriveRenewalAlerts(schedule, today);
      if (alert !== null) {
        const job = await this.p.runWithTenant(companyId, () =>
          this.notificationDelivery.enqueue({
            companyId,
            kind: 'contract-renewal-reminder',
            dedupeKey: contractRenewalReminderDedupeKey(contract.id, alert.anniversary, alert.palier),
            notification: {
              channel: 'email',
              to: email,
              subject: alert.tacit
                ? `Contrat ${contract.label} — se reconduit dans ${alert.daysUntil} jours`
                : `Contrat ${contract.label} — arrive à échéance dans ${alert.daysUntil} jours`,
              body: [
                // Date FRANÇAISE (formatDateOnlyFr, @bob/core) comme sur toutes les autres
                // surfaces : l'artisan ne lit pas du AAAA-MM-JJ, et ce rappel est justement
                // là où il décide d'appeler son client.
                alert.tacit
                  ? `Le contrat « ${contract.label} » se reconduit tacitement le ${formatDateOnlyFr(alert.anniversary)} (dans ${alert.daysUntil} jours).`
                  : `Le contrat « ${contract.label} » arrive à échéance le ${formatDateOnlyFr(alert.anniversary)} (dans ${alert.daysUntil} jours) — sans reconduction tacite, il faudra le renouveler ou le laisser s'éteindre.`,
                '',
                `Préavis prévu au contrat : ${noticeDays} jours. C'est le moment d'appeler le client si quelque chose doit bouger (prix, périmètre, résiliation).`,
                '',
                'Rappel interne Bob — rien n’a été envoyé à votre client.',
              ].join('\n'),
            },
          }),
        );
        if (job.status === 'done') deduplicated += 1;
        else queued += 1;
      }

      const due = deriveAnnualBillingDue(
        schedule,
        projectionsByContract.get(contract.id) ?? [],
        today,
      );
      if (due !== null) {
        const job = await this.p.runWithTenant(companyId, () =>
          this.notificationDelivery.enqueue({
            companyId,
            kind: 'contract-annual-invoice-reminder',
            dedupeKey: contractAnnualInvoiceReminderDedupeKey(contract.id, due.period.start),
            notification: {
              channel: 'email',
              to: email,
              subject: `Contrat ${contract.label} — facture annuelle à émettre`,
              body: [
                `La période du ${formatDateOnlyFr(due.period.start)} n'est pas encore facturée pour le contrat « ${contract.label} ».`,
                due.cancelledCoveringNumber !== null
                  ? `La facture ${due.cancelledCoveringNumber} qui la couvrait a été annulée : la période est à re-facturer.`
                  : '',
                '',
                'Ouvrez la fiche du contrat dans Bob et touchez « Préparer la facture annuelle » — un brouillon sera prêt, rien ne part sans vous.',
                '',
                'Rappel interne Bob — rien n’a été envoyé à votre client.',
              ]
                .filter((line, index, lines) => !(line === '' && lines[index - 1] === ''))
                .join('\n'),
            },
          }),
        );
        if (job.status === 'done') deduplicated += 1;
        else queued += 1;
      }
    }
    this.logger.audit('contract_renewals.run', { companyId, queued, deduplicated });
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
