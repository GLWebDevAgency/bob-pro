import { describe, expect, it } from 'vitest';
import type { CompanyLookupResult } from '@bob/core';
import { decideSiretLookupResult } from './customer-form-siret.logic';

const RESULT: CompanyLookupResult = {
  siren: '451321335',
  siret: '45132133501021',
  denomination: 'CARREFOUR HYPERMARCHES',
  nafApe: '68.20B',
  trade: null,
  natureJuridiqueCode: '5710',
  legalForm: 'SAS',
  dateCreation: '2000-01-03',
  address: { line1: '280 RUE DE PARIS', zip: '93100', city: 'MONTREUIL' },
  tvaIntracom: 'FR90451321335',
  etatAdministratif: 'F',
  rge: false,
};

describe('decideSiretLookupResult', () => {
  it('applique atomiquement l identité exacte, l adresse et le statut F', () => {
    expect(
      decideSiretLookupResult({
        requestId: 2,
        latestRequestId: 2,
        requestedSiret: RESULT.siret,
        currentSiret: RESULT.siret,
        result: RESULT,
      }),
    ).toEqual({
      kind: 'apply',
      siret: RESULT.siret,
      siren: RESULT.siren,
      denomination: RESULT.denomination,
      tvaIntracom: RESULT.tvaIntracom,
      closed: true,
      address: RESULT.address,
      addressLabel: '280 RUE DE PARIS, 93100 MONTREUIL',
      addressLocked: true,
      addressMissing: false,
    });
  });

  it('ignore une réponse antérieure même si elle porte le même SIRET', () => {
    expect(
      decideSiretLookupResult({
        requestId: 1,
        latestRequestId: 2,
        requestedSiret: RESULT.siret,
        currentSiret: RESULT.siret,
        result: RESULT,
      }),
    ).toEqual({ kind: 'stale' });
  });

  it('ignore la réponse A après que le champ affiche B', () => {
    expect(
      decideSiretLookupResult({
        requestId: 1,
        latestRequestId: 1,
        requestedSiret: RESULT.siret,
        currentSiret: '73282932000074',
        result: RESULT,
      }),
    ).toEqual({ kind: 'stale' });
  });

  it('refuse une réponse dont le SIRET ne correspond pas à la requête', () => {
    expect(
      decideSiretLookupResult({
        requestId: 1,
        latestRequestId: 1,
        requestedSiret: RESULT.siret,
        currentSiret: RESULT.siret,
        result: { ...RESULT, siret: '73282932000074', siren: '732829320' },
      }),
    ).toEqual({ kind: 'identity_mismatch' });
  });

  it('efface explicitement l ancienne adresse quand l annuaire n en publie aucune', () => {
    expect(
      decideSiretLookupResult({
        requestId: 3,
        latestRequestId: 3,
        requestedSiret: RESULT.siret,
        currentSiret: RESULT.siret,
        result: { ...RESULT, address: null, etatAdministratif: 'A' },
      }),
    ).toMatchObject({
      kind: 'apply',
      address: null,
      addressLabel: '',
      addressLocked: false,
      addressMissing: true,
      closed: false,
    });
  });
});
