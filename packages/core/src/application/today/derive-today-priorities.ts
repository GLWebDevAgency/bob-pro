import { type DateOnly } from '../../shared-kernel/time';
import { type Totals } from '../../domain/billing/shared/totals';
import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus, type QuoteStatus } from '../../domain/billing/shared/state-machines';
import { type ComplianceItem } from '../../domain/compliance/diagnostic';

/**
 * Use case pur « priorités du jour » (claim C10, amendement A1-C10).
 * Entrée = données RÉELLES projetées (factures/devis/clients tels que servis par l'api-client),
 * sortie = TodayPriority[] triées, prêtes pour l'UI. Aucune I/O, aucun repli fixtures :
 * l'absence de données produit simplement zéro priorité (l'état vide est un état de premier rang).
 */

// ── Entrées (projections minimales, structurellement compatibles avec les vues api-client) ──

export interface TodayInvoiceData {
  id: string;
  customerId: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  number: string | null;
  parentQuoteId: string | null;
  totals: Totals;
  dueAt: DateOnly | null;
  paid: number; // centimes encaissés cumulés
}

export interface TodayQuoteData {
  id: string;
  customerId: string;
  status: QuoteStatus;
  number: string | null;
  totals: Totals;
}

export interface TodayCustomerData {
  id: string;
  name: string;
}

/**
 * Signal conformité de l'entreprise, fourni par la composition (diagnostic réel).
 * Optionnel : sans signal, on N'INVENTE PAS de priorité conformité.
 */
export interface TodayCompanyData {
  /** Réception des factures électroniques (échéance 2026-09-01) déjà configurée ? */
  einvoiceReceptionConfigured: boolean;
}

export interface DeriveTodayPrioritiesInput {
  invoices: readonly TodayInvoiceData[];
  quotes: readonly TodayQuoteData[];
  customers: readonly TodayCustomerData[];
  company?: TodayCompanyData;
  today: DateOnly;
}

// ── Sortie (union discriminée consommée par l'écran Aujourd'hui) ──

export interface RelancePriority {
  kind: 'relance';
  id: string;
  invoiceId: string;
  customerId: string;
  customerName: string;
  docNumber: string | null;
  /** Reste à encaisser en centimes — plafonné à netToPay (jamais ttc) : netToPay − paid. */
  amountCents: number;
  daysLate: number;
}

export interface FactureFinalePriority {
  kind: 'facture_finale';
  id: string;
  quoteId: string;
  customerId: string;
  customerName: string;
  /** Numéro du devis signé (référence visible côté UI). */
  docNumber: string | null;
  /** Restant à facturer en centimes = ttc du devis − netToPay (acompte net) de la facture d'acompte payée. */
  amountCents: number;
}

export interface ConformitePriority {
  kind: 'conformite';
  id: string;
}

export type TodayPriority = RelancePriority | FactureFinalePriority | ConformitePriority;

// ── Règles métier ──

/** Statuts encore encaissables : une facture payée/annulée/brouillon ne se relance pas. */
const COLLECTIBLE: ReadonlySet<InvoiceStatus> = new Set(['issued', 'partially_paid', 'late']);

const MS_PER_DAY = 86_400_000;

/** Jours calendaires entiers entre deux DateOnly (UTC, sans dépendance). */
function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY);
}

function customerNameIndex(customers: readonly TodayCustomerData[]): ReadonlyMap<string, string> {
  return new Map(customers.map((c) => [c.id, c.name]));
}

/**
 * Facture en retard : statut encaissable, reste dû strictement positif, et échéance dépassée
 * (statut `late` posé par le backend, ou dueAt < today). Les avoirs sont hors périmètre relance.
 */
function overdueRemainingCents(invoice: TodayInvoiceData, today: DateOnly): number | null {
  if (invoice.kind === 'credit_note') return null;
  if (!COLLECTIBLE.has(invoice.status)) return null;
  const remaining = invoice.totals.netToPay - invoice.paid;
  if (remaining <= 0) return null;
  const overdue = invoice.status === 'late' || (invoice.dueAt !== null && invoice.dueAt < today);
  return overdue ? remaining : null;
}

