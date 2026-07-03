import { type DateOnly } from '../../shared-kernel/time';
import { type ScoreBand } from '../../domain/customer/score';
import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus, type QuoteStatus } from '../../domain/billing/shared/state-machines';

/**
 * Use case pur « standing du carnet clients » (claim C12, doctrine A1-C10).
 * Entrée = données RÉELLES projetées (clients + factures + devis tels que servis par
 * l'api-client) ; sortie = un statut + encours PAR CLIENT, prêt pour l'écran Clients.
 * Aucune I/O, aucun repli fixtures : quand les pièces sont exposées, le statut se
 * dérive d'elles ; sinon (source absente ou client sans pièce) on retombe sur les
 * champs du client lui-même (outstanding + scoreBand du scoring core) — jamais sur
 * un chiffre inventé.
 */

// ── Entrées (projections minimales, structurellement compatibles avec les vues api-client) ──

export interface StandingCustomerData {
  id: string;
  /** Encours du client tel qu'exposé par l'API (centimes) — repli si aucune pièce. */
  outstanding: number;
  /** Bande de score du scoring core (score-customer) — red = mauvais payeur. */
  scoreBand: ScoreBand;
}

export interface StandingInvoiceData {
  customerId: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  totals: { netToPay: number };
  dueAt: DateOnly | null;
  /** Centimes encaissés cumulés. */
  paid: number;
}

export interface StandingQuoteData {
  customerId: string;
  status: QuoteStatus;
  totals: { ttc: number };
}

/** `invoices`/`quotes` à `undefined` = source indisponible (chargement/erreur) → repli client. */
export interface DeriveCustomerStandingsInput {
  customers: readonly StandingCustomerData[];
  invoices?: readonly StandingInvoiceData[] | undefined;
  quotes?: readonly StandingQuoteData[] | undefined;
  today: DateOnly;
}

// ── Sortie (statuts du proto : À jour/payé · en retard · en attente · devis · nouveau) ──

export type CustomerStandingKind = 'a_jour' | 'en_retard' | 'en_attente' | 'devis' | 'nouveau';

export interface CustomerStanding {
  customerId: string;
  kind: CustomerStandingKind;
  /**
   * Encours affiché (centimes) : reste dû réel (retard/attente, plafond netToPay − paid,
   * jamais ttc) · ttc des devis en attente de réponse (devis) · 0 (à jour/nouveau).
   */
  amountCents: number;
  /** Retard le plus long (jours calendaires) parmi les factures échues — 0 hors retard connu. */
  daysLate: number;
}

// ── Règles métier ──

/** Statuts encore encaissables — aligné sur deriveTodayPriorities (C10) et buildLedgerView (C11). */
const COLLECTIBLE: ReadonlySet<InvoiceStatus> = new Set(['issued', 'partially_paid', 'late']);

/** Un devis « en attente » attend la réponse du client (envoyé ou consulté). */
const QUOTE_PENDING: ReadonlySet<QuoteStatus> = new Set(['sent', 'viewed']);

const MS_PER_DAY = 86_400_000;

/** Jours calendaires entiers entre deux DateOnly (UTC, sans dépendance). */
function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY);
}

/** Reste à encaisser d'une facture encaissable (plafond netToPay, jamais ttc) — 0 sinon. */
function remainingCents(invoice: StandingInvoiceData): number {
  if (invoice.kind === 'credit_note') return 0;
  if (!COLLECTIBLE.has(invoice.status)) return 0;
  return Math.max(0, invoice.totals.netToPay - invoice.paid);
}

/** Facture échue : statut `late` posé par le backend, ou dueAt strictement dépassée. */
function isOverdue(invoice: StandingInvoiceData, today: DateOnly): boolean {
  return invoice.status === 'late' || (invoice.dueAt !== null && invoice.dueAt < today);
}

/**
 * Repli sans pièce : les champs du client lui-même (données réelles de l'API, pas des
 * fixtures). Un encours avec bande rouge (score-customer) = mauvais payeur → en retard ;
 * un encours sinon → en attente ; à zéro, une bande verte n'existe qu'avec un historique
 * de paiements à l'heure (formule score-customer : la ponctualité seule porte au vert)
 * → à jour ; sinon → nouveau.
 */
function fallbackStanding(customer: StandingCustomerData): CustomerStanding {
  const base = { customerId: customer.id, daysLate: 0 };
  if (customer.outstanding > 0) {
    return {
      ...base,
      kind: customer.scoreBand === 'red' ? 'en_retard' : 'en_attente',
      amountCents: customer.outstanding,
    };
  }
  return { ...base, kind: customer.scoreBand === 'green' ? 'a_jour' : 'nouveau', amountCents: 0 };
}

/**
 * Dérive le standing d'un client depuis ses pièces réelles :
 * 1. ≥ 1 facture échue avec reste dû → en retard (encours = TOUT le reste dû, retard = le plus long) ;
 * 2. reste dû sans échéance dépassée → en attente ;
 * 3. devis envoyé/consulté sans reste dû → devis (montant = ttc des devis en attente) ;
 * 4. un historique engagé (facture non brouillon/annulée, ou devis signé) → à jour ;
 * 5. aucune pièce → repli sur les champs du client (fallbackStanding).
 */
