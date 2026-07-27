/**
 * Revue de pilotage (BA-1) — LE tableau de bord business de l'indépendant : séries de CA,
 * comparatifs honnêtes, DSO, top clients, top postes de dépense, cascade SIG et ratios.
 * Use case pur (zéro I/O, today injecté, centimes entiers) ; règles conçues et VÉRIFIÉES
 * adversarialement (workflow wf_02776c87-fe3 : 2 experts-comptables + lentille produit,
 * synthèse contrôleur). Une seule vérité pour l'écran Pilotage et pour Bob.
 *
 * Décisions cardinales de la spec :
 * · CA FACTURÉ = les ÉCRITURES (préfixe 70, entryDate), jamais les factures : l'acompte
 *   crédite 4191 (pas de CA), la finale porte 100 % du HT — le chantier compte UNE fois ;
 *   les avoirs se déduisent au mois d'émission ; Σ des mois = l'agrégat 70x de la balance.
 * · CA ENCAISSÉ = les paiements (receivedAt, TTC) — l'assiette URSSAF du micro. Les deux
 *   séries coexistent : l'écart est le poste clients (+ la TVA), jamais une redondance.
 * · HONNÊTETÉ TEMPORELLE : série dense à zéros explicites DEPUIS le premier mouvement,
 *   jamais de zéro fabriqué avant l'ouverture ; aucun % plein-mois sur le mois en cours
 *   (isopérimètre de jours uniquement) ; N vs N-1 émis seulement à couverture complète ;
 *   % jamais émis sous un plancher de base (un « +240 % » sur 800 € est un mensonge).
 * · DSO 90 j : encours (balance âgée, une seule vérité) × 90 / facturé TTC 90 j (lignes
 *   411 des écritures sourceType 'invoice' — les encaissements créditent 411 au journal
 *   bank et sont EXCLUS). Bords null assumés : « il me faut 3 mois d'historique ».
 * · RATIOS en bps entiers, dénominateur ≤ 0 → null typé — jamais 0 ni sentinelle.
 *
 * Non construit en v1 (spec) : delta DSO vs t−90 (reconstituer l'encours passé exigerait
 * le lettrage daté des paiements — on ne simule pas), run-rate annualisé, score composite.
 */

import { type DateOnly, addDays } from '../../shared-kernel/time';
import { type VatRegime } from '../../domain/company/company';
import { type ExpenseCategory } from '../../domain/expense/expense';
import {
  deriveAgedBalance,
  type AgedBalanceCustomerData,
  type AgedBalanceInvoiceData,
} from '../clients/derive-aged-balance';
import { isIssuedNeverTransmitted } from '../today/derive-today-priorities';
import { revenueLast12MonthsCents } from '../clients/derive-customer-standings';
import { deriveSig, type SigStatement } from '../accounting/derive-sig';
import { deriveIncomeStatement } from '../accounting/derive-income-statement';
import { deriveVatPosition, type VatPosition } from '../argent/derive-vat-position';

export interface BusinessReviewEntryData {
  entryDate: DateOnly;
  sourceType: string;
  lines: readonly { account: string; debitCents: number; creditCents: number }[];
}

export interface BusinessReviewPaymentData {
  amountCents: number;
  /** Instant ou date — seul le jour compte (receivedAt.slice(0, 10)). */
  receivedAt: string;
}

export interface BusinessReviewExpenseData {
  category: ExpenseCategory;
  totalTtcCents: number;
  vatCents: number | null;
  documentDate: DateOnly;
  status: 'to_pay' | 'paid';
}

/**
 * PR-07 — facture de la revue : la projection balance âgée ÉTENDUE de façon OPTIONNELLE par les
 * faits de transmission (PR-02). Fail-closed : champs absents = la carte Encaissement n'affirme
 * JAMAIS qu'une pièce n'est pas partie ; les appelants existants restent compatibles.
 */
export interface BusinessReviewInvoiceData extends AgedBalanceInvoiceData {
  id?: string;
  number?: string | null;
  /** Livraison EMAIL constatée (outbox) — undefined = information non transportée. */
  emailDeliveredAt?: string | null;
  /** Suivi déclaré de transmission — undefined = information non transportée. */
  transmission?: { depositedAt: DateOnly | null; acceptedAt: DateOnly | null } | null;
}

