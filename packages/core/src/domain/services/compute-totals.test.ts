import { describe, it, expect } from 'vitest';
import { computeTotals } from './compute-totals';
import { type LineInput } from '../billing/shared/line-item';

const chauffeEau: LineInput[] = [
  { label: 'Chauffe-eau 200 L', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
  { label: "Main d'oeuvre", category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
];

describe("computeTotals — test d'or chauffe-eau", () => {
  it('HT 1480 / TVA10 148 / TTC 1628', () => {
    const t = computeTotals(chauffeEau);
    expect(t.ht).toBe(148000);
    expect(t.vatByRate['10']).toBe(14800);
    expect(t.vat).toBe(14800);
    expect(t.ttc).toBe(162800);
    expect(t.netToPay).toBe(162800);
  });
  it("acompte 30% => net 488,40 EUR (48840 centimes)", () => {
    const t = computeTotals(chauffeEau, { depositPct: 30 });
    expect(t.netToPay).toBe(48840);
  });
  it('multi-taux : arrondis independants, somme exacte', () => {
    const lines: LineInput[] = [
      { label: 'A', category: 'supply', qty: 1, unitPriceHT: 999, vatRate: 20 },
      { label: 'B', category: 'labor', qty: 1, unitPriceHT: 1001, vatRate: 10 },
    ];
    const t = computeTotals(lines);
    expect(t.vatByRate['20']).toBe(200);
    expect(t.vatByRate['10']).toBe(100);
    expect(t.vat).toBe(300);
    expect(t.ttc).toBe(999 + 1001 + 300);
  });
});
