import { type DateOnly, addDays } from '../../shared-kernel/time';
import {
  type ContractPeriod,
  type MaintenanceContractStatus,
} from '../../domain/contract/maintenance-contract';
import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus } from '../../domain/billing/shared/state-machines';

/**
 * Bloc B §2.5 — dérivations PURES du cycle contractuel (zéro I/O). La période courante, la
 * reconduction tacite, l'échéance non-tacite et la couverture de facturation sont des CALCULS
 * sur l'état réel (anniversaryDate + factures non annulées), jamais des statuts stockés.
 * Tout est en DateOnly (comparaison lexicographique sûre sur AAAA-MM-JJ).
 */

/** Projection minimale du contrat consommée par les dérivations (structurelle, sans agrégat). */
export interface ContractScheduleData {
  status: MaintenanceContractStatus;
  anniversaryDate: DateOnly;
  tacitRenewal: boolean;
  /** [P13] borne EXCLUSIVE « facturé hors Bob jusqu'à » — null = rien de migré. */
  importCoveredUntil: DateOnly | null;
  /** Fin de couverture d'un contrat résilié — null hors `terminated`. */
  terminationEffectiveDate: DateOnly | null;
}

/**
 * Projection d'une facture du contrat (§2.5, annexe erratum n° 8 : servie en UNE requête
 * batchée par société). Doctrine fail-closed : `undefined` = information NON transportée —
 * on ne dérive alors JAMAIS une alerte ; `null` = fait affirmé absent.
 */
export interface ContractInvoiceProjection {
  id: string;
  number?: string | null;
  /** Un AVOIR (`credit_note`) ne couvre jamais une période : il rectifie une pièce, il ne
   * facture rien — sans cette exclusion, l'avoir d'une annuelle annulée « recouvrirait »
   * la période qu'il vient précisément de libérer. */
  kind?: InvoiceKind;
  status?: InvoiceStatus;
  servicePeriodStart?: DateOnly | null;
  servicePeriodEnd?: DateOnly | null;
}

const MS_PER_DAY = 86_400_000;

/** Jours calendaires entiers entre deux DateOnly (UTC, sans dépendance). */
export function contractDaysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY,
  );
}

function daysInMonth(year: number, month: number): number {
  // Jour 0 du mois suivant = dernier jour du mois visé (UTC, jamais le fuseau ambiant).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Anniversaire + N ans, jour CLAMPÉ à la fin du mois cible (29/02 → 28/02 les années non
 * bissextiles, et le 29/02 RESSURGIT aux années bissextiles puisque le calcul repart toujours
 * de la date ORIGINELLE — §2.5, vigilance §7.7).
 */
