import { describe, expect, it } from 'vitest';
import {
  FIXED_INDEMNITY_CENTS,
  LATE_PENALTY_RATES,
  computeLatePenalties,
  halfOf,
  resolvePenaltyRates,
} from './late-penalties';

// Fixture de référence : facture B2B 1 850 € TTC, échue le 16/05/2026, examinée le 30/06/2026
// → 45 jours de retard, semestre S1 2026 (BCE refi 2,15 %, taux légal pro 2,62 %).
const B2B_45J = {
  ttcCents: 185_000,
  dueAt: '2026-05-16',
  asOf: '2026-06-30',
  customerType: 'b2b',
} as const;

describe('halfOf / resolvePenaltyRates (référentiel semestriel versionné)', () => {
  it('janvier-juin → S1, juillet-décembre → S2', () => {
    expect(halfOf('2026-01-01')).toBe('2026-S1');
    expect(halfOf('2026-06-30')).toBe('2026-S1');
    expect(halfOf('2026-07-01')).toBe('2026-S2');
    expect(halfOf('2026-12-31')).toBe('2026-S2');
  });

  it('semestre au référentiel → taux exacts, stale false', () => {
    const r = resolvePenaltyRates('2026-S1');
    expect(r.stale).toBe(false);
    expect(r.rates).toEqual({ half: '2026-S1', bceRefiPct: 2.15, legalRatePct: 2.62 });
  });

  it('semestre FUTUR hors référentiel → dernier connu + stale true (jamais de taux inventé)', () => {
    const r = resolvePenaltyRates('2027-S1');
    expect(r.stale).toBe(true);
    expect(r.rates.half).toBe('2026-S1');
  });

  it('semestre ANTÉRIEUR au référentiel → plus ancien connu + stale true', () => {
    const r = resolvePenaltyRates('2025-S2');
    expect(r.stale).toBe(true);
    expect(r.rates.half).toBe('2026-S1');
  });

  it('le référentiel S1 2026 porte les valeurs vérifiées (BCE 2,15 % ; taux légal pro 2,62 %)', () => {
    expect(LATE_PENALTY_RATES).toContainEqual({ half: '2026-S1', bceRefiPct: 2.15, legalRatePct: 2.62 });
  });
});

describe('computeLatePenalties — b2b (L441-10 II + D441-5)', () => {
  it('défaut BCE+10 : 1 850 € TTC, 45 j → 12,15 %, 27,71 € d’intérêts + 40 €, 0,62 €/jour', () => {
    const p = computeLatePenalties(B2B_45J);
    expect(p).toEqual({
      interestCents: 2771, // 185 000 × 12,15 % × 45/365, arrondi au centime
      fixedIndemnityCents: FIXED_INDEMNITY_CENTS,
      dailyCents: 62,
      days: 45,
      rateAnnualPct: 12.15,
      rateBasis: 'bce_plus_10',
      stale: false,
      flooredToLegalMinimum: false,
    });
  });

  it('de plein droit dès le LENDEMAIN de l’échéance : jour J = rien ; J+1 = 1 jour + 40 €', () => {
    const atDue = computeLatePenalties({ ...B2B_45J, asOf: '2026-05-16' });
    expect(atDue.days).toBe(0);
    expect(atDue.interestCents).toBe(0);
    expect(atDue.fixedIndemnityCents).toBe(0);
    expect(atDue.dailyCents).toBe(0);

    const dayAfter = computeLatePenalties({ ...B2B_45J, asOf: '2026-05-17' });
    expect(dayAfter.days).toBe(1);
    expect(dayAfter.interestCents).toBe(62); // 61,58 centimes → arrondi au centime le plus proche
    expect(dayAfter.fixedIndemnityCents).toBe(4000);
  });

  it('taux stipulé valide (15 % ≥ plancher 7,86 %) → appliqué tel quel, basis stipule', () => {
    const p = computeLatePenalties({ ...B2B_45J, stipulatedAnnualRatePct: 15 });
    expect(p.rateAnnualPct).toBe(15);
    expect(p.rateBasis).toBe('stipule');
    expect(p.flooredToLegalMinimum).toBe(false);
    expect(p.interestCents).toBe(3421); // 185 000 × 15 % × 45/365
  });

  it('taux stipulé trop bas (5 % < 3× 2,62 %) → PLANCHER 7,86 % appliqué et signalé', () => {
    const p = computeLatePenalties({ ...B2B_45J, stipulatedAnnualRatePct: 5 });
    expect(p.rateAnnualPct).toBe(7.86);
    expect(p.rateBasis).toBe('plancher_3x_legal');
    expect(p.flooredToLegalMinimum).toBe(true);
    expect(p.interestCents).toBe(1793); // 185 000 × 7,86 % × 45/365
  });

  it('semestre hors référentiel (S2 2026) → taux du dernier connu + stale true', () => {
    const p = computeLatePenalties({ ...B2B_45J, dueAt: '2026-08-01', asOf: '2026-09-15' });
    expect(p.stale).toBe(true);
    expect(p.rateAnnualPct).toBe(12.15); // dernier semestre CONNU (S1 2026), jamais inventé
    expect(p.days).toBe(45);
  });

  it('base négative clampée à 0 — jamais d’intérêts négatifs', () => {
    const p = computeLatePenalties({ ...B2B_45J, ttcCents: -5000 });
    expect(p.interestCents).toBe(0);
    expect(p.dailyCents).toBe(0);
  });
});