export interface BusinessReviewInput {
  entries: readonly BusinessReviewEntryData[];
  payments: readonly BusinessReviewPaymentData[];
  invoices: readonly BusinessReviewInvoiceData[];
  customers: readonly AgedBalanceCustomerData[];
  expenses: readonly BusinessReviewExpenseData[];
  /** Régime TVA qualifié du tenant — requis : aucun traitement « réel » implicite. */
  vatRegime: VatRegime;
  today: DateOnly;
  params?: {
    /** Plancher de base sous lequel aucun % n'est émis (défaut 300 000 c = 3 000 €). */
    percentFloorCents?: number;
    /** Seuil d'alerte de dépendance au top-1 client, en bps (défaut 3000 = 30 %). */
    concentrationAlertBps?: number;
  };
}

/** Point mensuel des deux séries — jamais superposées sans dire que l'écart contient la TVA. */
export interface MonthlyRevenuePoint {
  month: string; // YYYY-MM
  /** « Facturé (hors TVA) » — l'activité du mois, la base du résultat. */
  invoicedHtCents: number;
  /** « Encaissé (TVA comprise) » — ce qui est vraiment arrivé sur le compte. */
  collectedTtcCents: number;
}

export interface ClosedMonthComparison {
  month: string;
  previousMonth: string;
  invoicedHtCents: number;
  previousInvoicedHtCents: number;
  deltaCents: number;
  /** null si base ≤ 0 ou sous le plancher — l'UI affiche « — » et les montants bruts. */
  deltaBps: number | null;
}

export interface CurrentMonthProgress {
  month: string;
  /** Jour du mois de `today` — tout cumul de ce bloc est « au J du mois », jamais plein-mois. */
  atDay: number;
  invoicedHtCents: number;
  collectedTtcCents: number;
  /** Mois précédent à ISOPÉRIMÈTRE de jours : 1 → min(atDay, fin du mois précédent). */
  previousInvoicedHtCents: number;
  previousCollectedTtcCents: number;
  invoicedDeltaBps: number | null;
}

export interface YtdComparison {
  invoicedHtCents: number;
  /** 01/01/N-1 → date miroir (29/02 → 28/02, convention canonique du repo). */
  previousYearInvoicedHtCents: number;
  deltaCents: number;
  deltaBps: number | null;
}

export interface DsoView {
  /** Jours entiers — null assumé tant que les conditions ne sont pas réunies. */
  days: number | null;
  reason: 'ok' | 'all_collected' | 'no_recent_invoicing' | 'insufficient_history';
  /** € immobilisés chez les clients (= balance âgée, une seule vérité). */
  receivablesCents: number;
  invoicedTtc90dCents: number;
}

export interface TopClientLine {
  customerId: string;
  customerName: string;
  /** « Facturé (TTC) sur 12 mois » — netToPay signé, assiette de la fiche client C13. */
  invoicedTtc12mCents: number;
  shareBps: number | null;
}

export interface TopClientsView {
  lines: TopClientLine[];
  othersCents: number;
  othersCount: number;
  /** Clients à total négatif (avoirs nets) — ligne séparée, jamais fondue dans « Autres ». */
  creditNetCents: number;
  creditNetCount: number;
  /** INVARIANT : Σ lines + othersCents + creditNetCents = totalCents au centime. */
  totalCents: number;
  top1ShareBps: number | null;
  concentrationAlert: boolean;
}

export interface TopExpenseLine {
  category: ExpenseCategory;
  /** Charge comptabilisée : TTC − TVA mentionnée au réel (miroir du 6xx posté) ; TTC en franchise. */
  chargeCents: number;
  previousChargeCents: number;
  deltaBps: number | null;
}

export interface TopExpensesView {
  lines: TopExpenseLine[];
  othersCents: number;
  totalCents: number;
}

