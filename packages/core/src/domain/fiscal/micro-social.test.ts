import { describe, it, expect } from 'vitest';
import {
  MICRO_SOCIAL_RATES,
  computeMicroSocialProvision,
  microCategoryFromTrade,
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
});
