import { describe, it, expect } from 'vitest';
import { allocateByLargestRemainder, computeLineBases, computeTotals, discountableNetHtCents } from './compute-totals';
import { type LineInput } from '../billing/shared/line-item';
import { type Discount } from '../billing/shared/discount';

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

describe('allocateByLargestRemainder (B3/B2 — politique unique)', () => {
  it('la somme des parts vaut exactement la cible', () => {
    expect(allocateByLargestRemainder([100, 100, 100], 100)).toEqual([34, 33, 33]);
    expect(allocateByLargestRemainder([1, 1, 1], 2)).toEqual([1, 1, 0]);
  });
  it('cible nulle ou poids nuls : zéros', () => {
    expect(allocateByLargestRemainder([10, 20], 0)).toEqual([0, 0]);
    expect(allocateByLargestRemainder([0, 0], 50)).toEqual([0, 0]);
  });
  it('part bornée par le poids quand la cible ≤ total', () => {
    const parts = allocateByLargestRemainder([1, 999], 500);
    expect(parts[0]! <= 1).toBe(true);
    expect(parts[0]! + parts[1]!).toBe(500);
  });
});

describe('computeTotals — remises B3 (assiette TVA par taux APRÈS remises)', () => {
  it('remise de ligne en % : assiette réduite avant TVA', () => {
    const lines: LineInput[] = [
      { label: 'A', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 10, discount: { type: 'percent', value: 10 } },
    ];
    const t = computeTotals(lines);
    expect(t.ht).toBe(90000);
    expect(t.vatByRate['10']).toBe(9000);
    expect(t.ttc).toBe(99000);
    expect(t.grossHt).toBe(100000);
    expect(t.discountCents).toBe(10000);
  });
  it('remise de ligne en montant : déduite de SA ligne seulement', () => {
    const lines: LineInput[] = [
      { label: 'A', category: 'labor', qty: 1, unitPriceHT: 50000, vatRate: 20, discount: { type: 'amount', cents: 5000 } },
      { label: 'B', category: 'supply', qty: 1, unitPriceHT: 30000, vatRate: 10 },
    ];
    const t = computeTotals(lines);
    expect(t.ht).toBe(75000);
    expect(t.vatByRate['20']).toBe(9000); // 45 000 × 20 %
    expect(t.vatByRate['10']).toBe(3000); // 30 000 × 10 %
    expect(t.discountCents).toBe(5000);
  });
  it('remise globale en % : répartie entre lignes, TVA par taux sur bases nettes', () => {
    const lines: LineInput[] = [
      { label: 'A', category: 'labor', qty: 1, unitPriceHT: 60000, vatRate: 20 },
      { label: 'B', category: 'supply', qty: 1, unitPriceHT: 40000, vatRate: 10 },
    ];
    const t = computeTotals(lines, { globalDiscount: { type: 'percent', value: 10 } });
    expect(t.ht).toBe(90000);
    expect(t.vatByRate['20']).toBe(10800); // 54 000 × 20 %
    expect(t.vatByRate['10']).toBe(3600); // 36 000 × 10 %
    expect(t.discountCents).toBe(10000);
    expect(t.grossHt).toBe(100000);
  });
  it('remise globale en montant : « je vous arrondis à… », somme répartie exacte', () => {
    const lines: LineInput[] = [
      { label: 'A', category: 'labor', qty: 1, unitPriceHT: 33333, vatRate: 20 },
      { label: 'B', category: 'supply', qty: 1, unitPriceHT: 33333, vatRate: 10 },
      { label: 'C', category: 'travel', qty: 1, unitPriceHT: 33334, vatRate: 5.5 },
    ];
    const t = computeTotals(lines, { globalDiscount: { type: 'amount', cents: 10000 } });
    expect(t.ht).toBe(90000);
    expect(t.discountCents).toBe(10000);
    // Conservation au centime : ht + vat = ttc, et la TVA par taux somme à vat.
    expect(Object.values(t.vatByRate).reduce((a, b) => a + b, 0)).toBe(t.vat);
    expect(t.ht + t.vat).toBe(t.ttc);
  });
  it('cumul remise de ligne PUIS remise globale (ordre du calcul)', () => {
    const lines: LineInput[] = [
      { label: 'A', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20, discount: { type: 'percent', value: 20 } },
    ];
    const t = computeTotals(lines, { globalDiscount: { type: 'percent', value: 10 } });
    // 100 000 − 20 % = 80 000 ; − 10 % = 72 000.
    expect(t.ht).toBe(72000);
    expect(t.vatByRate['20']).toBe(14400);
    expect(t.discountCents).toBe(28000);
  });
  it('acompte 30 % calculé APRÈS remises (net = % du TTC remisé)', () => {
    const lines: LineInput[] = [
      { label: 'A', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
      { label: 'B', category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
    ];
    const t = computeTotals(lines, { depositPct: 30, globalDiscount: { type: 'percent', value: 10 } });
    // HT 133 200, TVA 13 320, TTC 146 520 → acompte 30 % = 43 956.
    expect(t.ttc).toBe(146520);
    expect(t.netToPay).toBe(43956);
  });
  it('SANS remise : grossHt/discountCents ABSENTS — totaux antérieurs identiques au centime', () => {
    const lines: LineInput[] = [
      { label: 'A', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 },
    ];
    const t = computeTotals(lines);
    expect('grossHt' in t).toBe(false);
    expect('discountCents' in t).toBe(false);
  });
  it('produit cartésien remises × multi-taux : conservation ht + vat = ttc au centime', () => {
    const discounts: (Discount | undefined)[] = [
      undefined,
      { type: 'percent', value: 7.5 },
      { type: 'amount', cents: 137 },
    ];
    const globals: (Discount | null)[] = [
      null,
      { type: 'percent', value: 3.33 },
      { type: 'amount', cents: 501 },
    ];
    for (const d1 of discounts) {
      for (const d2 of discounts) {
        for (const g of globals) {
          const lines: LineInput[] = [
            { label: 'A', category: 'labor', qty: 1.5, unitPriceHT: 3333, vatRate: 20, ...(d1 ? { discount: d1 } : {}) },
            { label: 'B', category: 'supply', qty: 2, unitPriceHT: 4444, vatRate: 10, ...(d2 ? { discount: d2 } : {}) },
            { label: 'C', category: 'travel', qty: 1, unitPriceHT: 5555, vatRate: 5.5 },
            { label: 'D', category: 'disbursement', qty: 1, unitPriceHT: 1200, vatRate: 0 },
          ];
          const t = computeTotals(lines, { globalDiscount: g });
          expect(t.ht + t.vat).toBe(t.ttc);
          expect(Object.values(t.vatByRate).reduce((a, b) => a + b, 0)).toBe(t.vat);
          const { grossHt, netLineBases, discountCents } = computeLineBases(lines, { globalDiscount: g });
          expect(netLineBases.reduce((a, b) => a + b, 0)).toBe(t.ht);
          expect(grossHt - discountCents).toBe(t.ht);
          for (const base of netLineBases) expect(base >= 0).toBe(true);
        }
      }
    }
  });
});

describe('computeLineBases — B9 : la remise globale ne touche JAMAIS un débours (art. 267, II-2° CGI)', () => {
  // Scénario du finding : dépannage 1 000 € HT + débours 500 € avancé pour le client, remise 10 %.
  const depannage: LineInput[] = [
    { label: 'Dépannage', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 },
    { label: 'Pièce avancée', category: 'disbursement', qty: 1, unitPriceHT: 50000, vatRate: 0 },
  ];
  it('remise globale 10 % : assiette = 1 000 € (hors débours), le débours reste 500,00 € pile', () => {
    const { netLineBases, discountCents } = computeLineBases(depannage, {
      globalDiscount: { type: 'percent', value: 10 },
    });
    // 10 % de 1 000 € (jamais 10 % de 1 500 €) — tout imputé à la ligne remisable.
    expect(discountCents).toBe(10000);
    expect(netLineBases).toEqual([90000, 50000]);
  });
  it('remise globale en MONTANT : bornée au HT remisable — le débours reste intact', () => {
    const { netLineBases } = computeLineBases(depannage, {
      globalDiscount: { type: 'amount', cents: 120000 }, // > 1 000 € remisable
    });
    expect(netLineBases[0]).toBe(0); // ligne remisable épuisée
    expect(netLineBases[1]).toBe(50000); // débours jamais entamé
  });
  it('remise de LIGNE sur les autres postes + globale : le débours reste à l’euro près', () => {
    const lines: LineInput[] = [
      { label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 80000, vatRate: 10, discount: { type: 'percent', value: 5 } },
      { label: 'Frais avancés', category: 'disbursement', qty: 1, unitPriceHT: 12345, vatRate: 0 },
    ];
    const { netLineBases } = computeLineBases(lines, { globalDiscount: { type: 'percent', value: 7.5 } });
    expect(netLineBases[1]).toBe(12345);
  });
  it('pièce 100 % débours : remise globale sans effet (assiette remisable nulle)', () => {
    const lines: LineInput[] = [
      { label: 'Débours seul', category: 'disbursement', qty: 1, unitPriceHT: 50000, vatRate: 0 },
    ];
    const { netLineBases, discountCents } = computeLineBases(lines, {
      globalDiscount: { type: 'percent', value: 10 },
    });
    expect(discountCents).toBe(0);
    expect(netLineBases).toEqual([50000]);
  });
});

describe('discountableNetHtCents (B9 — plafond des remises globales en montant)', () => {
  it('somme les bases nettes de remises de ligne, HORS débours', () => {
    const lines: LineInput[] = [
      { label: 'A', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20, discount: { type: 'amount', cents: 10000 } },
      { label: 'B', category: 'disbursement', qty: 1, unitPriceHT: 50000, vatRate: 0 },
      { label: 'C', category: 'supply', qty: 2, unitPriceHT: 2500, vatRate: 20 },
    ];
    expect(discountableNetHtCents(lines)).toBe(95000); // (1 000 − 100) + 50 — sans les 500 € de débours
  });
  it('0 quand la pièce n’est faite que de débours', () => {
    expect(
      discountableNetHtCents([
        { label: 'D', category: 'disbursement', qty: 1, unitPriceHT: 9999, vatRate: 0 },
      ]),
    ).toBe(0);
  });
});