export interface BusinessRatios {
  /** CA de l'exercice à date = solde produit signé du préfixe 70. */
  caCents: number;
  ebeBps: number | null;
  /** Consommations de tiers SIG / CA — le levier n° 1 (matériaux + sous-traitance). */
  chargesExternesBps: number | null;
  rexBps: number | null;
  netBps: number | null;
  vaBps: number | null;
  /** Charges de personnel / VA — émis seulement si 64 mouvementé et VA > 0. */
  personnelVaBps: number | null;
  /** Marge / ventes de matériaux nettes — émis seulement si la marge est active (gate SIG). */
  margeMateriauxBps: number | null;
}

/** PR-07 — pièce émise SANS envoi constaté ni dépôt déclaré (prédicat PR-02, la MÊME vérité
 *  que la carte Aujourd'hui et le badge de liste). */
export interface CollectionUntransmittedLine {
  invoiceId: string;
  docNumber: string | null;
  customerId: string;
  customerName: string;
  /** Reste à encaisser (netToPay − paid) — ce qui dort tant que rien n'est parti. */
  amountCents: number;
}

/**
 * PR-07 — carte « Encaissement » : le trou n° 1 de Fly Services (2 % encaissé) rendu VISIBLE.
 * Même honnêteté temporelle que le DSO : null assumé si l'historique est insuffisant, jamais un
 * taux fabriqué sur une fenêtre vide.
 */
export interface CollectionView {
  /** % encaissé sur facturé 90 j, en bps — encaissé TTC 90 j / facturé TTC 90 j (411 des
   *  écritures de facture, avoirs en NÉGATIF). null si la fenêtre ne permet aucun taux honnête. */
  collectedRateBps90d: number | null;
  reason: 'ok' | 'no_recent_invoicing' | 'insufficient_history';
  collectedTtc90dCents: number;
  invoicedTtc90dCents: number;
  /** Encours ÉCHU (balance âgée hors « pas encore dû ») — l'argent en retard chez les clients. */
  overdueCents: number;
  /** Pièces « émises sans envoi constaté » (tri : plus gros enjeu d'abord). */
  untransmitted: CollectionUntransmittedLine[];
}

export interface BusinessReviewCoverage {
  /** Premier mois mouvementé (facturé ou encaissé) — null si aucun mouvement. */
  firstMonth: string | null;
  monthsObserved: number;
  /** Mois clos observés (mois courant exclu) — pilote l'activation des comparatifs. */
  completeMonths: number;
}

export interface BusinessReview {
  coverage: BusinessReviewCoverage;
  /** Série dense (zéros explicites) de firstMonth au mois courant inclus. */
  series: MonthlyRevenuePoint[];
  currentMonth: CurrentMonthProgress;
  lastClosedComparison: ClosedMonthComparison | null;
  ytd: YtdComparison | null;
  dso: DsoView;
  topClients: TopClientsView;
  topExpenses: TopExpensesView;
  /** Cascade SIG de l'exercice en cours (01/01 → today). */
  sig: SigStatement;
  /** Position TVA courante — réutilise deriveVatPosition (une seule vérité TVA). */
  vat: VatPosition;
  ratios: BusinessRatios;
  quality: { invoicesWithoutDueDate: number };
  /** PR-07 — carte « Encaissement » (taux 90 j, encours échu, émises sans envoi constaté). */
  collection: CollectionView;
}

const DEFAULT_PERCENT_FLOOR_CENTS = 300_000;
const DEFAULT_CONCENTRATION_ALERT_BPS = 3_000;

const monthOf = (date: string): string => date.slice(0, 7);
const dayOf = (date: string): number => Number(date.slice(8, 10));

function previousMonthOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, '0')}`;
}

function lastDayOfMonth(month: string): number {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

/** Borne basse « il y a 12 mois » — convention canonique du repo (29/02 → 28/02). */
function oneYearBefore(date: DateOnly): DateOnly {
  const year = Number(date.slice(0, 4)) - 1;
  const monthDay = date.slice(5) === '02-29' ? '02-28' : date.slice(5);
  return `${year}-${monthDay}`;
}

/** bps entiers, null si la base est ≤ 0 (jamais un % contre une base négative ou nulle). */
function bps(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator * 10_000) / denominator);
}

/** Variation en bps, null si la base est ≤ 0 OU sous le plancher (« +240 % sur 800 € »). */
function deltaBpsOf(current: number, base: number, floorCents: number): number | null {
  if (base <= 0 || base < floorCents) return null;
  return Math.round(((current - base) * 10_000) / base);
}

/** Solde produit signé (crédit − débit) des lignes au préfixe donné. */
function signedRevenue(lines: readonly { account: string; debitCents: number; creditCents: number }[], prefix: string): number {
  let total = 0;
  for (const line of lines) if (line.account.startsWith(prefix)) total += line.creditCents - line.debitCents;
  return total;
}

export function deriveBusinessReview(input: BusinessReviewInput): BusinessReview {
  const today = input.today;
  const currentMonth = monthOf(today);
  const floorCents = input.params?.percentFloorCents ?? DEFAULT_PERCENT_FLOOR_CENTS;
  const concentrationAlertBps = input.params?.concentrationAlertBps ?? DEFAULT_CONCENTRATION_ALERT_BPS;

  // ── Séries mensuelles : facturé (écritures 70x) et encaissé (paiements) ────────────
  const invoicedByMonth = new Map<string, number>();
  for (const entry of input.entries) {
    const revenue = signedRevenue(entry.lines, '70');
    if (revenue === 0) continue;
    const month = monthOf(entry.entryDate);
    invoicedByMonth.set(month, (invoicedByMonth.get(month) ?? 0) + revenue);
  }
  const collectedByMonth = new Map<string, number>();
  for (const payment of input.payments) {
    const month = monthOf(payment.receivedAt);
    collectedByMonth.set(month, (collectedByMonth.get(month) ?? 0) + payment.amountCents);
  }

  const movedMonths = [...new Set([...invoicedByMonth.keys(), ...collectedByMonth.keys()])].filter((m) => m <= currentMonth).sort();
  const firstMonth = movedMonths[0] ?? null;

  const series: MonthlyRevenuePoint[] = [];
  if (firstMonth !== null) {
    let month = firstMonth;
    for (;;) {
      series.push({
        month,
        invoicedHtCents: invoicedByMonth.get(month) ?? 0,
        collectedTtcCents: collectedByMonth.get(month) ?? 0,
      });
      if (month === currentMonth) break;
      month = nextMonthOf(month);
    }
  }

  const completeMonths = series.filter((point) => point.month < currentMonth).length;
  const coverage: BusinessReviewCoverage = { firstMonth, monthsObserved: series.length, completeMonths };

  // ── Mois courant à isopérimètre de jours (jamais de comparaison plein-mois) ────────
  const atDay = dayOf(today);
  const prevMonth = previousMonthOf(currentMonth);
  const prevCutoffDay = Math.min(atDay, lastDayOfMonth(prevMonth));
  let curInvoiced = 0;
  let prevInvoicedIso = 0;
  for (const entry of input.entries) {
    const revenue = signedRevenue(entry.lines, '70');
    if (revenue === 0) continue;
    const month = monthOf(entry.entryDate);
    if (month === currentMonth && entry.entryDate <= today) curInvoiced += revenue;
    else if (month === prevMonth && dayOf(entry.entryDate) <= prevCutoffDay) prevInvoicedIso += revenue;
  }
  let curCollected = 0;
  let prevCollectedIso = 0;
  for (const payment of input.payments) {
    const day = payment.receivedAt.slice(0, 10);
    const month = monthOf(day);
    if (month === currentMonth && day <= today) curCollected += payment.amountCents;
    else if (month === prevMonth && dayOf(day) <= prevCutoffDay) prevCollectedIso += payment.amountCents;
  }
  const currentMonthProgress: CurrentMonthProgress = {
    month: currentMonth,
    atDay,
    invoicedHtCents: curInvoiced,
    collectedTtcCents: curCollected,
    previousInvoicedHtCents: prevInvoicedIso,
    previousCollectedTtcCents: prevCollectedIso,
    invoicedDeltaBps: deltaBpsOf(curInvoiced, prevInvoicedIso, floorCents),
  };

  // ── Dernier mois clos vs son précédent (dès 2 mois clos observés) ──────────────────
  const closed = series.filter((point) => point.month < currentMonth);
  let lastClosedComparison: ClosedMonthComparison | null = null;
  if (closed.length >= 2) {
    const last = closed[closed.length - 1]!;
    const before = closed[closed.length - 2]!;
    lastClosedComparison = {
      month: last.month,
      previousMonth: before.month,
      invoicedHtCents: last.invoicedHtCents,
      previousInvoicedHtCents: before.invoicedHtCents,
      deltaCents: last.invoicedHtCents - before.invoicedHtCents,
      deltaBps: deltaBpsOf(last.invoicedHtCents, before.invoicedHtCents, floorCents),
    };
  }

  // ── Cumul annuel vs N-1 — seulement à couverture complète de la période miroir ─────
  const year = today.slice(0, 4);
  const mirror = oneYearBefore(today);
  let ytd: YtdComparison | null = null;
  if (firstMonth !== null && firstMonth <= `${Number(year) - 1}-01`) {
    let current = 0;
    let previous = 0;
    for (const entry of input.entries) {
      const revenue = signedRevenue(entry.lines, '70');
      if (revenue === 0) continue;
      if (entry.entryDate >= `${year}-01-01` && entry.entryDate <= today) current += revenue;
      else if (entry.entryDate >= `${Number(year) - 1}-01-01` && entry.entryDate <= mirror) previous += revenue;
    }
    ytd = {
      invoicedHtCents: current,
      previousYearInvoicedHtCents: previous,
      deltaCents: current - previous,
      deltaBps: deltaBpsOf(current, previous, floorCents),
    };
  }

  // ── DSO 90 jours ────────────────────────────────────────────────────────────────────
  const agedBalance = deriveAgedBalance({ invoices: input.invoices, customers: input.customers, today });
  const dsoFloor = addDays(today, -90);
  let invoicedTtc90d = 0;
  let firstInvoiceEntryDate: DateOnly | null = null;
  for (const entry of input.entries) {
    if (entry.sourceType !== 'invoice') continue;
    if (firstInvoiceEntryDate === null || entry.entryDate < firstInvoiceEntryDate) firstInvoiceEntryDate = entry.entryDate;
    if (entry.entryDate > dsoFloor && entry.entryDate <= today) {
      // Créance TTC née = mouvements 411 des écritures de facture — les encaissements
      // créditent 411 au journal bank (sourceType 'payment') et sont exclus d'office.
      for (const line of entry.lines) if (line.account.startsWith('411')) invoicedTtc90d += line.debitCents - line.creditCents;
    }
  }
  let dso: DsoView;
  if (firstInvoiceEntryDate === null || firstInvoiceEntryDate > dsoFloor) {
    dso = { days: null, reason: 'insufficient_history', receivablesCents: agedBalance.totalCents, invoicedTtc90dCents: invoicedTtc90d };
  } else if (invoicedTtc90d <= 0) {
    dso = { days: null, reason: 'no_recent_invoicing', receivablesCents: agedBalance.totalCents, invoicedTtc90dCents: invoicedTtc90d };
  } else if (agedBalance.totalCents <= 0) {
    dso = { days: 0, reason: 'all_collected', receivablesCents: agedBalance.totalCents, invoicedTtc90dCents: invoicedTtc90d };
  } else {
    dso = {
      days: Math.round((agedBalance.totalCents * 90) / invoicedTtc90d),
      reason: 'ok',
      receivablesCents: agedBalance.totalCents,
      invoicedTtc90dCents: invoicedTtc90d,
    };
  }

  // ── Top clients (assiette C13 réutilisée : netToPay signé, 12 mois sur dueAt) ───────
  const byCustomer = new Map<string, AgedBalanceInvoiceData[]>();
  for (const invoice of input.invoices) {
    const list = byCustomer.get(invoice.customerId) ?? [];
    list.push(invoice);
    byCustomer.set(invoice.customerId, list);
  }
  const names = new Map(input.customers.map((customer) => [customer.id, customer.name]));
  const totalsByCustomer = [...byCustomer.entries()]
    .map(([customerId, invoices]) => ({
      customerId,
      customerName: names.get(customerId) ?? '',
      totalCents: revenueLast12MonthsCents(invoices, today),
    }))
    .filter((line) => line.totalCents !== 0);
  const positives = totalsByCustomer
    .filter((line) => line.totalCents > 0)
    .sort((a, b) => b.totalCents - a.totalCents || a.customerName.localeCompare(b.customerName, 'fr'));
  const negatives = totalsByCustomer.filter((line) => line.totalCents < 0);
  const clientsTotal = totalsByCustomer.reduce((sum, line) => sum + line.totalCents, 0);
  const topLines = positives.slice(0, 5).map((line) => ({
    customerId: line.customerId,
    customerName: line.customerName,
    invoicedTtc12mCents: line.totalCents,
    shareBps: bps(line.totalCents, clientsTotal),
  }));
  const others = positives.slice(5);
  const top1ShareBps = topLines[0]?.shareBps ?? null;
  const topClients: TopClientsView = {
    lines: topLines,
    othersCents: others.reduce((sum, line) => sum + line.totalCents, 0),
    othersCount: others.length,
    creditNetCents: negatives.reduce((sum, line) => sum + line.totalCents, 0),
    creditNetCount: negatives.length,
    totalCents: clientsTotal,
    top1ShareBps,
    concentrationAlert: top1ShareBps !== null && top1ShareBps >= concentrationAlertBps,
  };

  // ── Top postes de dépense (charge comptabilisée, 12 mois sur documentDate) ─────────
  const from12 = oneYearBefore(today);
  const from24 = oneYearBefore(from12);
  const isFranchise = input.vatRegime === 'franchise';
  const chargeOf = (expense: BusinessReviewExpenseData): number =>
    isFranchise ? expense.totalTtcCents : expense.totalTtcCents - (expense.vatCents ?? 0);
  const currentByCategory = new Map<ExpenseCategory, number>();
  const previousByCategory = new Map<ExpenseCategory, number>();
  for (const expense of input.expenses) {
    if (expense.documentDate > today) continue;
    const charge = chargeOf(expense);
    if (expense.documentDate >= from12) {
      currentByCategory.set(expense.category, (currentByCategory.get(expense.category) ?? 0) + charge);
    } else if (expense.documentDate >= from24) {
      previousByCategory.set(expense.category, (previousByCategory.get(expense.category) ?? 0) + charge);
    }
  }
  const expenseLines = [...currentByCategory.entries()]
    .map(([category, chargeCents]) => {
      const previousChargeCents = previousByCategory.get(category) ?? 0;
      return { category, chargeCents, previousChargeCents, deltaBps: deltaBpsOf(chargeCents, previousChargeCents, floorCents) };
    })
    .sort((a, b) => b.chargeCents - a.chargeCents || a.category.localeCompare(b.category, 'fr'));
  const topExpenses: TopExpensesView = {
    lines: expenseLines.slice(0, 5),
    othersCents: expenseLines.slice(5).reduce((sum, line) => sum + line.chargeCents, 0),
    totalCents: expenseLines.reduce((sum, line) => sum + line.chargeCents, 0),
  };

  // ── SIG, compte de résultat et ratios de l'exercice en cours ───────────────────────
  const exerciseEntries = input.entries.filter((entry) => entry.entryDate >= `${year}-01-01` && entry.entryDate <= today);
  const sig = deriveSig(exerciseEntries);
  const incomeStatement = deriveIncomeStatement(exerciseEntries);
  const caCents = exerciseEntries.reduce((sum, entry) => sum + signedRevenue(entry.lines, '70'), 0);
  const personnelMoved = sig.chargesPersonnelCents !== 0;
  const ratios: BusinessRatios = {
    caCents,
    ebeBps: bps(sig.ebeCents, caCents),
    chargesExternesBps: bps(sig.consommationsCents, caCents),
    rexBps: bps(sig.resultatExploitationCents, caCents),
    netBps: bps(incomeStatement.resultatNetCents, caCents),
    vaBps: bps(sig.valeurAjouteeCents, caCents),
    personnelVaBps: personnelMoved ? bps(sig.chargesPersonnelCents, sig.valeurAjouteeCents) : null,
    margeMateriauxBps: sig.margeCommercialeActive ? bps(sig.margeCommercialeCents, sig.margeCommercialeProduitsCents) : null,
  };

  // ── Position TVA (réutilisée, jamais recalculée depuis le grand livre) ──────────────
  const vat = deriveVatPosition({
    vatRegime: input.vatRegime,
    invoices: input.invoices,
    expenses: input.expenses,
  });

  const quality = {
    invoicesWithoutDueDate: input.invoices.filter(
      (invoice) => invoice.dueAt === null && invoice.status !== 'draft' && invoice.status !== 'cancelled',
    ).length,
  };

  // ── PR-07 — carte « Encaissement » : % encaissé 90 j + encours échu + émises sans envoi ────
  // Encaissé TTC sur la MÊME fenêtre 90 j que le facturé du DSO (dsoFloor exclusif → today).
  let collectedTtc90d = 0;
  for (const payment of input.payments) {
    const day = payment.receivedAt.slice(0, 10);
    if (day > dsoFloor && day <= today) collectedTtc90d += payment.amountCents;
  }
  // Mêmes gates d'honnêteté temporelle que le DSO : moins de 90 j d'historique de facturation →
  // null assumé ; fenêtre sans facturation (ou avoirs > factures) → null, jamais un % fabriqué.
  let collectionRate: { collectedRateBps90d: number | null; reason: CollectionView['reason'] };
  if (firstInvoiceEntryDate === null || firstInvoiceEntryDate > dsoFloor) {
    collectionRate = { collectedRateBps90d: null, reason: 'insufficient_history' };
  } else if (invoicedTtc90d <= 0) {
    collectionRate = { collectedRateBps90d: null, reason: 'no_recent_invoicing' };
  } else {
    collectionRate = { collectedRateBps90d: bps(collectedTtc90d, invoicedTtc90d), reason: 'ok' };
  }
  // Encours ÉCHU — DÉJÀ calculé par la balance âgée (une seule vérité : deriveAgedBalance).
  const overdueCents = agedBalance.overdueCents;
  // « Émises sans envoi constaté » — prédicat PR-02 (fail-closed : projections muettes = rien),
  // identité requise (une ligne actionnable sans id ne mène nulle part).
  const untransmitted: CollectionUntransmittedLine[] = [];
  for (const invoice of input.invoices) {
    if (invoice.id === undefined) continue;
    if (
      !isIssuedNeverTransmitted({
        kind: invoice.kind,
        status: invoice.status,
        ...(invoice.emailDeliveredAt !== undefined
          ? { emailDeliveredAt: invoice.emailDeliveredAt }
          : {}),
        ...(invoice.transmission !== undefined ? { transmission: invoice.transmission } : {}),
      })
    )
      continue;
    const remaining = invoice.totals.netToPay - invoice.paid;
    if (remaining <= 0) continue;
    const customerName = names.get(invoice.customerId);
    if (customerName === undefined) continue;
    untransmitted.push({
      invoiceId: invoice.id,
      docNumber: invoice.number ?? null,
      customerId: invoice.customerId,
      customerName,
      amountCents: remaining,
    });
  }
  untransmitted.sort((a, b) => b.amountCents - a.amountCents);
  const collection: CollectionView = {
    collectedRateBps90d: collectionRate.collectedRateBps90d,
    reason: collectionRate.reason,
    collectedTtc90dCents: collectedTtc90d,
    invoicedTtc90dCents: invoicedTtc90d,
    overdueCents,
    untransmitted,
  };

  return {
    coverage,
    series,
    currentMonth: currentMonthProgress,
    lastClosedComparison,
    ytd,
    dso,
    topClients,
    topExpenses,
    sig,
    vat,
    ratios,
    quality,
    collection,
  };
}

function nextMonthOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
}
