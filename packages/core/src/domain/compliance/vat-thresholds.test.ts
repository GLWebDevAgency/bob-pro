import { describe, expect, it } from 'vitest';
import { assessVatFranchise } from './vat-thresholds';

describe('assessVatFranchise (art. 293 B CGI — seuils 2025-2026)', () => {
  it('services : sous 80 % du seuil de base → ok, marge restante exacte', () => {
    const s = assessVatFranchise({ activity: 'services', annualRevenueCents: 2_000_000 }); // 20 000 €
    expect(s.standing).toBe('ok');
    expect(s.ratioPct).toBe(53);
    expect(s.remainingToBaseCents).toBe(1_750_000);
  });

  it('services : 80 % du seuil (30 000 €) → approche — l’artisan doit anticiper', () => {
    const s = assessVatFranchise({ activity: 'services', annualRevenueCents: 3_000_000 });
    expect(s.standing).toBe('approaching');
    expect(s.ratioPct).toBe(80);
  });

  it('entre base et majoré (39 000 €) → TVA au 1er janvier suivant', () => {
    const s = assessVatFranchise({ activity: 'services', annualRevenueCents: 3_900_000 });
    expect(s.standing).toBe('over_base');
    expect(s.remainingToBaseCents).toBe(0);
  });

  it('au-delà du majoré (42 000 €) → TVA IMMÉDIATE (le risque fiscal maximal)', () => {
    const s = assessVatFranchise({ activity: 'services', annualRevenueCents: 4_200_000 });
    expect(s.standing).toBe('over_majored');
    expect(s.ratioPct).toBe(112);
  });

  it('ventes : seuils distincts (85 000 / 93 500) — 90 000 € = over_base seulement', () => {
    const s = assessVatFranchise({ activity: 'ventes', annualRevenueCents: 9_000_000 });
    expect(s.standing).toBe('over_base');
    expect(s.thresholds.majoredCents).toBe(9_350_000);
  });

  it('exactement AU seuil de base : la franchise tient encore (dépassement = strictement supérieur)', () => {
    const s = assessVatFranchise({ activity: 'services', annualRevenueCents: 3_750_000 });
    expect(s.standing).toBe('approaching'); // 100 % du seuil, pas encore dépassé
  });
});
