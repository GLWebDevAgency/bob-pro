import { describe, it, expect } from 'vitest';
import {
  MICRO_ACRE_REDUCTION_STEPS,
  MICRO_SOCIAL_RATES,
  acreWindow,
  computeMicroSocialProvision,
  microCategoryFromTrade,
  resolveAcreSocialPct,
  resolveMicroSocialRates,
  type MicroActivityCategory,
} from './micro-social';

describe('MICRO_SOCIAL_RATES — taux 2026 sourcés (D613-4 CSS, décret 2025-943)', () => {
  const y2026 = MICRO_SOCIAL_RATES.find((r) => r.year === 2026);

  it('porte les quatre taux 2026 exacts par catégorie', () => {
    expect(y2026?.socialPct).toEqual({
      ventes: 12.3,
      bic_prestations: 21.2,
      bnc: 25.6, // décret 2025-943 : ABAISSÉ vs les 26,1 % programmés par le décret 2024-484
      liberale_reglementee_cipav: 23.2,
    });
  });

  it('porte les taux du versement libératoire (art. 151-0 CGI) — additifs', () => {
    expect(y2026?.vflPct).toEqual({
      ventes: 1,
      bic_prestations: 1.7,
      bnc: 2.2,
      liberale_reglementee_cipav: 2.2,
    });
  });

  it('2025 : BNC à 24,6 % (marche du décret 2024-484), le reste inchangé', () => {
    const y2025 = MICRO_SOCIAL_RATES.find((r) => r.year === 2025);
    expect(y2025?.socialPct.bnc).toBe(24.6);
    expect(y2025?.socialPct.ventes).toBe(12.3);
    expect(y2025?.socialPct.bic_prestations).toBe(21.2);
    expect(y2025?.socialPct.liberale_reglementee_cipav).toBe(23.2);
  });
});

describe('resolveMicroSocialRates — année hors table → dernière connue + stale', () => {
  it('année au référentiel → taux exacts, stale false', () => {
    const { rates, stale } = resolveMicroSocialRates(2026);
    expect(rates.year).toBe(2026);
    expect(stale).toBe(false);
  });

  it('année future inconnue → derniers taux connus, stale true', () => {
    const { rates, stale } = resolveMicroSocialRates(2031);
    expect(rates.year).toBe(2026);
    expect(stale).toBe(true);
  });

  it('année antérieure à la table → taux les plus anciens connus, stale true', () => {
    const { rates, stale } = resolveMicroSocialRates(2023);
    expect(rates.year).toBe(2025);
    expect(stale).toBe(true);
  });
});

describe('microCategoryFromTrade — dérivation prudente, jamais silencieuse', () => {
  it('artisans du bâtiment → prestations BIC 21,2 %, certain', () => {
    for (const trade of ['plombier', 'electricien', 'macon', 'peintre', 'paysagiste'] as const) {
      expect(microCategoryFromTrade(trade)).toEqual({ category: 'bic_prestations', confidence: 'certain' });
    }
  });

  it('métiers intellectuels et repli « autre » → BNC 25,6 % (taux le plus prudent), assumed', () => {
    for (const trade of ['consultant', 'photographe', 'coach', 'autre'] as const) {
      expect(microCategoryFromTrade(trade)).toEqual({ category: 'bnc', confidence: 'assumed' });
    }
  });
});

