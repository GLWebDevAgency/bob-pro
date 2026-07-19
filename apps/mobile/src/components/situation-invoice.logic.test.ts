import { describe, expect, it } from 'vitest';
import {
  defaultSituationPercent,
  derivePostesFromQuote,
  deriveSituationBasis,
  maxSituationPercent,
  situationAmountFromPercent,
  situationPercentFromPostes,
  stepSituationPercent,
  type SituationSiblingInvoice,
} from './situation-invoice.logic';

const sibling = (
  kind: SituationSiblingInvoice['kind'],
  status: SituationSiblingInvoice['status'],
  ht: number,
): SituationSiblingInvoice => ({ kind, status, totals: { ht } });

describe('situation-invoice.logic — base réelle et % atteignable (B2)', () => {
  it('marché vierge : rien facturé, 100 % atteignable', () => {
    const basis = deriveSituationBasis(100_000, []);
    expect(basis).toEqual({
      marketHtCents: 100_000,
      invoicedHtCents: 0,
      invoicedPct: 0,
      remainingHtCents: 100_000,
      maxPercent: 100,
      canInvoice: true,
    });
  });

  it('acompte + situations comptent dans le cumul ; avoirs et annulées jamais', () => {
    // Une finale ANNULÉE ne compte pas au cumul et ne ferme pas le marché ; une finale
    // VIVANTE le fermerait (cf. describe dédié — parité avec la garde serveur P0).
    const basis = deriveSituationBasis(100_000, [
      sibling('deposit', 'paid', 30_000),
      sibling('situation', 'issued', 20_000),
      sibling('situation', 'cancelled', 40_000),
      sibling('credit_note', 'issued', 50_000),
      sibling('final', 'cancelled', 100_000),
    ]);
    expect(basis.invoicedHtCents).toBe(50_000);
    expect(basis.invoicedPct).toBe(50);
    expect(basis.remainingHtCents).toBe(50_000);
    expect(basis.maxPercent).toBe(50);
    expect(basis.canInvoice).toBe(true);
  });

  it('marché couvert : plus aucune situation possible (état honnête, jamais un 422 fabriqué)', () => {
    const basis = deriveSituationBasis(100_000, [sibling('situation', 'issued', 100_000)]);
    expect(basis.canInvoice).toBe(false);
    expect(basis.maxPercent).toBe(0);
    expect(defaultSituationPercent(basis)).toBe(0);
  });

  it('même arrondi commercial que le serveur (montant depuis un %)', () => {
    expect(situationAmountFromPercent(162_800, 30)).toBe(48_840); // cas d'or 488,40 €
    expect(situationAmountFromPercent(100_001, 50)).toBe(50_001);
  });

  it('maxSituationPercent recule si l’arrondi du % dépasserait le reste', () => {
    // marché 999 c, reste 499 c : floor = 49 %, round(999×50/100)=500 > 499 — 49 % tient (490).
    expect(maxSituationPercent(999, 499)).toBe(49);
    expect(situationAmountFromPercent(999, 49)).toBeLessThanOrEqual(499);
    expect(maxSituationPercent(0, 100)).toBe(0);
    expect(maxSituationPercent(100_000, 0)).toBe(0);
  });

  it('steppers bornés [1, max] — jamais 0 ni au-delà du reste', () => {
    expect(stepSituationPercent(10, 5, 40)).toBe(15);
    expect(stepSituationPercent(2, -5, 40)).toBe(1);
    expect(stepSituationPercent(38, 5, 40)).toBe(40);
  });

  it('proposition d’ouverture : prochain quart atteignable, sinon un pas honnête', () => {
    expect(defaultSituationPercent(deriveSituationBasis(100_000, []))).toBe(25);
    expect(
      defaultSituationPercent(
        deriveSituationBasis(100_000, [sibling('deposit', 'paid', 30_000)]),
      ),
    ).toBe(20); // 30 % facturés → prochain quart 50 % = +20
    expect(
      defaultSituationPercent(
        deriveSituationBasis(100_000, [sibling('situation', 'issued', 97_000)]),
      ),
    ).toBe(3); // reste 3 % : proposition = max restant
  });
});