export function clampedAnniversary(anniversaryDate: DateOnly, yearsToAdd: number): DateOnly {
  const year = Number(anniversaryDate.slice(0, 4)) + yearsToAdd;
  const month = Number(anniversaryDate.slice(5, 7));
  const day = Math.min(Number(anniversaryDate.slice(8, 10)), daysInMonth(year, month));
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Période d'index n (0 = période initiale) : [clamp(a+n), clamp(a+n+1)) — fin EXCLUSIVE. */
export function periodAt(anniversaryDate: DateOnly, n: number): ContractPeriod {
  return {
    start: clampedAnniversary(anniversaryDate, n),
    end: clampedAnniversary(anniversaryDate, n + 1),
  };
}

/**
 * [Annexe erratum n° 5] Index N de la période courante par ENCADREMENT sur les bornes
 * CLAMPÉES : le N tel que clamp(a+N) ≤ today < clamp(a+N+1) — JAMAIS un floor d'années
 * séparé (au jour anniversaire clampé d'une année non bissextile, un floor laisserait un
 * trou d'un jour). Avant la première période : N = 0 (« avant anniversaryDate → première
 * période », §2.5).
 */
export function currentPeriodIndex(anniversaryDate: DateOnly, today: DateOnly): number {
  if (today < anniversaryDate) return 0;
  const diff = Number(today.slice(0, 4)) - Number(anniversaryDate.slice(0, 4));
  for (const n of [diff - 1, diff, diff + 1]) {
    if (n < 0) continue;
    if (clampedAnniversary(anniversaryDate, n) <= today && today < clampedAnniversary(anniversaryDate, n + 1))
      return n;
  }
  // Inatteignable pour des DateOnly valides : l'encadrement ci-dessus couvre tout `today ≥ a`.
  return Math.max(0, diff);
}

/**
 * Période contractuelle COURANTE (§2.5) :
 *  • non-tacite : il n'existe QUE la période initiale — au-delà, null (fait `expired`, P14) ;
 *  • résilié : les périodes s'ARRÊTENT à terminationEffectiveDate (fin clippée, null au-delà) ;
 *  • avant anniversaryDate : la première période (proposée par la fenêtre −30 j).
 */
export function currentPeriod(contract: ContractScheduleData, today: DateOnly): ContractPeriod | null {
  const index = currentPeriodIndex(contract.anniversaryDate, today);
  if (!contract.tacitRenewal && index > 0) return null;
  const period = periodAt(contract.anniversaryDate, index);
  const effective = contract.terminationEffectiveDate;
  if (contract.status === 'terminated' && effective !== null) {
    if (today >= effective || period.start >= effective) return null;
    return { start: period.start, end: period.end < effective ? period.end : effective };
  }
  return period;
}

export interface ContractLifecycleFacts {
  /** Chaque anniversaire PASSÉ d'un contrat tacite — fait CALCULÉ, affiché « (calculé) ». */
  renewals: DateOnly[];
  /** [P14] non-tacite échu : « Échu le … — à renouveler ou résilier ». */
  expired: { since: DateOnly } | null;
  /** Résilié : « couvert jusqu'au … » (borne exclusive — l'UI affiche la veille). */
  terminatedCoverage: { until: DateOnly } | null;
}

/** Faits de cycle de vie DÉRIVÉS (§2.5) — rien n'est journalisé par un cron, tout se recalcule. */
export function deriveContractLifecycleFacts(
  contract: ContractScheduleData,
  today: DateOnly,
): ContractLifecycleFacts {
  const renewals: DateOnly[] = [];
  if (contract.tacitRenewal) {
    const bound =
      contract.status === 'terminated' && contract.terminationEffectiveDate !== null
        ? contract.terminationEffectiveDate
        : null;
    const index = currentPeriodIndex(contract.anniversaryDate, today);
    for (let k = 1; k <= index; k += 1) {
      const anniversary = clampedAnniversary(contract.anniversaryDate, k);
      if (anniversary > today) break;
      // Un contrat ne se reconduit jamais APRÈS sa date d'effet de résiliation.
      if (bound !== null && anniversary >= bound) break;
      renewals.push(anniversary);
    }
  }
  const expiry = clampedAnniversary(contract.anniversaryDate, 1);
  const expired =
    !contract.tacitRenewal && contract.status !== 'terminated' && today >= expiry
      ? { since: expiry }
      : null;
  const terminatedCoverage =
    contract.status === 'terminated' && contract.terminationEffectiveDate !== null
      ? { until: contract.terminationEffectiveDate }
      : null;
  return { renewals, expired, terminatedCoverage };
}

/** Couverture d'UNE période par l'état réel — voir periodCoverage. */
export type PeriodCoverage =
  | { kind: 'covered'; by: 'import'; number: null }
  | { kind: 'covered'; by: 'invoice'; number: string | null }
  | { kind: 'uncovered'; cancelledCoveringNumber: string | null }
  /** Une projection MUETTE (statut ou période non transportés) interdit toute affirmation. */
  | { kind: 'unknown' };

/** Chevauchement période contrat [start, end) ↔ période de service facture [ps, pe] (pe
 * INCLUSIVE, null = jour unique) — comparaison lexicographique DateOnly. */
function overlapsPeriod(
  period: ContractPeriod,
  serviceStart: DateOnly,
  serviceEnd: DateOnly | null,
): boolean {
  const lastCoveredDay = addDays(period.end, -1);
  return serviceStart <= lastCoveredDay && (serviceEnd ?? serviceStart) >= period.start;
}

/**
 * [Direction 1] Couverture DÉRIVÉE des pièces réelles — jamais un compteur mutable :
 *  • couverte si `period.end ≤ importCoveredUntil` (bornes EXCLUSIVES toutes deux, P13) ;
 *  • sinon couverte par une facture NON annulée (brouillons EXCLUS — un brouillon ne couvre
 *    rien ; avoirs EXCLUS — un avoir rectifie) dont la période de service chevauche ;
 *  • une facture couvrante ANNULÉE rend la période à nouveau due (réallumage automatique) ;
 *  • une projection muette (`undefined`) → `unknown` : fail-closed, jamais d'alerte.
 */
export function periodCoverage(
  contract: Pick<ContractScheduleData, 'importCoveredUntil'>,
  period: ContractPeriod,
  invoices: readonly ContractInvoiceProjection[],
): PeriodCoverage {
  if (contract.importCoveredUntil !== null && period.end <= contract.importCoveredUntil)
    return { kind: 'covered', by: 'import', number: null };
  let mute = false;
  let cancelledCoveringNumber: string | null = null;
  for (const invoice of invoices) {
    if (invoice.kind === 'credit_note') continue;
    if (invoice.status === undefined) {
      mute = true;
      continue;
    }
    if (invoice.status === 'draft') continue;
    if (invoice.servicePeriodStart === undefined || invoice.servicePeriodEnd === undefined) {
      mute = true;
      continue;
    }
    if (invoice.servicePeriodStart === null) continue;
    if (!overlapsPeriod(period, invoice.servicePeriodStart, invoice.servicePeriodEnd)) continue;
    if (invoice.status === 'cancelled') {
      cancelledCoveringNumber = cancelledCoveringNumber ?? invoice.number ?? null;
      continue;
    }
    return { kind: 'covered', by: 'invoice', number: invoice.number ?? null };
  }
  if (mute) return { kind: 'unknown' };
  return { kind: 'uncovered', cancelledCoveringNumber };
}

export interface AnnualBillingDue {
  /** Période due (courante non couverte, SINON suivante en fenêtre −30 j — erratum n° 3). */
  period: ContractPeriod;
  /** Facture ANNULÉE qui couvrait — copy honnête « F-… annulée : période à re-facturer ». */
  cancelledCoveringNumber: string | null;
}

const ANNUAL_BILLING_WINDOW_DAYS = 30;

/**
 * [Annexe erratum n° 3] « Facture annuelle à émettre » — période CANDIDATE :
 *  1. la période COURANTE si elle n'est pas couverte (réallumage compris) ;
 *  2. SINON la période SUIVANTE si elle existe (tacite — un non-tacite n'en a pas — et
 *     contrat non résilié) ET `today ≥ next.start − 30 j` ET non couverte.
 * La fenêtre −30 j vit ainsi TOUTES les années : à J−30 de l'anniversaire de l'année N,
 * la période N est couverte par la facture de l'an passé et c'est la période N+1 qui
 * devient proposable — plus jamais une pré-facturation qui n'existe qu'en année 1.
 * Fail-closed intégral : contrat non `active` → null ; projection muette → null.
 */
export function deriveAnnualBillingDue(
  contract: ContractScheduleData,
  invoices: readonly ContractInvoiceProjection[],
  today: DateOnly,
): AnnualBillingDue | null {
  if (contract.status !== 'active') return null;
  const current = currentPeriod(contract, today);
  if (current === null) return null;
  // Première période encore lointaine : la proposition n'ouvre qu'à J−30 du début.
  if (today < addDays(current.start, -ANNUAL_BILLING_WINDOW_DAYS)) return null;
  const coverage = periodCoverage(contract, current, invoices);
  if (coverage.kind === 'unknown') return null;
  if (coverage.kind === 'uncovered')
    return { period: current, cancelledCoveringNumber: coverage.cancelledCoveringNumber };
  if (!contract.tacitRenewal) return null;
  const next = periodAt(
    contract.anniversaryDate,
    currentPeriodIndex(contract.anniversaryDate, today) + 1,
  );
  if (today < addDays(next.start, -ANNUAL_BILLING_WINDOW_DAYS)) return null;
  const nextCoverage = periodCoverage(contract, next, invoices);
  if (nextCoverage.kind !== 'uncovered') return null;
  return { period: next, cancelledCoveringNumber: nextCoverage.cancelledCoveringNumber };
}

export type RenewalPalier = 'j60' | 'j30';

export interface RenewalAlert {
  /** UN SEUL palier — le plus récent encore pertinent (amélioration 14 : au réveil après une
   * panne, jamais J-60 ET J-30 d'un coup ; les paliers passés ne se rattrapent pas). */
  palier: RenewalPalier;
  /** Prochain anniversaire CALCULÉ = début de la période visée (clé de dédup du cron). */
  anniversary: DateOnly;
  daysUntil: number;
  /** Copy : tacite « se reconduit dans N jours » / non-tacite « arrive à échéance dans N jours ». */
  tacit: boolean;
}

/**
 * Alerte de renouvellement J-60/J-30 (§2.5) — INTERNE uniquement, jamais un envoi client.
 * Éteinte par l'état réel : contrat résilié → null ; échéance passée → null (le fait
 * `expired` de deriveContractLifecycleFacts prend le relais pour le non-tacite).
 */
export function deriveRenewalAlerts(
  contract: ContractScheduleData,
  today: DateOnly,
): RenewalAlert | null {
  if (contract.status !== 'active') return null;
  const anniversary = contract.tacitRenewal
    ? clampedAnniversary(
        contract.anniversaryDate,
        currentPeriodIndex(contract.anniversaryDate, today) + 1,
      )
    : clampedAnniversary(contract.anniversaryDate, 1);
  const daysUntil = contractDaysBetween(today, anniversary);
  if (daysUntil <= 0 || daysUntil > 60) return null;
  return {
    palier: daysUntil <= 30 ? 'j30' : 'j60',
    anniversary,
    daysUntil,
    tacit: contract.tacitRenewal,
  };
}
