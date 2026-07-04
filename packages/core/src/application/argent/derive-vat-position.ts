import { type Totals } from '../../domain/billing/shared/totals';
import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus } from '../../domain/billing/shared/state-machines';

/**
 * Position de TVA RÉELLE (audit expert-comptable, chantier 2) — use case pur, une seule
 * vérité pour le cashflow, le KPI du briefing et Bob (« combien de TVA je dois ? »).
 *
 * Règles retenues (prestations de services d'artisan — TVA SUR LES ENCAISSEMENTS,
 * art. 269, 2-c CGI) :
 * · collectée = pour chaque pièce vivante, la TVA CONTENUE dans ce qui est encaissé :
 *   round(vat × paid / ttc) — le prorata au TTC du chantier rend exactement la TVA d'un
 *   acompte (ex. 48 840 × 27 133 / 162 800 = 8 140) et celle d'un solde après déduction ;
 * · avoirs émis : régularisation dès l'émission (position prudente v1) — TVA soustraite ;
 * · déductible = Σ des TVA MENTIONNÉES sur les dépenses (vatCents non null — miroir du
 *   44566 posté par le cycle achats E1 ; pas de TVA sur la pièce → pas de déduction) ;
 * · le net se lit en deux temps : netDueCents (à provisionner, plancher 0) et
 *   creditCents (crédit de TVA reportable) — jamais un « dû négatif » ambigu.
 */

export interface VatPositionInvoiceData {
  kind: InvoiceKind;
  status: InvoiceStatus;
  totals: Totals;
  /** Centimes encaissés cumulés (plafonnés netToPay par le domaine). */
  paid: number;
}

export interface VatPositionExpenseData {
  vatCents: number | null;
}

export interface VatPosition {
  /** TVA contenue dans les encaissements (moins les avoirs émis), plancher 0. */
  collectedCents: number;
  /** TVA déductible mentionnée sur les dépenses. */
  deductibleCents: number;
  /** À provisionner : max(0, collectée − déductible). */
  netDueCents: number;
  /** Crédit de TVA reportable : max(0, déductible − collectée). */
  creditCents: number;
}

export function deriveVatPosition(input: {
  invoices: readonly VatPositionInvoiceData[];
  expenses: readonly VatPositionExpenseData[];
}): VatPosition {
  let collected = 0;
  for (const invoice of input.invoices) {
    if (invoice.status === 'draft' || invoice.status === 'cancelled') continue;
    if (invoice.kind === 'credit_note') {
      collected -= invoice.totals.vat;
      continue;
    }
    if (invoice.totals.ttc <= 0 || invoice.paid <= 0) continue;
    const paid = Math.min(invoice.paid, invoice.totals.netToPay);
    collected += Math.round((invoice.totals.vat * paid) / invoice.totals.ttc);
  }
  const collectedCents = Math.max(0, collected);
  const deductibleCents = input.expenses.reduce((sum, expense) => sum + (expense.vatCents ?? 0), 0);
  const net = collectedCents - deductibleCents;
  return {
    collectedCents,
    deductibleCents,
    netDueCents: Math.max(0, net),
    creditCents: Math.max(0, -net),
  };
}
