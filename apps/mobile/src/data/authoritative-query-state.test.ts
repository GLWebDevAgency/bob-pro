import { describe, expect, it } from 'vitest';
import {
  authoritativeDataWhenHealthy,
  hasBlockingAuthoritativeDataError,
} from './authoritative-query-state';

describe('authoritativeDataWhenHealthy', () => {
  it('retire une photographie en cache dès que sa qualification est en erreur', () => {
    expect(
      authoritativeDataWhenHealthy({
        isError: true,
        data: { amountCents: 12_300 },
      }),
    ).toBeUndefined();
  });

  it('préserve les valeurs autoritatives chargées, y compris zéro et liste vide', () => {
    expect(authoritativeDataWhenHealthy({ isError: false, data: 0 })).toBe(0);
    expect(authoritativeDataWhenHealthy({ isError: false, data: [] })).toEqual([]);
  });
});

describe('hasBlockingAuthoritativeDataError', () => {
  it('bloque une erreur qui ne possède aucune photographie serveur', () => {
    expect(hasBlockingAuthoritativeDataError([{ isError: true, data: undefined }])).toBe(true);
  });

  it('ne transforme pas une liste vide ou un zéro réellement chargés en donnée manquante', () => {
    expect(
      hasBlockingAuthoritativeDataError([
        { isError: false, data: [] },
        { isError: false, data: 0 },
      ]),
    ).toBe(false);
  });

  it('conserve une photographie réelle lors d’un échec de rafraîchissement', () => {
    expect(
      hasBlockingAuthoritativeDataError([{ isError: true, data: { amountCents: 12_300 } }]),
    ).toBe(false);
  });
});
