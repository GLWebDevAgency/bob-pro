import { describe, it, expect } from 'vitest';
import { addDays, businessDayOf, isValidDateOnly, parisDateOnly } from './time';

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

  it("DISCRIMINE l'hiver de l'ete : 22:30Z en janvier reste la veille (23:30 CET, pas 00:30)", () => {
    // 2026-01-15T22:30:00Z = 2026-01-15T23:30 a Paris (CET UTC+1) : encore l'ancien jour. Un
    // calcul DST-naif a offset d'ete fige (+2 h toute l'annee) donnerait 2026-01-16T00:30 → le
    // lendemain. Le cas hiver ci-dessus (23:30Z) ne voit pas la difference (+1 h et +2 h donnent
    // tous deux le 16) : ce litteral-ci est le temoin qui tue ce mutant.
    expect(parisDateOnly('2026-01-15T22:30:00.000Z')).toBe('2026-01-15');
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

describe('businessDayOf', () => {
  it("Instant d'ete en fin de mois : 2026-07-31T22:18Z = 00:18 Paris le 1er aout (CEST +2) → 2026-08-01", () => {
    // Le litteral du bug CI d'origine : jour UTC '2026-07-31', jour metier '2026-08-01' — le mois
    // (et ici la serie du pilotage, l'assiette du mois URSSAF) a deja bascule cote Paris.
    expect(businessDayOf('2026-07-31T22:18:00.000Z')).toBe('2026-08-01');
  });

  it("Instant d'hiver en fin d'annee : 2026-12-31T23:30Z = 00:30 Paris le 1er janvier (CET +1) → 2027-01-01", () => {
    // La bascule d'ANNEE des seuils 293 B : l'encaissement appartient a l'annee 2027 du calendrier
    // metier alors que son annee UTC est encore 2026.
    expect(businessDayOf('2026-12-31T23:30:00.000Z')).toBe('2027-01-01');
  });

  it("TEMOIN DST : 2026-12-31T22:30Z = 23:30 Paris (CET +1, pas +2) → encore 2026-12-31", () => {
    // 22:30Z + 1 h = 23:30 le 31/12 (la veille) ; un calcul DST-naif a offset d'ete fige
    // (+2 h toute l'annee) donnerait 00:30 le 01/01. Le cas 23:30Z ci-dessus ne discrimine pas
    // (+1 et +2 donnent tous deux le 01/01) : ce litteral-ci est le temoin qui tue ce mutant.
    expect(businessDayOf('2026-12-31T22:30:00.000Z')).toBe('2026-12-31');
  });

  it('instant de pleine journee : 2026-07-15T10:00Z = 12:00 Paris → meme jour que le jour UTC', () => {
    expect(businessDayOf('2026-07-15T10:00:00.000Z')).toBe('2026-07-15');
  });

  it("DateOnly pure (pas de 'T') : deja un jour metier, restituee telle quelle sans projection", () => {
    expect(businessDayOf('2026-07-15')).toBe('2026-07-15');
  });
});
