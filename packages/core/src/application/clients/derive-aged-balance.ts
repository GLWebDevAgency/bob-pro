import { type DateOnly } from '../../shared-kernel/time';
import { type Totals } from '../../domain/billing/shared/totals';
import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus } from '../../domain/billing/shared/state-machines';

/**
 * Balance âgée clients (E5, audit expert-comptable) — LE tableau de pilotage du poste
 * clients : combien est dû, depuis combien de temps, par qui. Use case pur, une seule
 * vérité pour l'écran Argent, la fiche client et Bob (« qui me doit quoi ? »).
 *
 * Règles :
 * · assiette = netToPay − paid (jamais ttc — doctrine billing), statuts encaissables ;
 * · avoirs émis en NÉGATIF dans leur tranche (ils réduisent le dû réel) ;
 * · tranches par retard d'échéance : non échu · 1-30 · 31-60 · 61-90 · +90 jours
 *   (au-delà de 90 j : risque d'irrécouvrabilité — provision clients douteux à envisager) ;
 * · pièce sans échéance → tranche « unknown » (jamais devinée).
 */

export type AgedBucketKey = 'not_due' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'unknown';

export const AGED_BUCKETS: readonly AgedBucketKey[] = ['not_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'unknown'];

export interface AgedBalanceInvoiceData {
  kind: InvoiceKind;
  status: InvoiceStatus;
  totals: Totals;
  paid: number;
  dueAt: DateOnly | null;
  customerId: string;
}

export interface AgedBalanceCustomerData {
  id: string;
  name: string;
}

export type AgedBuckets = Record<AgedBucketKey, number>;

export interface AgedCustomerLine {
  customerId: string;
  customerName: string;
  buckets: AgedBuckets;
  totalCents: number;
  /** Retard maximal constaté (jours) — 0 si rien d'échu. */
  maxDaysLate: number;
}

export interface AgedBalance {
  buckets: AgedBuckets;
  totalCents: number;
  /** Dû strictement échu (tranches 1-30 → +90). */
  overdueCents: number;
  /** Par client, trié du plus gros dû au plus petit — clients à zéro exclus. */
  byCustomer: AgedCustomerLine[];
}

const COLLECTIBLE: ReadonlySet<InvoiceStatus> = new Set(['issued', 'partially_paid', 'late']);
const MS_PER_DAY = 86_400_000;

function emptyBuckets(): AgedBuckets {
  return { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unknown: 0 };
}

function daysLate(dueAt: DateOnly, today: DateOnly): number {
  return Math.round((Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${dueAt}T00:00:00.000Z`)) / MS_PER_DAY);
}

function bucketOf(dueAt: DateOnly | null, today: DateOnly): AgedBucketKey {
  if (dueAt === null) return 'unknown';
  const late = daysLate(dueAt, today);
  if (late <= 0) return 'not_due';
  if (late <= 30) return 'd1_30';
  if (late <= 60) return 'd31_60';
  if (late <= 90) return 'd61_90';
  return 'd90_plus';
}

export function deriveAgedBalance(input: {
  invoices: readonly AgedBalanceInvoiceData[];
  customers: readonly AgedBalanceCustomerData[];
  today: DateOnly;
}): AgedBalance {
  const names = new Map(input.customers.map((c) => [c.id, c.name]));
  const total = emptyBuckets();
  const perCustomer = new Map<string, { buckets: AgedBuckets; maxDaysLate: number }>();

  for (const invoice of input.invoices) {
    if (!COLLECTIBLE.has(invoice.status)) continue;
    const remaining = Math.max(0, invoice.totals.netToPay - invoice.paid);
    if (remaining === 0) continue;
    const signed = invoice.kind === 'credit_note' ? -remaining : remaining;
    const bucket = bucketOf(invoice.dueAt, input.today);

    total[bucket] += signed;
    const line = perCustomer.get(invoice.customerId) ?? { buckets: emptyBuckets(), maxDaysLate: 0 };
    line.buckets[bucket] += signed;
    if (invoice.dueAt !== null && invoice.kind !== 'credit_note')
      line.maxDaysLate = Math.max(line.maxDaysLate, Math.max(0, daysLate(invoice.dueAt, input.today)));
    perCustomer.set(invoice.customerId, line);
  }

  const sum = (buckets: AgedBuckets): number => AGED_BUCKETS.reduce((acc, key) => acc + buckets[key], 0);
  const overdue = (buckets: AgedBuckets): number =>
    buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90_plus;

  const byCustomer: AgedCustomerLine[] = [...perCustomer.entries()]
    .map(([customerId, line]) => ({
      customerId,
      customerName: names.get(customerId) ?? '',
      buckets: line.buckets,
      totalCents: sum(line.buckets),
      maxDaysLate: line.maxDaysLate,
    }))
    .filter((line) => line.totalCents !== 0)
    .sort((a, b) => b.totalCents - a.totalCents);

  return { buckets: total, totalCents: sum(total), overdueCents: overdue(total), byCustomer };
}
