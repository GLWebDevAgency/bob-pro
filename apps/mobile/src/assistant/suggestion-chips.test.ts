import { describe, expect, it } from 'vitest';
import {
  SUGGESTION_CHIP_POOL,
  SUGGESTION_CHIPS_PER_VISIT,
  rotateSuggestionChips,
} from './suggestion-chips';

describe('rotateSuggestionChips — rotation par visite du pool canonique (S9)', () => {
  it('visite 0 : la première fenêtre du pool, dans l’ordre', () => {
    expect(rotateSuggestionChips(SUGGESTION_CHIP_POOL, 0)).toEqual(
      SUGGESTION_CHIP_POOL.slice(0, SUGGESTION_CHIPS_PER_VISIT),
    );
  });

  it('la fenêtre avance de `count` à chaque visite (wrap circulaire)', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'] as const;
    expect(rotateSuggestionChips(pool, 0, 2)).toEqual(['a', 'b']);
    expect(rotateSuggestionChips(pool, 1, 2)).toEqual(['c', 'd']);
    expect(rotateSuggestionChips(pool, 2, 2)).toEqual(['e', 'a']);
    expect(rotateSuggestionChips(pool, 3, 2)).toEqual(['b', 'c']);
  });

  it('déterministe : une même visite rend toujours la même rangée', () => {
    expect(rotateSuggestionChips(SUGGESTION_CHIP_POOL, 7)).toEqual(
      rotateSuggestionChips(SUGGESTION_CHIP_POOL, 7),
    );
  });

  it('jamais de doublon dans une même fenêtre', () => {
    for (let visit = 0; visit < SUGGESTION_CHIP_POOL.length * 2; visit += 1) {
      const window = rotateSuggestionChips(SUGGESTION_CHIP_POOL, visit);
      expect(new Set(window).size).toBe(window.length);
    }
  });

  it('tout le pool finit par être montré au fil des visites', () => {
    const seen = new Set<string>();
    for (let visit = 0; visit < SUGGESTION_CHIP_POOL.length; visit += 1) {
      for (const key of rotateSuggestionChips(SUGGESTION_CHIP_POOL, visit)) seen.add(key);
    }
    expect(seen.size).toBe(SUGGESTION_CHIP_POOL.length);
  });

  it('bords : pool vide → rien ; count ≤ 0 → rien ; count > pool → tout le pool sans doublon', () => {
    expect(rotateSuggestionChips([], 3)).toEqual([]);
    expect(rotateSuggestionChips(SUGGESTION_CHIP_POOL, 1, 0)).toEqual([]);
    const all = rotateSuggestionChips(SUGGESTION_CHIP_POOL, 2, SUGGESTION_CHIP_POOL.length + 5);
    expect(all).toHaveLength(SUGGESTION_CHIP_POOL.length);
    expect(new Set(all).size).toBe(SUGGESTION_CHIP_POOL.length);
  });

  it('visite négative ou non finie : repli fail-safe sur la fenêtre 0', () => {
    const first = rotateSuggestionChips(SUGGESTION_CHIP_POOL, 0);
    expect(rotateSuggestionChips(SUGGESTION_CHIP_POOL, -4)).toEqual(first);
    expect(rotateSuggestionChips(SUGGESTION_CHIP_POOL, Number.NaN)).toEqual(first);
  });
});
