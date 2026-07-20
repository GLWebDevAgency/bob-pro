import { describe, expect, it } from 'vitest';
import {
  lastMonthRange,
  lastNMonthsRange,
  parseFrenchPeriod,
  thisMonthRange,
} from './parse-french-period';

// Date fixe (mardi) — aucune horloge ambiante, tout est déterministe.
const TODAY = '2026-07-16';

describe('parseFrenchPeriod (B9 — parité vocale des périodes FR)', () => {
  it('« ce mois-ci » -> 1er du mois en cours -> aujourd’hui', () => {
    expect(parseFrenchPeriod('les devis de ce mois-ci', TODAY)).toEqual({
      from: '2026-07-01',
      to: '2026-07-16',
      label: 'thisMonth',
    });
  });

  it('« ce mois » (sans "-ci") est reconnu de la même façon', () => {
    expect(parseFrenchPeriod('affiche les factures de ce mois', TODAY)?.label).toBe('thisMonth');
  });

  it('« le mois dernier » -> mois calendaire précédent COMPLET', () => {
    expect(parseFrenchPeriod('les devis du mois dernier', TODAY)).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
      label: 'lastMonth',
    });
  });

  it('« mois dernier » sans article est reconnu', () => {
    expect(parseFrenchPeriod('factures mois dernier', TODAY)?.label).toBe('lastMonth');
  });

  it('changement d’année : "mois dernier" en janvier vise décembre de l’année précédente', () => {
    expect(parseFrenchPeriod('le mois dernier', '2026-01-15')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
      label: 'lastMonth',
    });
  });

  it('« les 2 derniers mois » -> 1er du mois il y a 1 mois -> aujourd’hui', () => {
    expect(parseFrenchPeriod('les 2 derniers mois', TODAY)).toEqual({
      from: '2026-06-01',
      to: '2026-07-16',
      label: 'last2Months',
    });
  });

  it('nombre en toutes lettres : « les trois derniers mois »', () => {
    expect(parseFrenchPeriod('les trois derniers mois', TODAY)).toEqual({
      from: '2026-05-01',
      to: '2026-07-16',
      label: 'last3Months',
    });
  });

  it('« deux derniers mois » sans "les"', () => {
    expect(parseFrenchPeriod('deux derniers mois', TODAY)?.label).toBe('last2Months');
  });

  it('« cette semaine » -> lundi de la semaine en cours -> aujourd’hui', () => {
    // 2026-07-16 est un jeudi -> lundi = 2026-07-13
    expect(parseFrenchPeriod('cette semaine', TODAY)).toEqual({
      from: '2026-07-13',
      to: '2026-07-16',
      label: 'thisWeek',
    });
  });

  it('« aujourd\'hui » -> une seule journée', () => {
    expect(parseFrenchPeriod('aujourd\'hui', TODAY)).toEqual({ from: TODAY, to: TODAY, label: 'today' });
  });

  it('« cette année » -> 1er janvier -> aujourd’hui', () => {
    expect(parseFrenchPeriod('cette année', TODAY)).toEqual({ from: '2026-01-01', to: TODAY, label: 'thisYear' });
  });

  it('« depuis janvier » (mois déjà passé cette année) -> 1er janvier de l’année en cours', () => {
    expect(parseFrenchPeriod('depuis janvier', TODAY)).toEqual({
      from: '2026-01-01',
      to: TODAY,
      label: 'since:janvier',
    });
  });

  it('« depuis le mois de mars »', () => {
    expect(parseFrenchPeriod('depuis le mois de mars', TODAY)).toEqual({
      from: '2026-03-01',
      to: TODAY,
      label: 'since:mars',
    });
  });

  it('« depuis décembre » énoncé en juillet vise DÉCEMBRE DE L’ANNÉE PRÉCÉDENTE (mois futur exclu)', () => {
    expect(parseFrenchPeriod('depuis décembre', TODAY)).toEqual({
      from: '2025-12-01',
      to: TODAY,
      label: 'since:decembre',
    });
  });

  it('accents et casse ignorés : « DEPUIS AOÛT »', () => {
    expect(parseFrenchPeriod('DEPUIS AOÛT', TODAY)?.label).toBe('since:aout');
  });

  it('aucune tournure reconnue -> null (jamais un pari)', () => {
    expect(parseFrenchPeriod('les devis de la mairie', TODAY)).toBeNull();
    expect(parseFrenchPeriod('', TODAY)).toBeNull();
  });

  it('today invalide -> null', () => {
    expect(parseFrenchPeriod('ce mois-ci', '2026-13-40')).toBeNull();
  });

  it('lastNMonthsRange(1) équivaut à thisMonthRange (même 1er du mois)', () => {
    expect(lastNMonthsRange(TODAY, 1)).toEqual(thisMonthRange(TODAY));
  });

  it('lastMonthRange et thisMonthRange ne se chevauchent jamais', () => {
    const last = lastMonthRange(TODAY);
    const cur = thisMonthRange(TODAY);
    expect(last.to < cur.from).toBe(true);
  });
});
