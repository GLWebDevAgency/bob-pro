import { describe, expect, it } from 'vitest';
import {
  decodeDiscount,
  decodeTransmission,
  decodeTransmissionGuide,
  normalizeBillingTerrainCarrier,
} from './billing-terrain-codec';

/**
 * Codecs « facturation terrain » — compat ascendante STRICTE : champ absent normalisé,
 * champ présent difforme = échec FERMÉ (jamais un fait légal casté en aveugle), sauf le
 * guide DÉRIVÉ (aide retirée, jamais la pièce perdue).
 */

describe('decodeDiscount', () => {
  it('percent et amount valides', () => {
    expect(decodeDiscount({ type: 'percent', value: 12.5 })).toEqual({ type: 'percent', value: 12.5 });
    expect(decodeDiscount({ type: 'amount', cents: 500 })).toEqual({ type: 'amount', cents: 500 });
  });
  it('difformes : null (type inconnu, valeur non finie, cents non entiers)', () => {
    expect(decodeDiscount({ type: 'rebate', value: 10 })).toBeNull();
    expect(decodeDiscount({ type: 'percent', value: Number.NaN })).toBeNull();
    expect(decodeDiscount({ type: 'amount', cents: 5.5 })).toBeNull();
    expect(decodeDiscount('10%')).toBeNull();
  });
});

describe('decodeTransmission', () => {
  it('dépôt seul, puis dépôt + acceptation', () => {
    expect(decodeTransmission({ depositedAt: '2026-07-20', acceptedAt: null })).toEqual({
      depositedAt: '2026-07-20',
      acceptedAt: null,
    });
    expect(decodeTransmission({ depositedAt: '2026-07-20', acceptedAt: '2026-07-25' })).toEqual({
      depositedAt: '2026-07-20',
      acceptedAt: '2026-07-25',
    });
  });
  it('date difforme : null (fail-closed)', () => {
    expect(decodeTransmission({ depositedAt: '20/07/2026', acceptedAt: null })).toBeNull();
    expect(decodeTransmission({ depositedAt: '2026-07-20', acceptedAt: 42 })).toBeNull();
  });
});

describe('decodeTransmissionGuide', () => {
  const guide = {
    channel: 'chorus',
    chorusServiceCode: 'SERV-42',
    checklist: [
      { label: 'Télécharger le PDF Factur-X', done: true },
      { label: 'Déposer sur Chorus', done: null },
    ],
  };
  it('guide chorus valide', () => {
    expect(decodeTransmissionGuide(guide)).toEqual(guide);
  });
  it('canal inconnu ou checklist difforme : null', () => {
    expect(decodeTransmissionGuide({ ...guide, channel: 'fax' })).toBeNull();
    expect(
      decodeTransmissionGuide({ ...guide, checklist: [{ label: '', done: true }] }),
    ).toBeNull();
    expect(
      decodeTransmissionGuide({ ...guide, checklist: [{ label: 'x', done: 'oui' }] }),
    ).toBeNull();
  });
});

describe('normalizeBillingTerrainCarrier — vue facture', () => {
  // `situationOrder?` déclaré pour satisfaire le type faible du normaliseur (aucune valeur émise).
  const base: { id: string; totals: object; situationOrder?: unknown } = {
    id: 'inv-1',
    totals: { ht: 1, vat: 0, ttc: 1, netToPay: 1, vatByRate: {} },
  };

  it('serveur ANTÉRIEUR (champs absents) : normalisés null/0 — jamais un échec', () => {
    const view = normalizeBillingTerrainCarrier({ ...base });
    expect(view).toMatchObject({
      situationOrder: null,
      situationDeductionCents: 0,
      globalDiscount: null,
      retenueGarantiePct: null,
      urgentRepair: null,
      transmission: null,
    });
    expect(view).not.toHaveProperty('transmissionGuide');
  });

  it('champs présents valides : conservés tels quels', () => {
    const view = normalizeBillingTerrainCarrier({
      ...base,
      situationOrder: 2,
      situationDeductionCents: 48_840,
      globalDiscount: { type: 'amount', cents: 500 },
      retenueGarantiePct: 5,
      urgentRepair: { requestedAt: '2026-07-20T10:00:00.000Z' },
      transmission: { depositedAt: '2026-07-21', acceptedAt: null },
    });
    expect(view).toMatchObject({
      situationOrder: 2,
      situationDeductionCents: 48_840,
      globalDiscount: { type: 'amount', cents: 500 },
      retenueGarantiePct: 5,
      urgentRepair: { requestedAt: '2026-07-20T10:00:00.000Z' },
      transmission: { depositedAt: '2026-07-21', acceptedAt: null },
    });
  });

  it('fait légal difforme : échec FERMÉ du décodage complet', () => {
    expect(normalizeBillingTerrainCarrier({ ...base, situationOrder: 0 })).toBeNull();
    expect(normalizeBillingTerrainCarrier({ ...base, situationDeductionCents: -1 })).toBeNull();
    expect(normalizeBillingTerrainCarrier({ ...base, globalDiscount: { type: 'x' } })).toBeNull();
    expect(normalizeBillingTerrainCarrier({ ...base, retenueGarantiePct: 'cinq' })).toBeNull();
    expect(normalizeBillingTerrainCarrier({ ...base, transmission: { depositedAt: 42 } })).toBeNull();
  });

  it('guide DÉRIVÉ difforme : RETIRÉ de la vue, la facture survit (aide ≠ fait légal)', () => {
    const view = normalizeBillingTerrainCarrier({
      ...base,
      transmissionGuide: { channel: 'fax', checklist: [] },
    });
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty('transmissionGuide');
  });

  it('PR-12b (§6.5) — contrat + période : ABSENTS restent absents (fail-closed), présents valides conservés', () => {
    const silent = normalizeBillingTerrainCarrier({ ...base });
    expect(silent).not.toHaveProperty('maintenanceContractId');
    expect(silent).not.toHaveProperty('servicePeriod');
    const carried = normalizeBillingTerrainCarrier({
      ...base,
      maintenanceContractId: 'contract-fontaines',
      servicePeriod: { start: '2025-10-12', end: '2026-10-11' },
    });
    expect(carried).toMatchObject({
      maintenanceContractId: 'contract-fontaines',
      servicePeriod: { start: '2025-10-12', end: '2026-10-11' },
    });
    const nulls = normalizeBillingTerrainCarrier({
      ...base,
      maintenanceContractId: null,
      servicePeriod: null,
    });
    expect(nulls).toMatchObject({ maintenanceContractId: null, servicePeriod: null });
    // Fin ponctuelle absente/nulle acceptée (forme A7 historique d'une pièce hors contrat).
    const openEnd = normalizeBillingTerrainCarrier({
      ...base,
      servicePeriod: { start: '2026-06-01', end: null },
    });
    expect(openEnd).toMatchObject({ servicePeriod: { start: '2026-06-01', end: null } });
  });

  it('PR-12b (§6.5) — contrat/période DIFFORMES : échec FERMÉ (jamais une couverture castée)', () => {
    expect(normalizeBillingTerrainCarrier({ ...base, maintenanceContractId: 42 })).toBeNull();
    expect(normalizeBillingTerrainCarrier({ ...base, servicePeriod: 'octobre' })).toBeNull();
    expect(
      normalizeBillingTerrainCarrier({ ...base, servicePeriod: { start: '12/10/2025', end: null } }),
    ).toBeNull();
    expect(
      normalizeBillingTerrainCarrier({ ...base, servicePeriod: { start: '2025-10-12', end: 42 } }),
    ).toBeNull();
  });
});