describe('computeLatePenalties — b2g (L2192-12/13 CCP, décret 2013-269)', () => {
  it('BCE+8 : 1 850 € TTC, 45 j → 10,15 %, 23,15 € d’intérêts moratoires + 40 €', () => {
    const p = computeLatePenalties({ ...B2B_45J, customerType: 'b2g' });
    expect(p.rateAnnualPct).toBe(10.15);
    expect(p.rateBasis).toBe('bce_plus_8');
    expect(p.interestCents).toBe(2315);
    expect(p.fixedIndemnityCents).toBe(4000);
  });

  it('le taux b2g est réglementaire : un taux stipulé est IGNORÉ', () => {
    const p = computeLatePenalties({ ...B2B_45J, customerType: 'b2g', stipulatedAnnualRatePct: 2 });
    expect(p.rateAnnualPct).toBe(10.15);
    expect(p.rateBasis).toBe('bce_plus_8');
    expect(p.flooredToLegalMinimum).toBe(false);
  });
});

describe('computeLatePenalties — b2c (art. 1344-1 et 1231-6 C. civ)', () => {
  it('AUCUNE mise en demeure → 0 partout (rien ne court de plein droit), JAMAIS 40 €', () => {
    const p = computeLatePenalties({ ...B2B_45J, customerType: 'b2c' });
    expect(p.interestCents).toBe(0);
    expect(p.fixedIndemnityCents).toBe(0);
    expect(p.dailyCents).toBe(0);
    expect(p.days).toBe(0);
    expect(p.rateAnnualPct).toBe(2.62); // le taux qui courrait APRÈS une MED (créancier pro)
    expect(p.rateBasis).toBe('taux_legal');
  });

  it('MED envoyée → intérêts au taux légal à compter de la MED (30 j → 3,98 €), toujours 0 € d’indemnité', () => {
    const p = computeLatePenalties({ ...B2B_45J, customerType: 'b2c', fromMiseEnDemeureAt: '2026-05-31' });
    expect(p.days).toBe(30);
    expect(p.interestCents).toBe(398); // 185 000 × 2,62 % × 30/365
    expect(p.fixedIndemnityCents).toBe(0);
    expect(p.dailyCents).toBe(13);
  });

  it('MED du jour même : les intérêts commencent à courir (daily > 0) mais 0 jour décompté', () => {
    const p = computeLatePenalties({ ...B2B_45J, customerType: 'b2c', fromMiseEnDemeureAt: '2026-06-30' });
    expect(p.days).toBe(0);
    expect(p.interestCents).toBe(0);
    expect(p.dailyCents).toBe(13);
  });

  it('MED datée dans le futur → rien ne court', () => {
    const p = computeLatePenalties({ ...B2B_45J, customerType: 'b2c', fromMiseEnDemeureAt: '2026-08-01' });
    expect(p.days).toBe(0);
    expect(p.dailyCents).toBe(0);
  });
});
