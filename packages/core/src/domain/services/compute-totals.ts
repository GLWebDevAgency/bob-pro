import { type LineInput } from '../billing/shared/line-item';
import { type Totals } from '../billing/shared/totals';
import { type VatRate } from '../billing/shared/vat-rate';

/** Arrondi commercial (half-up) de la TVA pour une base donnee, en centimes. */
export function roundVatForBase(baseCents: number, rate: VatRate): number {
  return Math.round((baseCents * rate) / 100);
}

/**
 * Totaux d'un document. Arrondi TVA par TAUX (somme des bases d'un meme taux),
 * source unique de la politique d'arrondi (cf. blueprint M10).
 */
export function computeTotals(lines: LineInput[], opts?: { depositPct?: number }): Totals {
  const baseByRate = new Map<VatRate, number>();
  let ht = 0;
  for (const l of lines) {
    const base = Math.round(l.qty * l.unitPriceHT);
    ht += base;
    baseByRate.set(l.vatRate, (baseByRate.get(l.vatRate) ?? 0) + base);
  }
  const vatByRate: Record<string, number> = {};
  let vat = 0;
  for (const [rate, base] of baseByRate) {
    const v = roundVatForBase(base, rate);
    vatByRate[String(rate)] = v;
    vat += v;
  }
  const ttc = ht + vat;
  const netToPay = opts?.depositPct ? Math.round((ttc * opts.depositPct) / 100) : ttc;
  return { ht, vatByRate, vat, ttc, netToPay };
}
