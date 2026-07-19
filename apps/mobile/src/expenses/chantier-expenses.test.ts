import { describe, expect, it } from 'vitest';
import { chantierExpensesTotalCents, expensesForChantier } from './chantier-expenses';

const expenses = [
  { id: 'e1', chantierId: 'ch-durand', documentDate: '2026-07-01', totalTtcCents: 12_050 },
  { id: 'e2', chantierId: null, documentDate: '2026-07-10', totalTtcCents: 4_000 },
  { id: 'e3', chantierId: 'ch-martin', documentDate: '2026-07-05', totalTtcCents: 9_900 },
  { id: 'e4', chantierId: 'ch-durand', documentDate: '2026-07-18', totalTtcCents: 30_000 },
  // Ligne HISTORIQUE sans champ chantierId (additif) — jamais imputée par accident.
  { id: 'e5', documentDate: '2026-07-02', totalTtcCents: 1_000 },
] as const;

describe('expensesForChantier', () => {
  it('ne retient que les dépenses imputées au chantier, les plus récentes en tête', () => {
    const linked = expensesForChantier(expenses, 'ch-durand');
    expect(linked.map((expense) => expense.id)).toEqual(['e4', 'e1']);
  });

  it('exclut les dépenses hors chantier (null) ET les lignes historiques sans champ', () => {
    const ids = expensesForChantier(expenses, 'ch-durand').map((expense) => expense.id);
    expect(ids).not.toContain('e2');
    expect(ids).not.toContain('e5');
  });

  it('liste vide pour un chantier sans dépense ou un id vide (jamais de correspondance floue)', () => {
    expect(expensesForChantier(expenses, 'ch-inconnu')).toEqual([]);
    expect(expensesForChantier(expenses, '')).toEqual([]);
  });

  it('ne mute jamais la liste source (tri sur copie)', () => {
    const source = [...expenses];
    expensesForChantier(source, 'ch-durand');
    expect(source.map((expense) => expense.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });
});

describe('chantierExpensesTotalCents', () => {
  it('additionne les TTC en centimes entiers', () => {
    const linked = expensesForChantier(expenses, 'ch-durand');
    expect(chantierExpensesTotalCents(linked)).toBe(42_050);
  });

  it('0 pour une liste vide', () => {
    expect(chantierExpensesTotalCents([])).toBe(0);
  });
});
