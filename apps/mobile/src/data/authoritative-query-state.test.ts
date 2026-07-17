import { describe, expect, it } from 'vitest';
import { hasBlockingAuthoritativeDataError } from './authoritative-query-state';

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
