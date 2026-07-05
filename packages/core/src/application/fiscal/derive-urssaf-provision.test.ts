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

  it('sans ACRE (acre absent, pas de dateCreation) : sortie ACRE neutre, aucune régression', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-07-10', 1_240_000)],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
    });
    expect(p.ratePct).toBe(21.2); // taux plein
    expect(p.provisionCents).toBe(262_880);
    expect(p.acreApplied).toBe(false);
    expect(p.acreWindowEnd).toBeNull();
    expect(p.askAcre).toBe(false);
    expect(p.explain).not.toContain('ACRE');
  });
});

describe('deriveUrssafProvision — ACRE (C-EXP5d)', () => {
  it('plombier micro créé le 15/3/2026, ACRE : T3 12 400 € → taux réduit 10,6 %, 1 314,40 € à mettre de côté', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-07-10', 500_000), pay('2026-08-21', 640_000), pay('2026-09-30', 100_000)],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
      dateCreation: '2026-03-15',
      acre: true,
    });
    expect(p.encaissedCents).toBe(1_240_000);
    expect(p.ratePct).toBe(10.6); // taux ACRE (moitié du plein 21,2 %), création avant le 1/7/2026
    expect(p.provisionCents).toBe(131_440); // 12 400 € × 10,6 % (vs 262 880 € au plein)
    expect(p.socialCents).toBe(131_440);
    expect(p.acreApplied).toBe(true);
    expect(p.acreWindowEnd).toBe('2026-12-31'); // T1 2026 + 3 trimestres = fin T4 2026
    expect(p.askAcre).toBe(false); // éligibilité déjà connue
    expect(p.explain).toContain("taux réduit ACRE jusqu'au 31 décembre 2026");
    expect(p.explain).toContain(formatEUR(131_440));
  });

  it('marche du 1/7/2026 : création le 15/7/2026 → barème réduit 75 % (BIC 15,9 %), pas 10,6 %', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-08-10', 1_000_000)],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
      dateCreation: '2026-07-15',
      acre: true,
    });
    expect(p.ratePct).toBe(15.9); // décret 2026-69 : 75 % du plein pour les créations micro ≥ 1/7/2026
    expect(p.provisionCents).toBe(159_000); // 10 000 € × 15,9 %
    expect(p.acreApplied).toBe(true);
    expect(p.acreWindowEnd).toBe('2027-06-30'); // T3 2026 + 3 trimestres = fin T2 2027
  });

  it('ACRE + VFL cumulables : social au taux ACRE, VFL au taux plein', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-07-10', 1_240_000)],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
      dateCreation: '2026-03-15',
      acre: true,
      vfl: true,
    });
    expect(p.socialCents).toBe(131_440); // 12 400 € × 10,6 % (ACRE)
    expect(p.vflCents).toBe(21_080); // 12 400 € × 1,7 % (VFL plein, non minoré)
    expect(p.provisionCents).toBe(152_520);
    expect(p.vflRatePct).toBe(1.7);
    expect(p.explain).toContain('taux réduit ACRE');
  });

  it('acre=true mais période APRÈS la fenêtre → taux plein + explain « ACRE terminée »', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-07-10', 1_000_000)],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
      dateCreation: '2025-01-10', // fenêtre = T1 2025 + 3 trim. → fin le 31/12/2025
      acre: true,
    });
    expect(p.acreApplied).toBe(false);
    expect(p.ratePct).toBe(21.2); // taux plein revenu
    expect(p.provisionCents).toBe(212_000);
    expect(p.acreWindowEnd).toBe('2025-12-31');
    expect(p.askAcre).toBe(false); // éligibilité connue (true), rien à demander
    expect(p.explain).toContain('ACRE est terminée');
  });

  // NON-RÉGRESSION (audit adversarial 2026-07-05, bug majeur) : le taux ACRE suit le taux PLEIN de
  // l'ANNÉE DÉCLARÉE. Un consultant BNC déclarant en 2025 doit l'ACRE 12,3 % (24,6 × 0,5), PAS
  // 12,8 % (le plein BNC était 24,6 en 2025, monté à 25,6 en 2026). L'ancien taux figé 12,8
  // sur-provisionnait de 50 € sur 10 000 € encaissés.
  it('BNC déclarant en 2025 : ACRE 12,3 % (plein 2025 = 24,6), pas 12,8 % (calé 2026)', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2025-08-10', 1_000_000)],
      asOf: '2025-08-15',
      periodicity: 'quarterly',
      trade: 'consultant', // → BNC
      dateCreation: '2025-06-01', // fenêtre T2 2025 + 3 trim. → 31/3/2026 : T3 2025 dedans
      acre: true,
    });
    expect(p.acreApplied).toBe(true);
    expect(p.ratePct).toBe(12.3); // 24,6 % (plein BNC 2025) × 0,5 — surtout PAS 12,8
    expect(p.provisionCents).toBe(123_000); // 10 000 € × 12,3 % (vs 128 000 € avec le bug)
  });

  it('classement par date d’encaissement : un paiement hors fenêtre est raté au taux plein', () => {
    // Création le 20/5/2026 (avant la marche du 1/7 → ACRE 10,6 %) : dans la MÊME période T2, un
    // encaissement daté avant l’ouverture de la fenêtre est au plein, celui après à l’ACRE
    // (art. D.131-6-3 CSS — le taux suit la date d’encaissement).
    const p = deriveUrssafProvision({
      payments: [pay('2026-04-15', 100_000), pay('2026-06-01', 200_000)],
      asOf: '2026-06-15',
      periodicity: 'quarterly',
      trade: 'plombier',
      dateCreation: '2026-05-20',
      acre: true,
    });
    expect(p.encaissedCents).toBe(300_000);
    // 200 000 × 10,6 % (ACRE) + 100 000 × 21,2 % (plein) = 21 200 + 21 200
    expect(p.socialCents).toBe(42_400);
    expect(p.provisionCents).toBe(42_400);
    expect(p.acreApplied).toBe(true);
    expect(p.acreWindowEnd).toBe('2027-03-31'); // T2 2026 + 3 trimestres = fin T1 2027
  });

  it('acre null + création < 12 mois avant asOf → askAcre true, taux plein en attendant', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-07-10', 1_000_000)],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
      dateCreation: '2026-03-15',
      acre: null,
    });
    expect(p.askAcre).toBe(true);
    expect(p.acreApplied).toBe(false);
    expect(p.ratePct).toBe(21.2); // taux plein tant que l’éligibilité n’est pas confirmée
    expect(p.explain).not.toContain('ACRE'); // jamais deviné dans le texte
  });

  it('acre absent + création > 12 mois avant asOf → askAcre false (trop tard pour la question)', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-07-10', 1_000_000)],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
      dateCreation: '2024-01-01',
    });
    expect(p.askAcre).toBe(false);
    expect(p.acreApplied).toBe(false);
  });

  it('acre=false explicite → askAcre false même si création récente', () => {
    const p = deriveUrssafProvision({
      payments: [pay('2026-07-10', 1_000_000)],
      asOf: '2026-08-15',
      periodicity: 'quarterly',
      trade: 'plombier',
      dateCreation: '2026-03-15',
      acre: false,
    });
    expect(p.askAcre).toBe(false);
    expect(p.acreApplied).toBe(false);
    expect(p.ratePct).toBe(21.2);
  });
});
