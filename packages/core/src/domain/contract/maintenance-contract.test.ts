import { describe, expect, it } from 'vitest';
import {
  CONTRACT_B2C_REFUSED_MESSAGE,
  CONTRACT_TRANSITIONS,
  MaintenanceContract,
  contractAnnualTotals,
  type MaintenanceContractProps,
} from './maintenance-contract';

function draftProps(overrides: Partial<MaintenanceContractProps> = {}): MaintenanceContractProps {
  return {
    id: 'contract-1',
    companyId: 'company-1',
    customerId: 'customer-ratp',
    chantierId: 'chantier-bastille',
    label: 'Entretien fontaines 2026',
    status: 'draft',
    anniversaryDate: '2025-10-12',
    noticeDays: 30,
    visitsPerYear: 2,
    tacitRenewal: true,
    importCoveredUntil: null,
    activatedAt: null,
    terminatedAt: null,
    terminationEffectiveDate: null,
    terminationNote: null,
    notes: null,
    revision: 1,
    lines: [
      {
        id: 'line-1',
        catalogueItemId: null,
        label: 'Forfait entretien annuel fontaine',
        quantity: 2,
        unitPriceHtCents: 80_000,
        vatRate: 20,
        position: 0,
      },
    ],
    equipmentIds: [],
    ...overrides,
  };
}

function draft(overrides: Partial<MaintenanceContractProps> = {}): MaintenanceContract {
  const recorded = MaintenanceContract.record(draftProps(overrides));
  if (!recorded.ok) throw new Error(`fixture invalide: ${JSON.stringify(recorded.error)}`);
  return recorded.value;
}

describe('MaintenanceContract — invariants du record()', () => {
  it('refuse un label vide, trop long ou pollué de caractères de contrôle', () => {
    expect(MaintenanceContract.record(draftProps({ label: '  ' })).ok).toBe(false);
    expect(MaintenanceContract.record(draftProps({ label: 'x'.repeat(201) })).ok).toBe(false);
    expect(MaintenanceContract.record(draftProps({ label: 'Contrat\u0007' })).ok).toBe(false);
  });

  it('refuse préavis/visites hors bornes et dates invalides', () => {
    expect(MaintenanceContract.record(draftProps({ noticeDays: -1 })).ok).toBe(false);
    expect(MaintenanceContract.record(draftProps({ noticeDays: 366 })).ok).toBe(false);
    expect(MaintenanceContract.record(draftProps({ visitsPerYear: 53 })).ok).toBe(false);
    expect(MaintenanceContract.record(draftProps({ anniversaryDate: '2026-02-30' })).ok).toBe(false);
    expect(MaintenanceContract.record(draftProps({ importCoveredUntil: '2026-13-01' })).ok).toBe(false);
  });

  it('refuse une ligne sans libellé, à quantité nulle ou à taux de TVA hors référentiel', () => {
    const badLabel = draftProps();
    badLabel.lines[0]!.label = ' ';
    expect(MaintenanceContract.record(badLabel).ok).toBe(false);
    const badQty = draftProps();
    badQty.lines[0]!.quantity = 0;
    expect(MaintenanceContract.record(badQty).ok).toBe(false);
    const badVat = draftProps();
    badVat.lines[0]!.vatRate = 19.6 as never;
    expect(MaintenanceContract.record(badVat).ok).toBe(false);
  });

  it('refuse une liaison équipements sans site (les équipements couverts vivent sur le site)', () => {
    expect(
      MaintenanceContract.record(draftProps({ chantierId: null, equipmentIds: ['equip-1'] })).ok,
    ).toBe(false);
    expect(
      MaintenanceContract.record(draftProps({ equipmentIds: ['equip-1', 'equip-1'] })).ok,
    ).toBe(false);
  });

  it('triple fait de résiliation : jamais un demi-état (statut ⟺ terminatedAt + date d’effet)', () => {
    expect(
      MaintenanceContract.record(
        draftProps({ status: 'terminated', activatedAt: '2025-10-12T08:00:00.000Z' }),
      ).ok,
    ).toBe(false);
    expect(
      MaintenanceContract.record(
        draftProps({ terminatedAt: '2026-06-01T08:00:00.000Z' }),
      ).ok,
    ).toBe(false);
    expect(
      MaintenanceContract.record(draftProps({ terminationNote: 'motif sans résiliation' })).ok,
    ).toBe(false);
    // Un actif/résilié porte TOUJOURS son fait d'activation.
    expect(MaintenanceContract.record(draftProps({ status: 'active' })).ok).toBe(false);
  });
});

describe('MaintenanceContract — Σ lignes au centime (jamais stocké)', () => {
  it('calcule le montant annuel par le moteur unique computeTotals', () => {
    const contract = draft();
    const totals = contract.annualTotals();
    expect(totals.ht).toBe(160_000);
    expect(totals.vat).toBe(32_000);
    expect(totals.ttc).toBe(192_000);
    expect(contractAnnualTotals(contract.toProps().lines).ttc).toBe(192_000);
  });
});