describe('computeMicroSocialProvision', () => {
  it('plombier BIC prestations : 12 400 € encaissés → 2 628,80 € de cotisations (21,2 %)', () => {
    const p = computeMicroSocialProvision({
      encaissedCents: 1_240_000,
      category: 'bic_prestations',
      vfl: false,
      year: 2026,
    });
    expect(p.socialRatePct).toBe(21.2);
    expect(p.vflRatePct).toBeNull();
    expect(p.totalRatePct).toBe(21.2);
    expect(p.socialCents).toBe(262_880);
    expect(p.vflCents).toBe(0);
    expect(p.provisionCents).toBe(262_880);
    expect(p.stale).toBe(false);
  });

  it('option VFL : + 1,7 % BIC prestations, les deux lignes arrondies séparément', () => {
    const p = computeMicroSocialProvision({
      encaissedCents: 1_240_000,
      category: 'bic_prestations',
      vfl: true,
      year: 2026,
    });
    expect(p.vflRatePct).toBe(1.7);
    expect(p.totalRatePct).toBeCloseTo(22.9);
    expect(p.vflCents).toBe(21_080); // 12 400 € × 1,7 %
    expect(p.provisionCents).toBe(262_880 + 21_080);
  });

  it.each([
    ['ventes', 123_000, 10_000], // 12,3 % · VFL 1 %
    ['bnc', 256_000, 22_000], // 25,6 % · VFL 2,2 %
    ['liberale_reglementee_cipav', 232_000, 22_000], // 23,2 % · VFL 2,2 %
  ] as Array<[MicroActivityCategory, number, number]>)(
    '10 000 € encaissés en %s → social %i, VFL %i (centimes)',
    (category, socialCents, vflCents) => {
      const p = computeMicroSocialProvision({ encaissedCents: 1_000_000, category, vfl: true, year: 2026 });
      expect(p.socialCents).toBe(socialCents);
      expect(p.vflCents).toBe(vflCents);
      expect(p.provisionCents).toBe(socialCents + vflCents);
    },
  );

  it('arrondit au centime le plus proche sur le produit final (pas de cumul de journaliers)', () => {
    // 10,01 € × 12,3 % = 1,23123 € → 123 centimes.
    const p = computeMicroSocialProvision({ encaissedCents: 1001, category: 'ventes', vfl: false, year: 2026 });
    expect(p.socialCents).toBe(123);
  });

  it('CA négatif (remboursements > encaissements) → plancher 0, jamais une provision négative', () => {
    const p = computeMicroSocialProvision({ encaissedCents: -50_000, category: 'bnc', vfl: true, year: 2026 });
    expect(p.provisionCents).toBe(0);
    expect(p.socialCents).toBe(0);
    expect(p.vflCents).toBe(0);
  });

  it('année inconnue → derniers taux connus, stale signalé', () => {
    const p = computeMicroSocialProvision({ encaissedCents: 100_000, category: 'bnc', vfl: false, year: 2030 });
    expect(p.stale).toBe(true);
    expect(p.socialRatePct).toBe(25.6); // taux 2026, dernière année connue
  });

  it('acreRatePct : REMPLACE le taux social plein, VFL inchangé au taux plein (cumul)', () => {
    // plombier BIC, 12 400 € encaissés, ACRE 10,6 % (moitié du plein 21,2 %) + VFL plein 1,7 %.
    const p = computeMicroSocialProvision({
      encaissedCents: 1_240_000,
      category: 'bic_prestations',
      vfl: true,
      year: 2026,
      acreRatePct: 10.6,
    });
    expect(p.socialRatePct).toBe(10.6); // taux réduit ACRE, PAS 21,2 %
    expect(p.socialCents).toBe(131_440); // 12 400 € × 10,6 %
    expect(p.vflRatePct).toBe(1.7); // VFL au taux plein, cumulable avec l'ACRE
    expect(p.vflCents).toBe(21_080); // 12 400 € × 1,7 %
    expect(p.provisionCents).toBe(152_520);
  });

  it('acreRatePct null/absent → taux plein (aucune régression sur le chemin sans ACRE)', () => {
    const withNull = computeMicroSocialProvision({
      encaissedCents: 1_240_000,
      category: 'bic_prestations',
      vfl: false,
      year: 2026,
      acreRatePct: null,
    });
    expect(withNull.socialRatePct).toBe(21.2);
    expect(withNull.socialCents).toBe(262_880);
  });
});

describe('MICRO_ACRE_REDUCTION_STEPS — facteur de réduction par date de début d’activité (art. D.131-6-3 CSS)', () => {
  it('marche AVANT le 1/7/2026 : 50 % du taux plein restant dû', () => {
    const before = MICRO_ACRE_REDUCTION_STEPS.find((s) => s.effectiveFrom === '1970-01-01');
    expect(before?.factor).toBe(0.5);
  });

  it('marche du 1/7/2026 (décret 2026-69) : 75 % du taux plein pour le micro', () => {
    const from0107 = MICRO_ACRE_REDUCTION_STEPS.find((s) => s.effectiveFrom === '2026-07-01');
    expect(from0107?.factor).toBe(0.75);
  });
});

