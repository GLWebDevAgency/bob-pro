import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  SystemClock,
  buildValueDigest,
  ok,
  appDomain,
  trialDaysLeft,
  trialPhase,
  type AnalyticsPort,
  type AppError,
  type PlanTier,
  type Result,
  type ReverseTrialState,
  type TrialPhase,
  type ValueDigest,
  type ValueEvent,
} from '@bob/core';
import { PERSISTENCE, type Persistence } from '../persistence/persistence';
import { NotificationDedupeConflictError } from '../persistence/notification-jobs';
import { SUPABASE_ADMIN, type SupabaseAdminPort } from '../auth/supabase-admin';
import { AppLogger, requireTenant } from '../observability/logger';
import { ANALYTICS } from '../observability/analytics';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';

/**
 * Version de la politique digest — partie de la clé de déduplication : UNE notification par
 * société et par semaine ISO, même si le cron rejoue. À incrémenter seulement si la méthodologie
 * ou la copy change assez pour justifier un nouvel envoi de la même semaine.
 */
const DIGEST_POLICY_VERSION = 'v1';
/** Fenêtre max relance→paiement pour revendiquer un recouvrement (lien causal plausible). */
const RECOVERY_ATTRIBUTION_MAX_DAYS = 30;

/** Lundi 7 h 30 Europe/Paris — « le lundi de Bob », avant le départ au chantier (SPEC pilier 2 §5). */
const WEEKLY_DIGEST_CRON = '30 7 * * 1';

/**
 * Fenêtre de scan des relances récentes pour l'attribution : listRecent est le seul port outbox
 * disponible (pas de requête par kind/statut). 200 notifications couvrent très largement la
 * semaine d'un artisan ; au pire un recouvrement est SOUS-compté, jamais inventé.
 */
const RELANCE_SCAN_LIMIT = 200;

const PARIS_TZ = 'Europe/Paris';
const COMPANY_ID_PREFIX = 'company-';
const DAY_MS = 86_400_000;

export interface DigestWindow {
  /** Bornes instantanées [start, end) — minuit Europe/Paris converti en UTC. */
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Mêmes bornes en dates calendaires Paris [startDate, endDate) — pour les faits datés en DateOnly. */
  readonly startDate: string;
  readonly endDate: string;
  /** Semaine ISO 8601 de la période digérée (celle du lundi startDate) — clé de dédup. */
  readonly isoWeek: string;
}

export type DigestCompanyOutcome = 'queued' | 'deduplicated' | 'no_substance' | 'no_account_email';

/** Bilan de fin d'essai (pilier 2) — GET /engagement/trial-report. trial null = pas d'essai. */
export interface TrialReportPayload {
  readonly digest: ValueDigest | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly trial: {
    readonly plan: PlanTier;
    readonly endsAt: string;
    readonly phase: TrialPhase;
    readonly daysLeft: number;
  } | null;
}

export interface DigestRunSummary {
  companies: number;
  queued: number;
  deduplicated: number;
  skippedNoSubstance: number;
  skippedNoEmail: number;
  failed: number;
  isoWeek: string;
}

// ——— Temps (Europe/Paris) — helpers PURS, exportés pour les tests ———

