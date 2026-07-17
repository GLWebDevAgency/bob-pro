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

  it('les identités clients du mode démo ne portent aucune métrique financière synthétique', () => {
    const byId = new Map(seedCustomers().map((c) => [c.id, c]));

    // Mme Durand — particulier à jour (facture F-2026-104 de 1 180 € payée).
    const durand = byId.get('cust-durand')!;
    expect(durand.name).toBe('Mme Durand');
    expect(durand.type).toBe('b2c');
    expect(durand.siren).toBeUndefined(); // siren: null dans le proto
    expect(durand.toProps()).not.toHaveProperty('outstanding');

    // SARL Martin Rénovation — b2b en retard : encours 2 480 € dont F-2026-088 (1 240 €, 9 j).
    const martin = byId.get('cust-martin')!;
    expect(martin.name).toBe('SARL Martin Rénovation');
    expect(martin.type).toBe('b2b');
    expect(martin.siren).toBe('821503642');
    expect(martin.toProps()).not.toHaveProperty('score');
    expect(martin.toProps()).not.toHaveProperty('avgDelayDays');

    // Camping Les Pins — b2b nouveau, 0 € (facturation élec. à configurer).
    const camping = byId.get('cust-camping')!;
    expect(camping.name).toBe('Camping Les Pins');
    expect(camping.type).toBe('b2b');
    expect(camping.siren).toBe('789220117');
    expect(camping.toProps()).not.toHaveProperty('outstanding');

    // Les 3 canaux e-invoicing du proto restent représentés (b2c/b2b/b2g).
    expect(byId.get('cust-sevres')!.type).toBe('b2g');
    expect(byId.get('cust-lefevre')!.type).toBe('b2b');
    expect(byId.get('cust-bernard')!.type).toBe('b2c');
  });

  it('la priorité relance = la facture F-2026-088 de Martin (1 240 €, 9 j de retard)', () => {
    const relance = TODAY_FIXTURE.priorities[0];
    expect(relance.title).toBe('Relancer SARL Martin Rénovation');
    expect(relance.docNumber).toBe('F-2026-088');
    expect(relance.amountCents).toBe(124000);
    expect(relance.daysLate).toBe(9);
  });
});
