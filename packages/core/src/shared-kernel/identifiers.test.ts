import { describe, it, expect } from 'vitest';
import { Siren, Siret } from './identifiers';

describe('Siren/Siret', () => {
  it('valide un SIREN correct (Luhn)', () => {
    expect(Siren.of('732829320').ok).toBe(true);
  });
  it('rejette un SIREN à mauvaise longueur', () => {
    expect(Siren.of('1234').ok).toBe(false);
  });
  it('rejette un Luhn invalide', () => {
    expect(Siren.of('732829321').ok).toBe(false);
  });
  it('Siret expose son Siren', () => {
    const r = Siret.of('73282932000074');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.siren().value).toBe('732829320');
  });
});
