import { describe, it, expect } from 'vitest';
import { TODAY_FIXTURE, CASH_SNAPSHOT, seedCustomers } from './index';

describe('fixtures-proto (alignement Bob Pro.dc.html v2)', () => {
  it("expose exactement les 3 priorités du briefing « Aujourd'hui »", () => {
    expect(TODAY_FIXTURE.priorities).toHaveLength(3);
    const [relance, facture, conformite] = TODAY_FIXTURE.priorities;
    expect(relance.kind).toBe('relance');
    expect(relance.docNumber).toBe('F-2026-088');
    expect(relance.amountCents).toBe(124000); // 1 240 € — facture Martin en retard de 9 j
    expect(facture.kind).toBe('facture_finale');
    expect(conformite.kind).toBe('conformite');
    expect(conformite.badge).toBe('Facturation élec. 2026'); // priorité 3 du proto (capture vérifiée)
  });

  it('cash.dispo héros = 4 950 € et suit la projection CASH du proto', () => {
    expect(TODAY_FIXTURE.dispoCents).toBe(495000);
    expect(TODAY_FIXTURE.cashByHorizon[30].cents).toBe(TODAY_FIXTURE.dispoCents);
    expect(TODAY_FIXTURE.cashByHorizon[7].cents).toBe(540000);
    expect(TODAY_FIXTURE.cashByHorizon[60].cents).toBe(310000);
    expect(TODAY_FIXTURE.cashByHorizon[90].cents).toBe(720000);
  });

  it('le solde ment : la banque affiche plus que le dispo réel', () => {
    expect(CASH_SNAPSHOT.bankBalance).toBeGreaterThan(TODAY_FIXTURE.dispoCents);
  });

  it('les 6 clients de seed restent valides', () => {
    expect(seedCustomers()).toHaveLength(6);
  });
});