describe('resolveAcreSocialPct — taux ACRE = plein de l’ANNÉE DÉCLARÉE × facteur (date de création)', () => {
  it('marche du 1/7/2026 lue sur la DATE DE CRÉATION (déclaration 2026)', () => {
    expect(resolveAcreSocialPct(2026, 'bic_prestations', '2026-03-15')).toBe(10.6); // 21,2 × 0,5
    expect(resolveAcreSocialPct(2026, 'bic_prestations', '2026-06-30')).toBe(10.6); // veille de la marche
    expect(resolveAcreSocialPct(2026, 'bic_prestations', '2026-07-01')).toBe(15.9); // 21,2 × 0,75, jour de la marche
    expect(resolveAcreSocialPct(2026, 'bnc', '2026-09-03')).toBe(19.2); // 25,6 × 0,75
  });

  it('arrondi au 0,1 % reproduit le barème publié (12,3 × 0,5 = 6,15 → 6,2 ; × 0,75 = 9,2)', () => {
    expect(resolveAcreSocialPct(2026, 'ventes', '2026-01-01')).toBe(6.2);
    expect(resolveAcreSocialPct(2026, 'ventes', '2026-07-01')).toBe(9.2);
    expect(resolveAcreSocialPct(2026, 'liberale_reglementee_cipav', '2026-07-01')).toBe(17.4);
  });

  // NON-RÉGRESSION (audit adversarial 2026-07-05, bug majeur) : le taux ACRE suit le taux PLEIN de
  // l'année déclarée. Le BNC plein vaut 24,6 % en 2025 (vs 25,6 % en 2026) → ACRE BNC 2025 = 12,3 %,
  // PAS 12,8 %. L'ancien modèle figeait 12,8 (calé 2026) et sur-provisionnait toute déclaration 2025.
  it('BNC : ACRE suit l’année déclarée — 12,3 % en 2025 (plein 24,6), 12,8 % en 2026 (plein 25,6)', () => {
    expect(resolveAcreSocialPct(2025, 'bnc', '2025-06-01')).toBe(12.3);
    expect(resolveAcreSocialPct(2026, 'bnc', '2025-06-01')).toBe(12.8);
    // Ventes/BIC/Cipav : plein identique 2025/2026 → ACRE stable.
    expect(resolveAcreSocialPct(2025, 'bic_prestations', '2025-06-01')).toBe(10.6);
    expect(resolveAcreSocialPct(2026, 'bic_prestations', '2025-06-01')).toBe(10.6);
  });
});

describe('acreWindow — début d’activité + 3 trimestres civils suivants (art. D.131-6-3 CSS)', () => {
  it('exemple officiel URSSAF : début le 3/9/2026 (T3) → fin le 30/6/2027 (fin T2 2027)', () => {
    expect(acreWindow('2026-09-03')).toEqual({ start: '2026-09-03', end: '2027-06-30' });
  });

  it('début en cours de T1 (15/3/2026) → fin le 31/12/2026 (fin T4 2026)', () => {
    expect(acreWindow('2026-03-15')).toEqual({ start: '2026-03-15', end: '2026-12-31' });
  });

  it('début au 1er jour d’un trimestre (1/1/2026, T1) → fin le 31/12/2026 (fin T4)', () => {
    expect(acreWindow('2026-01-01')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('début au 1er jour de T2 (1/4/2026) → fin le 31/3/2027 (fin T1 2027)', () => {
    expect(acreWindow('2026-04-01')).toEqual({ start: '2026-04-01', end: '2027-03-31' });
  });

  it('début en fin de T4 (31/12/2026) → fin le 30/9/2027 (fin T3 2027), passage d’année', () => {
    expect(acreWindow('2026-12-31')).toEqual({ start: '2026-12-31', end: '2027-09-30' });
  });

  it('la borne start est TOUJOURS la date de début exacte (point de départ légal)', () => {
    expect(acreWindow('2025-11-20').start).toBe('2025-11-20');
  });
});
