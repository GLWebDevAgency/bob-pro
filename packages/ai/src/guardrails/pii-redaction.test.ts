import { describe, it, expect } from 'vitest';
import { redactPII } from './pii-redaction';

describe('redactPII', () => {
  it('masque un email', () => {
    const out = redactPII('écris à jean.dupont@example.com stp');
    expect(out).toContain('[email]');
    expect(out).not.toContain('jean.dupont@example.com');
  });

  it('masque un téléphone FR (espacé, collé, +33)', () => {
    expect(redactPII('appelle le 06 12 34 56 78')).toContain('[tel]');
    expect(redactPII('num 0612345678')).toContain('[tel]');
    expect(redactPII('tel +33 6 12 34 56 78')).toContain('[tel]');
  });

  it('masque un IBAN', () => {
    const out = redactPII('vire sur FR76 3000 6000 0112 3456 7890 189 merci');
    expect(out).toContain('[iban]');
    expect(out).not.toContain('3456');
  });

  it.each([
    'fr76 3000 6000 0112 3456 7890 189',
    'FR76-3000-6000-0112-3456-7890-189',
    'fr76.3000.6000.0112.3456.7890.189',
  ])('masque les variantes usuelles d’IBAN : %s', (iban) => {
    expect(redactPII(`vire sur ${iban} merci`)).toBe(
      'vire sur [iban] merci',
    );
  });

  it.each([
    '(06) 12 34 56 78',
    '06/12/34/56/78',
    '06.12.34.56.78',
    '+33 (0)6 12 34 56 78',
  ])('masque les variantes usuelles de téléphone FR : %s', (phone) => {
    expect(redactPII(`appelle ${phone} maintenant`)).toBe(
      'appelle [tel] maintenant',
    );
  });

  it('masque un SIREN (9) et un SIRET (14)', () => {
    expect(redactPII('siren 732829320')).toContain('[siren]');
    expect(redactPII('siret 73282932000074')).toContain('[siren]');
    expect(redactPII('siret 732 829 320 00074')).toBe('siret [siren]');
  });

  it('masque aussi un IBAN dicté avec checksum invalide', () => {
    const invalid = 'FR00 3000 6000 0112 3456 7890 189';
    expect(redactPII(`référence ${invalid}`)).toBe('référence [iban]');
  });

  it.each([
    'BY86AKBB10100000002966000000',
    'MU17BOMM0101101030300200000MUR',
    'EG380019000500000000263180002',
    'DZ580002100001113000000570',
    'BR1800000000141455123924100C2',
  ])('masque les IBAN valides hors ancienne allowlist européenne : %s', (iban) => {
    expect(redactPII(`vire sur ${iban} merci`)).toBe('vire sur [iban] merci');
  });

  it.each([
    'BY16AKBB00000000000000000014',
    'BY53AKBB00000000000000000027',
  ])('ne laisse aucun suffixe lorsqu’un préfixe IBAN passe déjà MOD-97 : %s', (iban) => {
    const once = redactPII(`vire sur ${iban} merci`);
    expect(once).toBe('vire sur [iban] merci');
    expect(redactPII(once)).toBe(once);
  });

  it('PRÉSERVE le numéro de facture et le nom client (références de la commande)', () => {
    const out = redactPII('encaisse la facture 2026-014 de Durand');
    expect(out).toContain('2026-014');
    expect(out).toContain('Durand');
  });

  it('PRÉSERVE les montants formatés', () => {
    expect(redactPII('marque payée la facture de 1 320,00 €')).toContain('1 320,00');
  });

  it('idempotent (les marqueurs ne contiennent aucun PII)', () => {
    const once = redactPII('mail a@b.fr et 06 12 34 56 78 iban FR76 3000 6000 0112 3456 7890 189');
    expect(redactPII(once)).toBe(once);
  });

  it('texte sans PII inchangé, vide géré', () => {
    expect(redactPII('liste mes impayés')).toBe('liste mes impayés');
    expect(redactPII('')).toBe('');
  });
});