describe('MaintenanceContract — machine à états (§2.4)', () => {
  it('la table des transitions ne connaît QUE draft→active et active→terminated', () => {
    expect(CONTRACT_TRANSITIONS).toEqual({
      draft: ['active'],
      active: ['terminated'],
      terminated: [],
    });
  });

  it('active un brouillon b2b avec ≥ 1 ligne et pose le fait activatedAt', () => {
    const contract = draft();
    const activated = contract.activate('2026-07-28T08:00:00.000Z', 'b2b');
    expect(activated.ok).toBe(true);
    expect(contract.status).toBe('active');
    expect(contract.toProps().activatedAt).toBe('2026-07-28T08:00:00.000Z');
    expect(contract.revision).toBe(2);
  });

  it('[direction 5] refuse l’activation d’un client b2c avec le LegalHint Chatel', () => {
    const contract = draft();
    const refused = contract.activate('2026-07-28T08:00:00.000Z', 'b2c');
    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.error.code === 'VALIDATION') {
      expect(refused.error.message).toBe(CONTRACT_B2C_REFUSED_MESSAGE);
      expect(refused.error.message).toContain('L215-1');
    }
    expect(contract.status).toBe('draft');
  });

  it('refuse d’activer sans ligne (montant annuel = Σ lignes)', () => {
    const contract = draft({ lines: [] });
    expect(contract.activate('2026-07-28T08:00:00.000Z', 'b2g').ok).toBe(false);
  });

  it('terminate depuis draft refusé ; aucune transition depuis terminated', () => {
    const contract = draft();
    expect(
      contract.terminate({
        decidedAt: '2026-07-28T08:00:00.000Z',
        effectiveDate: '2026-10-12',
        note: 'client parti',
      }).ok,
    ).toBe(false);
    expect(contract.activate('2026-07-28T08:00:00.000Z', 'b2b').ok).toBe(true);
    expect(
      contract.terminate({
        decidedAt: '2026-07-29T08:00:00.000Z',
        effectiveDate: '2026-10-12',
        note: 'Résiliation reçue par courrier — marché perdu.',
      }).ok,
    ).toBe(true);
    expect(contract.status).toBe('terminated');
    expect(contract.terminationEffectiveDate).toBe('2026-10-12');
    // Terminal : ni réactivation, ni seconde résiliation, ni édition.
    expect(contract.activate('2026-07-30T08:00:00.000Z', 'b2b').ok).toBe(false);
    expect(
      contract.terminate({
        decidedAt: '2026-07-30T08:00:00.000Z',
        effectiveDate: '2026-11-12',
        note: 'doublon',
      }).ok,
    ).toBe(false);
    expect(contract.update({ label: 'Autre' }).ok).toBe(false);
    expect(contract.replaceLines([], () => 'x').ok).toBe(false);
    expect(contract.replaceEquipments([]).ok).toBe(false);
  });

  it('la résiliation exige un motif (trace de la décision), jamais une date invalide', () => {
    const contract = draft();
    contract.activate('2026-07-28T08:00:00.000Z', 'b2b');
    expect(
      contract.terminate({ decidedAt: '2026-07-29T08:00:00.000Z', effectiveDate: '2026-10-12', note: '  ' }).ok,
    ).toBe(false);
    expect(
      contract.terminate({ decidedAt: '2026-07-29T08:00:00.000Z', effectiveDate: 'demain', note: 'ok' }).ok,
    ).toBe(false);
  });
});

describe('MaintenanceContract — immuabilité post-activation (§2.1/§2.6)', () => {
  it('fige anniversaryDate, importCoveredUntil et le site après activation', () => {
    const contract = draft({ importCoveredUntil: '2026-10-12' });
    expect(contract.update({ anniversaryDate: '2025-11-01' }).ok).toBe(true); // draft : libre
    contract.activate('2026-07-28T08:00:00.000Z', 'b2b');
    expect(contract.update({ anniversaryDate: '2025-12-01' }).ok).toBe(false);
    expect(contract.update({ importCoveredUntil: '2027-01-01' }).ok).toBe(false);
    expect(contract.update({ importCoveredUntil: null }).ok).toBe(false);
    expect(contract.update({ chantierId: 'autre-site' }).ok).toBe(false);
    // Les autres conditions restent négociables sur un contrat VIVANT.
    expect(contract.update({ noticeDays: 60, tacitRenewal: false }).ok).toBe(true);
    expect(
      contract.replaceLines(
        [{ label: 'Forfait renégocié', quantity: 3, unitPriceHtCents: 80_000, vatRate: 20 }],
        () => 'line-new',
      ).ok,
    ).toBe(true);
    expect(contract.annualTotals().ht).toBe(240_000);
    expect(contract.replaceEquipments(['equip-1']).ok).toBe(true);
  });

  it('aucune méthode renew() : la reconduction n’existe pas comme mutation', () => {
    const contract = draft() as unknown as Record<string, unknown>;
    expect(contract['renew']).toBeUndefined();
  });
});