function standingFromDocs(
  customer: StandingCustomerData,
  invoices: readonly StandingInvoiceData[],
  quotes: readonly StandingQuoteData[],
  today: DateOnly,
): CustomerStanding {
  let openCents = 0;
  let daysLate = 0;
  let overdue = false;
  let hasEngagedInvoice = false;

  for (const invoice of invoices) {
    if (invoice.status !== 'draft' && invoice.status !== 'cancelled') hasEngagedInvoice = true;
    const remaining = remainingCents(invoice);
    if (remaining <= 0) continue;
    openCents += remaining;
    if (isOverdue(invoice, today)) {
      overdue = true;
      if (invoice.dueAt !== null) daysLate = Math.max(daysLate, daysBetween(invoice.dueAt, today));
    }
  }

  if (openCents > 0) {
    return overdue
      ? { customerId: customer.id, kind: 'en_retard', amountCents: openCents, daysLate }
      : { customerId: customer.id, kind: 'en_attente', amountCents: openCents, daysLate: 0 };
  }

  const pendingQuoteCents = quotes.reduce(
    (sum, quote) => sum + (QUOTE_PENDING.has(quote.status) ? quote.totals.ttc : 0),
    0,
  );
  if (pendingQuoteCents > 0) {
    return { customerId: customer.id, kind: 'devis', amountCents: pendingQuoteCents, daysLate: 0 };
  }

  const hasHistory = hasEngagedInvoice || quotes.some((quote) => quote.status === 'signed');
  if (hasHistory) return { customerId: customer.id, kind: 'a_jour', amountCents: 0, daysLate: 0 };

  return fallbackStanding(customer);
}

/**
 * Dérive le standing de chaque client du carnet (ordre d'entrée conservé — le tri
 * de présentation, par score, appartient à l'écran).
 */
export function deriveCustomerStandings(input: DeriveCustomerStandingsInput): CustomerStanding[] {
  // Sources indisponibles (chargement/erreur) → repli intégral sur les champs clients.
  if (input.invoices === undefined && input.quotes === undefined) {
    return input.customers.map(fallbackStanding);
  }

  const invoicesByCustomer = new Map<string, StandingInvoiceData[]>();
  for (const invoice of input.invoices ?? []) {
    const list = invoicesByCustomer.get(invoice.customerId);
    if (list) list.push(invoice);
    else invoicesByCustomer.set(invoice.customerId, [invoice]);
  }
  const quotesByCustomer = new Map<string, StandingQuoteData[]>();
  for (const quote of input.quotes ?? []) {
    const list = quotesByCustomer.get(quote.customerId);
    if (list) list.push(quote);
    else quotesByCustomer.set(quote.customerId, [quote]);
  }

  return input.customers.map((customer) => {
    const invoices = invoicesByCustomer.get(customer.id) ?? [];
    const quotes = quotesByCustomer.get(customer.id) ?? [];
    if (invoices.length === 0 && quotes.length === 0) return fallbackStanding(customer);
    return standingFromDocs(customer, invoices, quotes, input.today);
  });
}

/**
 * Total « en attente » du carnet (centimes) : Σ des encours réellement dus (retard + attente).
 * Les devis en attente de réponse ne sont PAS dus — ils n'entrent pas dans le total
 * (réf proto : 4 330 € = 2 480 retard + 1 850 attente, hors devis 1 480).
 */
export function pendingTotalCents(standings: readonly CustomerStanding[]): number {
  return standings.reduce(
    (sum, s) => sum + (s.kind === 'en_retard' || s.kind === 'en_attente' ? s.amountCents : 0),
    0,
  );
}

/** Borne basse de la fenêtre « 12 derniers mois » (année − 1, 29 févr. → 28 févr.). */
function oneYearBefore(today: DateOnly): DateOnly {
  const year = Number(today.slice(0, 4)) - 1;
  const monthDay = today.slice(5) === '02-29' ? '02-28' : today.slice(5);
  return `${year}-${monthDay}`;
}

/**
 * CA des 12 derniers mois d'un client (centimes) — KPI « CA 12 mois » de la fiche C13.
 * Σ netToPay des factures ENGAGÉES (hors brouillon/annulée), avoirs déduits : netToPay
 * (jamais ttc) somme acompte + finale sans double compte. La fenêtre se juge sur `dueAt`
 * — seule date exposée par la vue facture — bornée à « aujourd'hui − 12 mois » ; une
 * échéance future reste du CA courant, une facture engagée sans échéance connue compte.
 * Le caller passe les factures DU client (fonction pure, aucune I/O).
 */
export function revenueLast12MonthsCents(
  invoices: readonly StandingInvoiceData[],
  today: DateOnly,
): number {
  const from = oneYearBefore(today);
  return invoices.reduce((sum, invoice) => {
    if (invoice.status === 'draft' || invoice.status === 'cancelled') return sum;
    if (invoice.dueAt !== null && invoice.dueAt < from) return sum;
    const signed = invoice.kind === 'credit_note' ? -invoice.totals.netToPay : invoice.totals.netToPay;
    return sum + signed;
  }, 0);
}
