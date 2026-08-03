import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  SystemClock,
  deriveAnnualBillingDue,
  deriveRenewalAlerts,
  parisDateOnly,
  type Notification,
  type NotificationPort,
} from '@bob/core';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import {
  NotificationPayloadContractUnavailableError,
  isLegacyNotificationPayloadSealed,
  notificationPayloadFingerprint,
  quoteIdOfEmbargoScheduledPaymentDedupeKey,
  type DeliverableNotificationJob,
  type NotificationJob,
} from '../persistence/notification-jobs';
import {
  contractAnnualInvoiceReminderDedupeKeyParts,
  contractRenewalReminderDedupeKeyParts,
  invoiceIdOfTransmissionReminderDedupeKey,
  quoteIdOfQuoteRelanceReminderDedupeKey,
} from './reminder-dedupe-keys';
import { NOTIFIER } from '../notifications/notifier';
import { EXPO_PUSH, type ExpoPushService } from '../notifications/expo-push';
import { AppLogger } from '../observability/logger';
import { ScheduledTenantDirectory } from './tenant-directory';

function addMinutesIso(instant: string, minutes: number): string {
  const d = new Date(instant);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

function nextNotificationRetryDelayMs(attempts: number): number {
  const delayMinutes = Math.min(120, Math.max(1, 2 ** attempts));
  return delayMinutes * 60_000;
}

/** Un device non réconcilié depuis 30 jours sort du canal, même sans tombstone mobile. */
const PUSH_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const PRIVATE_PUSH_TITLE = 'Nouvelle notification';
const PRIVATE_PUSH_BODY = 'Ouvrez l’application pour consulter le détail.';
const PRIVATE_PUSH_ROUTE = '/notifications';

function activeBindingCutoff(now: string): string {
  return new Date(Date.parse(now) - PUSH_BINDING_TTL_MS).toISOString();
}

type DeliveryAttemptOutcome = 'sent' | 'skipped' | 'failed';

@Injectable()
export class NotificationDeliveryService {
  /** Release A : le worker V1 ne sait livrer que le payload historique scellé. Cette capacité
   * bascule à true avec la release V3, jamais via un faux succès `queued`. */
  supportsExtendedPayloads(): boolean {
    return false;
  }

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
        this.logger.warn(
          `Retry notifications inattendu: ${e instanceof Error ? e.message : String(e)}`,
          'notifications',
        );
      });
  }

  async enqueue(input: {
    companyId: string;
    kind: NotificationJob['kind'];
    dedupeKey: string;
    notification: Notification;
    /** Livraison PLANIFIÉE (première tentative à cet instant) — encaissement J+7 embargo L221-10. */
    notBefore?: string;
  }): Promise<NotificationJob> {
    if (
      !isLegacyNotificationPayloadSealed(
        input.notification,
        notificationPayloadFingerprint(input.notification),
      )
    ) {
      throw new NotificationPayloadContractUnavailableError();
    }
    const now = this.clock.now();
    const id = randomUUID();
    // La clé provider est créée UNE fois avec l'entrée d'outbox et persiste sur tous les
    // retries. Brevo déduplique 30 min ; au-delà, un lease orphelin est mis en quarantaine
    // pour revue humaine plutôt que rejoué avec une promesse d'exactly-once impossible.
    const notification: Notification =
      input.notification.channel === 'email'
        ? { ...input.notification, idempotencyKey: id }
        : { ...input.notification };
    return this.p.notificationJobs.enqueue({
      id,
      companyId: input.companyId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      notification,
      now,
      ...(input.notBefore !== undefined ? { notBefore: input.notBefore } : {}),
    });
  }

  async tryDeliver(
    companyId: string,
    job: DeliverableNotificationJob,
  ): Promise<DeliveryAttemptOutcome> {
    const claimAt = this.clock.now();
    const leaseUntil = addMinutesIso(claimAt, 5);
    const leaseToken = randomUUID();
    let claimedJob: DeliverableNotificationJob;
    try {
      const claim = await this.p.runWithTenant(companyId, () =>
        this.p.notificationJobs.claimForDelivery(
          job.id,
          companyId,
          job.updatedAt,
          claimAt,
          leaseUntil,
          leaseToken,
        ),
      );
      if (claim.outcome === 'quarantined') {
        this.logger.warn(
          `Notification en revue manuelle (${job.kind}): résultat provider incertain`,
          'notifications',
        );
        this.logger.audit('notification.job.quarantined', {
          companyId,
          kind: job.kind,
          jobId: job.id,
          reason: claim.reason,
        });
        return 'failed';
      }
      if (claim.outcome === 'skipped') {
        this.logger.audit('notification.job.claim_skipped', {
          companyId,
          kind: job.kind,
          jobId: job.id,
        });
        return 'skipped';
      }
      claimedJob = claim.job;
    } catch (e) {
      this.logger.warn(
        `Lease notification impossible (${job.kind}): ${e instanceof Error ? e.message : String(e)}`,
        'notifications',
      );
      return 'failed';
    }

    let authorized: boolean;
    try {
      authorized = await this.p.runWithTenant(companyId, () =>
        this.p.notificationJobs.authorizeDeliveryAttempt(
          claimedJob.id,
          companyId,
          leaseToken,
          this.clock.now(),
        ),
      );
    } catch (e) {
      // Une indisponibilité DB au dernier fence ne doit ni déclencher l'I/O provider, ni
      // interrompre tout le sweep. Le lease expirera et un prochain worker arbitrera avec
      // l'horloge DB entre reprise encore sûre et quarantaine.
      this.logger.warn(
        `Autorisation notification impossible (${claimedJob.kind}): ${e instanceof Error ? e.message : String(e)}`,
        'notifications',
      );
      return 'failed';
    }
    if (!authorized) {
      this.logger.audit('notification.job.delivery_not_authorized', {
        companyId,
        kind: claimedJob.kind,
        jobId: claimedJob.id,
      });
      return 'skipped';
    }
    // REVALIDATION MÉTIER par kind, juste avant l'I/O provider : un job planifié (J+7) est un
    // payload FIGÉ — le monde a pu changer entre la programmation et l'échéance. Fail-closed :
    // toute invalidation ANNULE le job (cancelClaimed, par le détenteur du lease) au lieu de
    // livrer aveuglément. Aucun contenu n'est jamais réécrit (payload immuable).
    try {
      const staleReason = await this.staleDeliveryReason(companyId, claimedJob);
      if (staleReason !== null) {
        const cancelled = await this.p.runWithTenant(companyId, () =>
          this.p.notificationJobs.cancelClaimed(
            claimedJob.id,
            companyId,
            leaseToken,
            this.clock.now(),
          ),
        );
        this.logger.audit('notification.job.cancelled', {
          companyId,
          kind: claimedJob.kind,
          jobId: claimedJob.id,
          reason: staleReason,
          cancelled,
        });
        return 'skipped';
      }
    } catch (e) {
      // Indisponibilité pendant la revalidation : ne pas livrer un contenu potentiellement
      // périmé, ne pas casser le sweep — le lease expirera, un prochain worker re-jugera.
      this.logger.warn(
        `Revalidation notification impossible (${claimedJob.kind}): ${e instanceof Error ? e.message : String(e)}`,
        'notifications',
      );
      return 'failed';
    }
    try {
      // Appel réseau hors transaction : le job/outbox est déjà commité et porte une clé
      // provider stable. Aucun lock/GUC Postgres ne reste ouvert pendant Brevo.
      await this.notifier.send(claimedJob.notification);
      const wonDelivery = await this.p.runWithTenant(companyId, () =>
        this.p.notificationJobs.markDone(claimedJob.id, companyId, leaseToken, this.clock.now()),
      );
      if (!wonDelivery) {
        this.logger.audit('notification.job.finish_skipped', {
          companyId,
          kind: claimedJob.kind,
          jobId: claimedJob.id,
          reason: 'lease_lost',
        });
        return 'skipped';
      }
      this.logger.audit('notification.job.done', {
        companyId,
        kind: claimedJob.kind,
        jobId: claimedJob.id,
        channel: claimedJob.channel,
      });
      // Seul le worker qui a atomiquement transitionné le job vers done émet le push miroir.
      // Les concurrents peuvent recevoir l'accusé Brevo dédupliqué, mais ne doublent pas le push.
      if (wonDelivery) {
        try {
          await this.pushMirror(companyId, claimedJob);
        } catch (pushError) {
          this.logger.warn(
            `Push miroir ignoré après email commité: ${pushError instanceof Error ? pushError.message : String(pushError)}`,
            'notifications',
          );
        }
      }
      return 'sent';
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      await this.p.runWithTenant(companyId, async () => {
        await this.p.notificationJobs.markFailed(
          claimedJob.id,
          companyId,
          leaseToken,
          this.clock.now(),
          nextNotificationRetryDelayMs(claimedJob.attempts),
          cause,
        );
      });
      this.logger.warn(`Notification en retry (${claimedJob.kind}): ${cause}`, 'notifications');
      return 'failed';
    }
  }

  /**
   * Garde de PÉREMPTION par kind — null = livraison légitime, sinon la raison d'annulation.
   * `embargo-scheduled-payment` (invite de paiement J+7, embargo L221-10) est annulé si :
   *  • le devis a été RÉTRACTÉ depuis la programmation (L221-25 : rien n'est dû — demander le
   *    paiement à un consommateur rétracté contredirait l'accusé D221-5 et exposerait
   *    l'artisan à la qualification de pratique trompeuse/agressive) ;
   *  • un paiement a DÉJÀ été reçu sur une pièce dérivée du devis (override + encaissement
   *    anticipé) : jamais une seconde demande d'un montant déjà payé ;
   *  • le devis est introuvable dans le tenant (fail-closed).
   */
  private async staleDeliveryReason(
    companyId: string,
    job: DeliverableNotificationJob,
  ): Promise<string | null> {
    // PR-05 — rappel de relance devis : si le devis a QUITTÉ sent/viewed (signé, refusé,
    // expiré, rétracté) entre l'enqueue et la livraison, le rappel est périmé — annulé.
    if (job.kind === 'quote-relance-reminder') {
      const quoteId = quoteIdOfQuoteRelanceReminderDedupeKey(job.dedupeKey);
      if (quoteId === null) return 'dedupe-key-unrecognized';
      return this.p.runWithTenant(companyId, async () => {
        const quote = await this.p.quotes.findById(quoteId);
        if (!quote || quote.companyId !== companyId) return 'quote-missing';
        if (quote.status !== 'sent' && quote.status !== 'viewed') return 'quote-no-longer-open';
        return null;
      });
    }
    // PR-03 — rappel de dépôt : si le dépôt a été DÉCLARÉ entre l'enqueue et la livraison,
    // le rappel est périmé — annulé, jamais livré (extinction par l'état réel).
    if (job.kind === 'invoice-transmission-reminder') {
      const invoiceId = invoiceIdOfTransmissionReminderDedupeKey(job.dedupeKey);
      if (invoiceId === null) return 'dedupe-key-unrecognized';
      return this.p.runWithTenant(companyId, async () => {
        const invoice = await this.p.invoices.findById(invoiceId);
        if (!invoice || invoice.companyId !== companyId) return 'invoice-missing';
        if (invoice.transmission?.depositedAt != null) return 'transmission-deposited';
        return null;
      });
    }
    // PR-13 — alerte de renouvellement : EXTINCTION si le contrat a été résilié entre
    // l'enqueue et la livraison, ou si l'alerte dérivée ne correspond plus au palier de la
    // clé (amélioration 14 : après une panne, seul le palier LE PLUS RÉCENT pertinent part).
    if (job.kind === 'contract-renewal-reminder') {
      const parts = contractRenewalReminderDedupeKeyParts(job.dedupeKey);
      if (parts === null) return 'dedupe-key-unrecognized';
      return this.p.runWithTenant(companyId, async () => {
        const contract = await this.p.maintenanceContracts.findById(companyId, parts.contractId);
        if (!contract || contract.companyId !== companyId) return 'contract-missing';
        if (contract.status !== 'active') return 'contract-no-longer-active';
        const props = contract.toProps();
        const alert = deriveRenewalAlerts(
          {
            status: props.status,
            anniversaryDate: props.anniversaryDate,
            tacitRenewal: props.tacitRenewal,
            importCoveredUntil: props.importCoveredUntil,
            terminationEffectiveDate: props.terminationEffectiveDate,
          },
          parisDateOnly(this.clock.now()),
        );
        if (alert === null || alert.anniversary !== parts.anniversary || alert.palier !== parts.palier)
          return 'renewal-alert-no-longer-current';
        return null;
      });
    }
    // PR-13 — rappel « facture annuelle à émettre » : EXTINCTION si la période n'est plus
    // due (facture émise entre-temps, importCoveredUntil, contrat résilié) — dérivation
    // IDENTIQUE à l'écran et à la voix, lecture des factures du SEUL contrat concerné.
    if (job.kind === 'contract-annual-invoice-reminder') {
      const parts = contractAnnualInvoiceReminderDedupeKeyParts(job.dedupeKey);
      if (parts === null) return 'dedupe-key-unrecognized';
      return this.p.runWithTenant(companyId, async () => {
        const contract = await this.p.maintenanceContracts.findById(companyId, parts.contractId);
        if (!contract || contract.companyId !== companyId) return 'contract-missing';
        const props = contract.toProps();
        const projections = await this.p.contractInvoices.listByMaintenanceContract(
          companyId,
          parts.contractId,
        );
        const due = deriveAnnualBillingDue(
          {
            status: props.status,
            anniversaryDate: props.anniversaryDate,
            tacitRenewal: props.tacitRenewal,
            importCoveredUntil: props.importCoveredUntil,
            terminationEffectiveDate: props.terminationEffectiveDate,
          },
          projections,
          parisDateOnly(this.clock.now()),
        );
        if (due === null || due.period.start !== parts.periodStart)
          return 'annual-invoice-no-longer-due';
        return null;
      });
    }
    if (job.kind !== 'embargo-scheduled-payment') return null;
    const quoteId = quoteIdOfEmbargoScheduledPaymentDedupeKey(job.dedupeKey);
    if (quoteId === null) return 'dedupe-key-unrecognized';
    return this.p.runWithTenant(companyId, async () => {
      const quote = await this.p.quotes.findById(quoteId);
      if (!quote || quote.companyId !== companyId) return 'quote-missing';
      if (quote.retractedAt !== null) return 'quote-retracted';
      for (const kind of ['deposit', 'final', 'situation'] as const) {
        const invoice = await this.p.invoices.findByParentQuoteId(companyId, quoteId, kind);
        if (invoice !== null && invoice.paid > 0) return 'payment-already-received';
      }
      return null;
    });
  }

  /** Notifie les devices du tenant (chunké côté ExpoPushService) — échecs par ticket loggés,
   * tokens invalidés purgés, absence d'appareil tracée (jamais silencieux). Ne lève pas. */
  private async pushMirror(companyId: string, job: DeliverableNotificationJob): Promise<void> {
    if (!this.push) {
      this.logger.audit('notification.push.skipped', {
        companyId,
        jobId: job.id,
        reason: 'push_channel_absent',
      });
      return;
    }
    const devices = await this.p.runWithTenant(companyId, () =>
      this.p.devices.listDeliveryTargetsByCompany(companyId, activeBindingCutoff(this.clock.now())),
    );
    if (devices.length === 0) {
      this.logger.audit('notification.push.skipped', {
        companyId,
        jobId: job.id,
        reason: 'no_device_registered',
      });
      return;
    }
    const outcome = await this.push.send(
      devices.map((d) => ({
        to: d.expoPushToken,
        // Confidentialité lock-screen/provider : aucun type/identifiant métier n'est envoyé
        // à Expo/APNs. Le détail est résolu dans l'inbox après authentification.
        title: PRIVATE_PUSH_TITLE,
        body: PRIVATE_PUSH_BODY,
        data: {
          pushContract: '2',
          route: PRIVATE_PUSH_ROUTE,
          recipientBindingId: d.bindingId,
          recipientBindingGeneration: String(d.bindingGeneration),
        },
      })),
    );
    const invalidTokens = new Set(
      outcome.rejected
        .filter((rejection) => rejection.error === 'DeviceNotRegistered')
        .map((rejection) => rejection.token),
    );
    if (invalidTokens.size > 0) {
      // Token expiré/désinstallé : purge transactionnelle courte, après le réseau Expo.
      await this.p.runWithTenant(companyId, async () => {
        for (const target of devices) {
          if (!invalidTokens.has(target.expoPushToken)) continue;
          await this.p.devices.removeInvalidDeliveryTarget({
            companyId,
            expoPushToken: target.expoPushToken,
            bindingId: target.bindingId,
            bindingGeneration: target.bindingGeneration,
          });
        }
      });
    }
    this.logger.audit('notification.push.sent', {
      companyId,
      jobId: job.id,
      devices: devices.length,
      accepted: outcome.accepted,
      rejected: outcome.rejected.length,
    });
  }

  async runForCompany(
    companyId: string,
    limit = 25,
  ): Promise<{ scanned: number; sent: number; failed: number }> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const jobs = await this.p.runWithTenant(companyId, () =>
      this.p.notificationJobs.listDue(companyId, this.clock.now(), safeLimit),
    );
    let sent = 0;
    let failed = 0;
    for (const job of jobs) {
      const outcome = await this.tryDeliver(companyId, job);
      if (outcome === 'sent') sent += 1;
      if (outcome === 'failed') failed += 1;
    }
    return { scanned: jobs.length, sent, failed };
  }

  async runAllCompanies(
    limitPerCompany = 25,
  ): Promise<{ companies: number; scanned: number; sent: number; failed: number }> {
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