describe('situation-invoice.logic — proposition PAR POSTES (B2, consultative)', () => {
  const lines = [
    { id: 'l1', label: 'Plomberie', category: 'labor', qty: 1, unitPriceHT: 60_000, vatRate: 10 },
    { id: 'l2', label: 'Carrelage', category: 'labor', qty: 1, unitPriceHT: 40_000, vatRate: 10 },
  ] as const;

  it('postes = quote-parts EXACTES du marché (somme au centime, poids nets de remises de ligne)', () => {
    const postes = derivePostesFromQuote([...lines], 100_000);
    expect(postes).toEqual([
      { id: 'l1', label: 'Plomberie', amountHtCents: 60_000 },
      { id: 'l2', label: 'Carrelage', amountHtCents: 40_000 },
    ]);
  });

  it('remise DE LIGNE : le poste pèse sa base NETTE (mêmes règles computeLineBases que le serveur)', () => {
    const discounted = [
      { ...lines[0], discount: { type: 'percent', value: 50 } }, // 60 000 → 30 000
      lines[1],
    ] as Parameters<typeof derivePostesFromQuote>[0];
    const postes = derivePostesFromQuote(discounted, 70_000);
    expect(postes.map((poste) => poste.amountHtCents)).toEqual([30_000, 40_000]);
  });

  it('marché nul ou sans lignes : aucun poste (jamais une proposition inventée)', () => {
    expect(derivePostesFromQuote([...lines], 0)).toEqual([]);
    expect(derivePostesFromQuote([], 100_000)).toEqual([]);
  });

  it('scénario du finding : plomberie finie, pas le carrelage → 60 % proposés (jamais un quart arithmétique)', () => {
    const basis = deriveSituationBasis(100_000, []);
    const postes = derivePostesFromQuote([...lines], basis.marketHtCents);
    expect(situationPercentFromPostes(basis, postes, new Set(['l1']))).toBe(60);
    expect(situationPercentFromPostes(basis, postes, new Set(['l1', 'l2']))).toBe(100);
    expect(situationPercentFromPostes(basis, postes, new Set())).toBe(0);
  });

  it('déjà facturé : le % proposé est l’avancement cumulé MOINS le facturé, borné au reste', () => {
    // 30 % déjà facturés : plomberie finie (60 % cumulés) → situation proposée 30 %.
    const basis = deriveSituationBasis(100_000, [sibling('deposit', 'paid', 30_000)]);
    const postes = derivePostesFromQuote([...lines], basis.marketHtCents);
    expect(situationPercentFromPostes(basis, postes, new Set(['l1']))).toBe(30);
    // Sélection déjà couverte par le facturé → 0 (l'écran l'explique, jamais un 1 % forcé).
    const wellBilled = deriveSituationBasis(100_000, [sibling('situation', 'issued', 70_000)]);
    expect(situationPercentFromPostes(wellBilled, postes, new Set(['l1']))).toBe(0);
    // Tout coché avec 70 % facturés → borné au reste atteignable (maxPercent).
    expect(situationPercentFromPostes(wellBilled, postes, new Set(['l1', 'l2']))).toBe(
      wellBilled.maxPercent,
    );
  });

  it('marché couvert (canInvoice false) : toujours 0', () => {
    const basis = deriveSituationBasis(100_000, [sibling('situation', 'issued', 100_000)]);
    const postes = derivePostesFromQuote([...lines], 100_000);
    expect(situationPercentFromPostes(basis, postes, new Set(['l1', 'l2']))).toBe(0);
  });
});

describe('situation-invoice.logic — la FINALE ferme le marché (parité avec la garde serveur)', () => {
  it('finale vivante (brouillon ou émise) : canInvoice = false, même avec du reste', () => {
    expect(
      deriveSituationBasis(100_000, [sibling('final', 'draft', 100_000)]).canInvoice,
    ).toBe(false);
    expect(
      deriveSituationBasis(100_000, [sibling('final', 'issued', 100_000)]).canInvoice,
    ).toBe(false);
  });
  it('finale ANNULÉE : le marché se rouvre aux situations', () => {
    expect(
      deriveSituationBasis(100_000, [sibling('final', 'cancelled', 100_000)]).canInvoice,
    ).toBe(true);
  });
});
