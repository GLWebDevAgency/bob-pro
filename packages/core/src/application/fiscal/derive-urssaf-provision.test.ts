import { describe, it, expect } from 'vitest';
import { formatEUR } from '../../format/money';
import { deriveUrssafProvision, type UrssafPaymentData } from './derive-urssaf-provision';

const pay = (receivedAt: string, amountCents: number): UrssafPaymentData => ({ receivedAt, amountCents });

describe('deriveUrssafProvision — déclaration URSSAF pré-calculée (P03, C-EXP5c)', () => {
  it('plombier micro trimestriel : 12 400 € encaissés au T3 → 2 628,80 € à déclarer le 31/10', () => {
    const p = deriveUrssafProvision({
      payments: [
        pay('2026-07-10', 500_000), // 5 000 € — dans le T3
        pay('2026-08-21T14:30:00.000Z', 640_000), // 6 400 € — ISO complet, seul le jour compte
        pay('2026-09-30', 100_000), // 1 000 € — borne incluse
        pay('2026-06-30', 999_999), // T2 — hors période
        pay('2026-10-01', 999_999), // T4 — hors période
      ],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
    });

    expect(p.periodLabel).toBe('T3 2026');
    expect(p.periodStart).toBe('2026-07-01');
    expect(p.periodEnd).toBe('2026-09-30');
    expect(p.declareBy).toBe('2026-10-31');
    expect(p.encaissedCents).toBe(1_240_000);
    expect(p.category).toBe('bic_prestations');
    expect(p.ratePct).toBe(21.2);
    expect(p.vflRatePct).toBeNull();
    expect(p.provisionCents).toBe(262_880); // 12 400 × 21,2 %
    expect(p.confidence).toBe('certain'); // périodicité connue + plombier = BIC certain
    expect(p.stale).toBe(false);
    // La déclaration pré-calculée, voix simple : période, CA, provision, date limite.
    expect(p.explain).toContain('Du 1er juillet au 30 septembre');
    expect(p.explain).toContain(formatEUR(1_240_000));
    expect(p.explain).toContain(formatEUR(262_880));
    expect(p.explain).toContain('au plus tard le 31 octobre 2026');
  });

  it('mensuel : mois civil de asOf, à déclarer le dernier jour du mois suivant', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-07-04', 200_000), pay('2026-06-28', 100_000)],
      asOf: '2026-07-04',
      periodicity: 'monthly',
      trade: 'electricien',
    });
    expect(p.periodLabel).toBe('juillet 2026');
    expect(p.periodStart).toBe('2026-07-01');
    expect(p.periodEnd).toBe('2026-07-31');
    expect(p.declareBy).toBe('2026-08-31');
    expect(p.encaissedCents).toBe(200_000);
    expect(p.provisionCents).toBe(42_400); // 2 000 × 21,2 %
  });

  it('T4 : la date limite passe l’année — 31 janvier N+1', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-11-10', 100_000)],
      asOf: '2026-11-12',
      periodicity: 'quarterly',
      trade: 'macon',
    });
    expect(p.periodLabel).toBe('T4 2026');
    expect(p.declareBy).toBe('2027-01-31');
  });

  it('décembre mensuel : déclaration au 31 janvier N+1', () => {
    const p = deriveUrssafProvision({
      payments: [],
      asOf: '2026-12-05',
      periodicity: 'monthly',
      trade: 'peintre',
    });
    expect(p.declareBy).toBe('2027-01-31');
  });

  it('option VFL : additive (21,2 % + 1,7 %), lignes social/VFL exposées', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-07-10', 1_240_000)],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
      vfl: true,
    });
    expect(p.vflRatePct).toBe(1.7);
    expect(p.totalRatePct).toBeCloseTo(22.9);
    expect(p.socialCents).toBe(262_880);
    expect(p.vflCents).toBe(21_080);
    expect(p.provisionCents).toBe(283_960);
    expect(p.explain).toContain('versement libératoire');
  });

  it('remboursements (montants négatifs) déduits ; s’ils dépassent, CA plancher 0', () => {
    const deducted = deriveUrssafProvision({
      payments: [pay('2026-07-10', 300_000), pay('2026-08-02', -100_000)],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
    });
    expect(deducted.encaissedCents).toBe(200_000);
    expect(deducted.provisionCents).toBe(42_400);

    const floored = deriveUrssafProvision({
      payments: [pay('2026-07-10', 50_000), pay('2026-08-02', -80_000)],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
    });
    expect(floored.encaissedCents).toBe(0);
    expect(floored.provisionCents).toBe(0);
  });

  it('périodicité inconnue → hypothèse trimestrielle, confidence assumed, explain invite à préciser', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-07-10', 100_000)],
      asOf: '2026-08-15',
      periodicity: null,
      trade: 'plombier',
    });
    expect(p.periodLabel).toBe('T3 2026');
    expect(p.confidence).toBe('assumed');
    expect(p.explain).toContain('confirme ta périodicité URSSAF');
  });

  it('catégorie dérivée du métier « consultant » → BNC 25,6 % assumed ; explicite → prime et certain', () => {
    const derived = deriveUrssafProvision({
      payments: [pay('2026-07-10', 1_000_000)],
      asOf: '2026-07-15',
      periodicity: 'quarterly',
      trade: 'consultant',
    });
    expect(derived.category).toBe('bnc');
    expect(derived.ratePct).toBe(25.6);
    expect(derived.confidence).toBe('assumed');
    expect(derived.explain).toContain('confirme-la pour affiner le taux');

    const explicit = deriveUrssafProvision({
      payments: [pay('2026-07-10', 1_000_000)],
      asOf: '2026-07-15',
      periodicity: 'quarterly',
      trade: 'consultant',
      category: 'liberale_reglementee_cipav',
    });
    expect(explicit.category).toBe('liberale_reglementee_cipav');
    expect(explicit.ratePct).toBe(23.2);
    expect(explicit.confidence).toBe('certain');
  });

  it('rien d’encaissé → provision 0 et rappel que la déclaration à zéro reste obligatoire', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-04-02', 500_000)], // T2 — hors T3
      asOf: '2026-07-04',
      periodicity: 'quarterly',
      trade: 'plombier',
    });
    expect(p.encaissedCents).toBe(0);
    expect(p.provisionCents).toBe(0);
    expect(p.explain).toContain('même à 0 €');
  });

  it('année hors référentiel → derniers taux connus + stale signalé dans l’explain', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2031-01-10', 100_000)],
      asOf: '2031-02-01',
      periodicity: 'quarterly',
      trade: 'plombier',
    });
    expect(p.stale).toBe(true);
    expect(p.ratePct).toBe(21.2); // dernière année connue (2026)
    expect(p.explain).toContain('derniers taux connus');
  });
});
