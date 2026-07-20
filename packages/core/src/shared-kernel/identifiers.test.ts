import { describe, it, expect } from 'vitest';
import { Iban, Siren, Siret } from './identifiers';

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

describe('Iban', () => {
  it('valide un IBAN FR correct (mod 97), espaces et casse tolérés', () => {
    const r = Iban.of('FR76 3000 6000 0112 3456 7890 189');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.value).toBe('FR7630006000011234567890189');
  });
  it('rejette une clé de contrôle invalide', () => {
    expect(Iban.of('FR7630006000011234567890188').ok).toBe(false);
  });
  it('rejette un format incorrect (pays/longueur)', () => {
    expect(Iban.of('123456').ok).toBe(false);
    expect(Iban.of('1R7630006000011234567890189').ok).toBe(false);
  });
  it('masque le RIB — ne garde en clair que le préfixe pays/clé et les 4 derniers caractères', () => {
    const r = Iban.of('FR76 3000 6000 0112 3456 7890 189');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.masked()).toBe('FR76 •••• •••• •••• •••• •••• 0189');
  });
});