function deriveRelances(input: DeriveTodayPrioritiesInput, names: ReadonlyMap<string, string>): RelancePriority[] {
  const relances: RelancePriority[] = [];
  for (const invoice of input.invoices) {
    const remaining = overdueRemainingCents(invoice, input.today);
    if (remaining === null) continue;
    relances.push({
      kind: 'relance',
      id: `relance-${invoice.id}`,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      customerName: names.get(invoice.customerId) ?? '',
      docNumber: invoice.number,
      amountCents: remaining,
      daysLate: invoice.dueAt !== null ? Math.max(0, daysBetween(invoice.dueAt, input.today)) : 0,
    });
  }
  // Tri : retard le plus long d'abord, puis montant le plus élevé (contrat C10 v1.1).
  return relances.sort((a, b) => b.daysLate - a.daysLate || b.amountCents - a.amountCents);
}

function deriveFacturesFinales(
  input: DeriveTodayPrioritiesInput,
  names: ReadonlyMap<string, string>,
): FactureFinalePriority[] {
  const childrenByQuote = new Map<string, TodayInvoiceData[]>();
  for (const invoice of input.invoices) {
    if (invoice.parentQuoteId === null) continue;
    const children = childrenByQuote.get(invoice.parentQuoteId);
    if (children) children.push(invoice);
    else childrenByQuote.set(invoice.parentQuoteId, [invoice]);
  }

  const finales: FactureFinalePriority[] = [];
  for (const quote of input.quotes) {
    if (quote.status !== 'signed') continue;
    const children = childrenByQuote.get(quote.id) ?? [];
    // Il faut un acompte ENCAISSÉ (payé), et aucune facture finale déjà engagée (même en brouillon).
    const depositPaid = children.find((i) => i.kind === 'deposit' && i.status === 'paid');
    if (!depositPaid) continue;
    if (children.some((i) => i.kind === 'final' && i.status !== 'cancelled')) continue;
    // Restant = ttc du devis − acompte net (netToPay de la facture d'acompte) — cohérent billing-nettopay.
    const remaining = quote.totals.ttc - depositPaid.totals.netToPay;
    if (remaining <= 0) continue;
    finales.push({
      kind: 'facture_finale',
      id: `facture-finale-${quote.id}`,
      quoteId: quote.id,
      customerId: quote.customerId,
      customerName: names.get(quote.customerId) ?? '',
      docNumber: quote.number,
      amountCents: remaining,
    });
  }
  return finales.sort((a, b) => b.amountCents - a.amountCents);
}

function deriveConformite(input: DeriveTodayPrioritiesInput): ConformitePriority[] {
  // Une seule priorité conformité au maximum, et uniquement sur signal réel (jamais par défaut).
  if (input.company === undefined || input.company.einvoiceReceptionConfigured) return [];
  return [{ kind: 'conformite', id: 'conformite-einvoice-2026' }];
}

/**
 * Dérive les priorités du briefing « Aujourd'hui » :
 * 1. relances — factures échues non payées (retard desc, puis montant desc) ;
 * 2. factures finales — devis signés dont l'acompte est encaissé mais sans facture finale ;
 * 3. conformité — préparation facturation électronique 2026 non configurée (1 max).
 * Tri global : relances d'abord ; le cap d'affichage est géré par l'UI.
 */
export function deriveTodayPriorities(input: DeriveTodayPrioritiesInput): TodayPriority[] {
  const names = customerNameIndex(input.customers);
  return [...deriveRelances(input, names), ...deriveFacturesFinales(input, names), ...deriveConformite(input)];
}

/**
 * Projette le diagnostic conformité réel vers le signal attendu par deriveTodayPriorities.
 * Item `einvoice-reception` à `todo` → non configuré ; item absent (pays non couvert) → rien à préparer.
 */
export function todayCompanyFromDiagnostic(diagnostic: {
  items: readonly Pick<ComplianceItem, 'id' | 'status'>[];
}): TodayCompanyData {
  const reception = diagnostic.items.find((item) => item.id === 'einvoice-reception');
  return { einvoiceReceptionConfigured: reception === undefined || reception.status !== 'todo' };
}
