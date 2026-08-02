/**
 * firstQueryErrorFacts — preuves en littéraux : le PREMIER échec fait autorité, le code vient
 * du registre fermé quand l'AppError n'en porte pas, et un échec non typé reste honnête (500).
 */
import { describe, expect, it } from 'vitest';
import { firstQueryErrorFacts } from './query-error-facts';

describe('firstQueryErrorFacts', () => {
  it('aucun échec → null (rien à afficher)', () => {
    expect(firstQueryErrorFacts([{ isError: false, error: undefined }])).toBeNull();
    expect(firstQueryErrorFacts([])).toBeNull();
  });

  it('le PREMIER échec fait autorité — code/corrélation/kind extraits tels quels', () => {
    const facts = firstQueryErrorFacts([
      { isError: false, error: undefined },
      {
        isError: true,
        error: { kind: 'unavailable', code: 'BOB-API-503', correlationId: 'abc123def456' },
      },
      { isError: true, error: { kind: 'not_found', correlationId: 'zzz' } },
    ]);
    expect(facts).toEqual({ code: 'BOB-API-503', correlationId: 'abc123def456', kind: 'unavailable' });
  });

  it('AppError sans code → code PROJETÉ du registre (kind unavailable → BOB-API-503)', () => {
    const facts = firstQueryErrorFacts([
      { isError: true, error: { kind: 'unavailable', service: 'bank-balance-stale' } },
    ]);
    expect(facts).toEqual({ code: 'BOB-API-503', correlationId: null, kind: 'unavailable' });
  });

  it('échec non typé (réseau, throw brut) → 500 honnête, aucune corrélation inventée', () => {
    expect(firstQueryErrorFacts([{ isError: true, error: new TypeError('fetch failed') }])).toEqual({
      code: 'BOB-API-500',
      correlationId: null,
      kind: null,
    });
    expect(firstQueryErrorFacts([{ isError: true, error: undefined }])).toEqual({
      code: 'BOB-API-500',
      correlationId: null,
      kind: null,
    });
  });
});
