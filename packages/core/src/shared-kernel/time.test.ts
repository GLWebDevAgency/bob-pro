import { describe, it, expect } from 'vitest';
import { addDays, isValidDateOnly, parisDateOnly } from './time';

describe('parisDateOnly', () => {
  it('coincide avec la date UTC en pleine journee (loin de minuit)', () => {
    expect(parisDateOnly('2026-07-17T12:00:00.000Z')).toBe('2026-07-17');
  });

  it("bascule le jour AVANT l'UTC juste apres minuit Paris, en ete (CEST UTC+2)", () => {
    // 2026-07-16T22:30:00Z = 2026-07-17T00:30 a Paris (ete) : le jour metier a deja change,
    // alors que SystemClock.today() (UTC brut) afficherait encore '2026-07-16'.
    expect(parisDateOnly('2026-07-16T22:30:00.000Z')).toBe('2026-07-17');
  });

  it("bascule le jour AVANT l'UTC juste apres minuit Paris, en hiver (CET UTC+1)", () => {
    // 2026-01-15T23:30:00Z = 2026-01-16T00:30 a Paris (hiver) : meme ecart, offset different.
    expect(parisDateOnly('2026-01-15T23:30:00.000Z')).toBe('2026-01-16');
  });

  it('accepte un objet Date en plus d’un Instant ISO', () => {
    expect(parisDateOnly(new Date('2026-01-15T23:30:00.000Z'))).toBe('2026-01-16');
  });

  it('produit toujours une DateOnly valide (round-trip isValidDateOnly)', () => {
    const d = parisDateOnly('2026-03-29T01:30:00.000Z'); // nuit de bascule DST FR
    expect(isValidDateOnly(d)).toBe(true);
  });

  it('reste coherent avec addDays (arithmetique UTC existante) sur une journee non-frontiere', () => {
    const today = parisDateOnly('2026-07-17T12:00:00.000Z');
    expect(addDays(today, 1)).toBe('2026-07-18');
  });
});