function parisWallClock(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PARIS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function parisDateOnly(at: Date): string {
  return parisWallClock(at).slice(0, 10);
}

/** Instant UTC de minuit Europe/Paris pour ce jour. Paris vaut UTC+1 (hiver) ou UTC+2 (été) ;
 *  les bascules DST ont lieu à 02:00/03:00, jamais à minuit — l'un des deux offsets est exact. */
function parisMidnightInstant(dateOnly: string): string {
  for (const offsetHours of [1, 2]) {
    const candidate = new Date(Date.parse(`${dateOnly}T00:00:00.000Z`) - offsetHours * 3_600_000);
    if (parisWallClock(candidate) === `${dateOnly} 00:00`) return candidate.toISOString();
  }
  throw new Error(`Minuit Europe/Paris introuvable pour ${dateOnly}.`);
}

function addDaysDateOnly(dateOnly: string, days: number): string {
  const d = new Date(`${dateOnly}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Étiquette ISO 8601 (« 2026-W29 ») de la semaine contenant ce jour — le jeudi décide l'année. */
function isoWeekLabel(dateOnly: string): string {
  const d = new Date(`${dateOnly}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const isoYear = d.getUTCFullYear();
  const week1Thursday = new Date(Date.UTC(isoYear, 0, 4));
  week1Thursday.setUTCDate(week1Thursday.getUTCDate() + 3 - ((week1Thursday.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((d.getTime() - week1Thursday.getTime()) / (7 * DAY_MS));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Les 7 jours écoulés : [lundi précédent 00:00 → dernier lundi 00:00) en Europe/Paris. */
export function weeklyDigestWindow(now: Date): DigestWindow {
  const today = parisDateOnly(now);
  const daysSinceMonday = (new Date(`${today}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  const endDate = addDaysDateOnly(today, -daysSinceMonday);
  const startDate = addDaysDateOnly(endDate, -7);
  return {
    periodStart: parisMidnightInstant(startDate),
    periodEnd: parisMidnightInstant(endDate),
    startDate,
    endDate,
    isoWeek: isoWeekLabel(startDate),
  };
}

// ——— Copy française (sobre, faits réels, temps = « environ ») ———

function formatEuros(cents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

function frDate(dateOnly: string): string {
  return dateOnly.split('-').reverse().join('/');
}

/** L'accroche est UNIQUE (argent > temps > volume) — l'artisan lit une phrase, pas un tableau. */
function digestSubject(digest: ValueDigest): string {
  const h = digest.highlight;
  if (h.kind === 'money') {
    return h.recovered
      ? `Ton lundi Bob — ${formatEuros(h.amountCents)} récupérés sur tes impayés`
      : `Ton lundi Bob — ${formatEuros(h.amountCents)} encaissés la semaine dernière`;
  }
  if (h.kind === 'time') return `Ton lundi Bob — environ ${formatMinutes(h.minutes)} d'admin en moins`;
  return `Ton lundi Bob — ${h.documents} documents créés la semaine dernière`;
}

/** Corps FR déterministe (même digest ⇒ même empreinte outbox). Faits présentés tels quels ;
 *  le temps économisé est TOUJOURS annoncé comme estimation (« environ », règle value-ledger). */
export function weeklyDigestMessage(digest: ValueDigest, window: DigestWindow): { subject: string; body: string } {
  const lines: string[] = [`Ta semaine du ${frDate(window.startDate)} au ${frDate(addDaysDateOnly(window.endDate, -1))} :`];
  if (digest.collectedCents > 0) {
    const recovered = digest.recoveredCents > 0 ? ` (dont ${formatEuros(digest.recoveredCents)} récupérés après relance)` : '';
    lines.push(`· Encaissé : ${formatEuros(digest.collectedCents)}${recovered}`);
  }
  if (digest.documentsCreated > 0) {
    const voice = digest.documentsViaVoice > 0 ? ` (dont ${digest.documentsViaVoice} à la voix)` : '';
    lines.push(`· Documents créés : ${digest.documentsCreated}${voice}`);
  }
  if (digest.relancesSent > 0) lines.push(`· Relances envoyées : ${digest.relancesSent}`);
  if (digest.estimatedMinutesSaved > 0) {
    lines.push(`· Temps administratif gagné : environ ${formatMinutes(digest.estimatedMinutesSaved)} (estimation)`);
  }
  lines.push('', 'Ouvre Bob pour le détail et les prochaines actions.');
  return { subject: digestSubject(digest), body: lines.join('\n') };
}

function relanceInvoiceId(dedupeKey: string): string | null {
  const [head, id] = dedupeKey.split(':');
  return head === 'invoice' && id ? id : null;
}

/**
 * Digest de valeur hebdo « le lundi de Bob » (pilier 2 §5, SPEC_PILIER2_MONETISATION).
 * Projections RÉELLES du tenant → buildValueDigest (@bob/core) → outbox 'weekly-digest'.
 * Règles non négociables reprises du moteur : digest sans substance = null ⇒ AUCUNE notification ;
 * encaissé = centimes réellement reçus (assiette TTC des paiements — jamais mélangée au HT) ;
 * relances comptées sur notification_jobs.status='done' UNIQUEMENT (queued surestime).
 * Pattern relance.service (multi-tenant : ScheduledTenantDirectory + runWithTenant) + flag OFF
 * par défaut et anti-chevauchement (pattern cabinet-invitation-delivery.scheduler).
 */
@Injectable()
export class DigestService {
  private readonly clock = new SystemClock();
  private running = false;

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    private readonly notificationDelivery: NotificationDeliveryService,
    private readonly tenants: ScheduledTenantDirectory,
    @Inject(SUPABASE_ADMIN) private readonly supabaseAdmin: SupabaseAdminPort,
    private readonly logger: AppLogger,
    // Analytics produit (SPEC pilier 2 décision 11) — fire-and-forget, Noop sans endpoint.
    @Inject(ANALYTICS) private readonly analytics: AnalyticsPort,
  ) {}

  @Cron(WEEKLY_DIGEST_CRON, { timeZone: PARIS_TZ })
  async scheduled(): Promise<void> {
    if (process.env.DIGEST_WORKER_ENABLED !== 'true') return; // OFF par défaut (rollout contrôlé)
    if (this.running) return; // anti-chevauchement : un seul sweep à la fois
    this.running = true;
    try {
      await this.runDigests();
    } catch (e) {
      this.logger.warn(`Digest hebdo interrompu: ${e instanceof Error ? e.message : String(e)}`, 'digest');
    } finally {
      this.running = false;
    }
  }

  async runDigests(): Promise<DigestRunSummary> {
    const window = weeklyDigestWindow(new Date(this.clock.now()));
    const companyIds = await this.tenants.listCompanyIds();
    const summary: DigestRunSummary = {
      companies: companyIds.length,
      queued: 0,
      deduplicated: 0,
      skippedNoSubstance: 0,
      skippedNoEmail: 0,
      failed: 0,
      isoWeek: window.isoWeek,
    };
    for (const companyId of companyIds) {
      try {
        const outcome = await this.runDigestForCompany(companyId, window);
        if (outcome === 'queued') summary.queued += 1;
        if (outcome === 'deduplicated') summary.deduplicated += 1;
        if (outcome === 'no_substance') summary.skippedNoSubstance += 1;
        if (outcome === 'no_account_email') summary.skippedNoEmail += 1;
      } catch (e) {
        // Un tenant en échec ne prive jamais les autres de leur digest. Aucun payload loggé.
        summary.failed += 1;
        this.logger.warn(
          `Digest indisponible pour company=${companyId}: ${e instanceof Error ? e.message : String(e)}`,
          'digest',
        );
      }
    }
    this.logger.audit('digests.run_all', { ...summary });
    return summary;
  }

  async runDigestForCompany(companyId: string, window: DigestWindow): Promise<DigestCompanyOutcome> {
    const dedupeKey = `digest:${companyId}:${window.isoWeek}:${DIGEST_POLICY_VERSION}`;
    const { events, alreadyEnqueued } = await this.p.runWithTenant(companyId, () =>
      this.collectValueEvents(companyId, window, dedupeKey),
    );

    const digest = buildValueDigest({ periodStart: window.periodStart, periodEnd: window.periodEnd, events });
    if (digest === null) return 'no_substance'; // contrainte codée : jamais une notification sans substance

    // Réseau Supabase HORS transaction tenant (même hygiène que la livraison : aucun GUC/lock
    // Postgres ouvert pendant une I/O externe).
    const email = await this.accountEmail(companyId);
    if (email === null) {
      this.logger.audit('digest.email_skipped', {
        companyId,
        isoWeek: window.isoWeek,
        reason: 'account_email_missing',
      });
      return 'no_account_email';
    }

    const message = weeklyDigestMessage(digest, window);
    try {
      const job = await this.p.runWithTenant(companyId, () =>
        this.notificationDelivery.enqueue({
          companyId,
          kind: 'weekly-digest',
          dedupeKey,
          notification: { channel: 'email', to: email, subject: message.subject, body: message.body },
        }),
      );
      const queuedNow = !(alreadyEnqueued || job.status === 'done');
      if (queuedNow) {
        // value_digest_sent : LE point de mesure de la boucle de rétention (ouverture mesurée
        // côté mobile via value_digest_opened) — tenantId opaque, zéro contenu.
        this.analytics.track({
          tenantId: companyId,
          at: new Date(this.clock.now()).toISOString(),
          event: { name: 'value_digest_sent', highlightKind: digest.highlight.kind },
        });
      }
      const outcome: DigestCompanyOutcome =
        alreadyEnqueued || job.status === 'done' ? 'deduplicated' : 'queued';
      this.logger.audit('digest.queued', { companyId, isoWeek: window.isoWeek, jobId: job.id, outcome });
      return outcome;
    } catch (e) {
      if (e instanceof NotificationDedupeConflictError) {
        // Un fait rétro-daté dans une semaine close changerait le corps sous la même clé :
        // l'outbox immuable refuse — premier instantané de la semaine fait foi (v1).
        this.logger.audit('digest.dedupe_conflict', { companyId, isoWeek: window.isoWeek });
        return 'deduplicated';
      }
      throw e;
    }
  }

  /**
   * Projections RÉELLES → ValueEvent[] :
   * · paiements (receivedAt dans la fenêtre, montant = centimes encaissés, assiette TTC) ;
   * · 'overdue_recovered' à la place de 'payment_collected' UNIQUEMENT si une relance DONE de la
   *   MÊME facture (dedupeKey `invoice:{id}:relance:…`) précède le paiement — attribution
   *   conservatrice, jamais un recouvrement inventé ;
   * · relances DONE de la fenêtre → 'relance_sent' (statut done uniquement ; createdAt comme
   *   horloge, car updatedAt est retouché par markRead/markReadThrough du fil C25) ;
   * · factures émises dans la fenêtre (issuedAt, hors annulées) → 'document_created'. Le devis
   *   ne porte AUCUNE date de création persistée (ni agrégat ni colonne) : exclu plutôt que daté
   *   arbitrairement. viaVoice n'est pas traçable côté serveur aujourd'hui : jamais revendiqué.
   */
  /**
   * Digest de la semaine ÉCOULÉE recalculé À LA VOLÉE pour le tenant COURANT (GET mobile) —
   * mêmes projections que le cron (une seule vérité, jamais deux calculs qui divergent) ;
   * digest null = semaine sans substance (la carte mobile ne se rend pas, zéro bruit).
   */
  async latestForCurrentTenant(): Promise<
    Result<{ digest: ValueDigest | null; periodStart: string; periodEnd: string; isoWeek: string }, AppError>
  > {
    const companyId = requireTenant();
    const window = weeklyDigestWindow(new Date(this.clock.now()));
    const { events } = await this.collectValueEvents(
      companyId,
      window,
      `digest:${companyId}:${window.isoWeek}:${DIGEST_POLICY_VERSION}`,
    );
    const digest = buildValueDigest({ periodStart: window.periodStart, periodEnd: window.periodEnd, events });
    return ok({ digest, periodStart: window.periodStart, periodEnd: window.periodEnd, isoWeek: window.isoWeek });
  }

  /**
   * BILAN DE FIN D'ESSAI (pilier 2, SPEC décision 2) — ce que Bob a RÉELLEMENT fait pendant
   * l'essai : MÊMES projections que le digest hebdo (une seule vérité), CUMULÉES sur la
   * période d'essai [début, min(now, échéance)). Tenant sans ligne d'essai (pré-migration,
   * early-access) → trial: null, digest: null — la carte mobile ne se rend pas, zéro bruit.
   */
  async trialReportForCurrentTenant(): Promise<Result<TrialReportPayload, AppError>> {
    const companyId = requireTenant();
    const record = await this.p.subscriptions.findByCompanyId(companyId);
    if (record === null || record.trialEndsAt === null || record.status !== 'trialing') {
      return ok({ digest: null, periodStart: null, periodEnd: null, trial: null });
    }
    const now = this.clock.now();
    const trial: ReverseTrialState = { tier: record.plan, startedAt: record.createdAt, endsAt: record.trialEndsAt };
    const periodStart = record.createdAt;
    const periodEnd = Date.parse(now) < Date.parse(record.trialEndsAt) ? now : record.trialEndsAt;
    const startDate = parisDateOnly(new Date(periodStart));
    // Borne date-only EXCLUSIVE : lendemain du dernier jour couvert — les factures (datées en
    // DateOnly) du dernier jour d'essai comptent, granularité jour assumée.
    const endDate = addDaysDateOnly(parisDateOnly(new Date(periodEnd)), 1);
    const window: DigestWindow = { periodStart, periodEnd, startDate, endDate, isoWeek: isoWeekLabel(startDate) };
    const { events } = await this.collectValueEvents(companyId, window, `trial-report:${companyId}`);
    const digest = buildValueDigest({ periodStart, periodEnd, events });
    return ok({
      digest,
      periodStart,
      periodEnd,
      trial: {
        plan: record.plan,
        endsAt: record.trialEndsAt,
        phase: trialPhase(trial, now),
        daysLeft: trialDaysLeft(trial, now),
      },
    });
  }

  /**
   * value_digest_opened (pilier 2, analytics décision 11) — l'OUVERTURE réelle du digest par
   * l'utilisateur (tap sur la carte, pas son rendu). Fire-and-forget via l'AnalyticsPort
   * (Noop sans endpoint, opt-out RGPD structurel) : n'échoue jamais côté client.
   */
  async recordDigestOpened(input: { highlightKind?: unknown }): Promise<Result<{ recorded: boolean }, AppError>> {
    const companyId = requireTenant();
    const kind = input.highlightKind;
    if (kind !== 'money' && kind !== 'time' && kind !== 'volume') {
      return {
        ok: false,
        error: appDomain({ code: 'VALIDATION', field: 'highlightKind', message: 'Accroche de digest inconnue.' }),
      };
    }
    this.analytics.track({
      tenantId: companyId,
      at: new Date(this.clock.now()).toISOString(),
      event: { name: 'value_digest_opened', highlightKind: kind },
    });
    return ok({ recorded: true });
  }

  private async collectValueEvents(
    companyId: string,
    window: DigestWindow,
    dedupeKey: string,
  ): Promise<{ events: ValueEvent[]; alreadyEnqueued: boolean }> {
    const [payments, invoices, recentJobs] = await Promise.all([
      this.p.payments.listByCompany(companyId),
      this.p.invoices.listByCompany(companyId),
      this.p.notificationJobs.listRecent(companyId, RELANCE_SCAN_LIMIT),
    ]);
    const startMs = Date.parse(window.periodStart);
    const endMs = Date.parse(window.periodEnd);

    const doneRelances = recentJobs.filter((job) => job.kind === 'invoice-relance' && job.status === 'done');
    const firstRelanceAtByInvoice = new Map<string, string>();
    for (const job of doneRelances) {
      const invoiceId = relanceInvoiceId(job.dedupeKey);
      if (invoiceId === null) continue;
      const known = firstRelanceAtByInvoice.get(invoiceId);
      if (known === undefined || job.createdAt < known) firstRelanceAtByInvoice.set(invoiceId, job.createdAt);
    }

    const events: ValueEvent[] = [];
    for (const payment of payments) {
      const atMs = Date.parse(payment.receivedAt);
      if (Number.isNaN(atMs) || atMs < startMs || atMs >= endMs) continue;
      const relanceAt = firstRelanceAtByInvoice.get(payment.invoiceId);
      // Attribution CONSERVATRICE bornée : la relance doit précéder le paiement DE MOINS DE
      // 30 jours — au-delà, le lien causal n'est plus plausible et « récupéré » serait un
      // mensonge flatteur (review 14/07, P2). Un doute = payment_collected, jamais l'inverse.
      const recovered =
        relanceAt !== undefined &&
        Date.parse(relanceAt) <= atMs &&
        atMs - Date.parse(relanceAt) <= RECOVERY_ATTRIBUTION_MAX_DAYS * 24 * 60 * 60 * 1000;
      events.push({
        kind: recovered ? 'overdue_recovered' : 'payment_collected',
        at: payment.receivedAt,
        amountCents: payment.amount,
      });
    }
    for (const job of doneRelances) {
      const atMs = Date.parse(job.createdAt);
      if (Number.isNaN(atMs) || atMs < startMs || atMs >= endMs) continue;
      events.push({ kind: 'relance_sent', at: job.createdAt });
    }
    for (const invoice of invoices) {
      const issuedAt = invoice.issuedAt;
      if (issuedAt === null || invoice.status === 'cancelled') continue;
      if (issuedAt < window.startDate || issuedAt >= window.endDate) continue;
      // issuedAt est un DateOnly : midi UTC appartient strictement à [minuit Paris, minuit Paris).
      events.push({ kind: 'document_created', at: `${issuedAt}T12:00:00.000Z` });
    }

    const alreadyEnqueued = recentJobs.some((job) => job.kind === 'weekly-digest' && job.dedupeKey === dedupeKey);
    return { events, alreadyEnqueued };
  }

  /**
   * Email du COMPTE artisan (JAMAIS celui d'un client) : il ne vit ni sur Company ni dans la
   * DB API, mais dans Supabase Auth. Le lien tenant→user est la dérivation déterministe du
   * provisioning C24b (`company-<userId>`, backend.service registerCompany) : on l'inverse puis
   * on interroge l'annuaire admin. Introuvable/indisponible ⇒ null (skip compté par l'appelant).
   */
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
