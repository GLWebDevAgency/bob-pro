/**
 * FilterChip — logique PURE (Lot 3) : sélection en theme.ink (arbitrage SÉLECTION — fond
 * teinté ~9 %, bord ink), inactif neutre. Attendus en LITTÉRAUX : si un thème change
 * d'encre ou si la part de teinte bouge, ce test DOIT rougir.
 */
import { describe, expect, it } from 'vitest';
import { neutrals, themes } from '@bob/tokens';
import {
  FILTER_CHIP_HEIGHT,
  FILTER_CHIP_HIT_SLOP,
  FILTER_CHIP_REMOVE_DIAMETER,
  FILTER_CHIP_REMOVE_HIT_SLOP,
  FILTER_CHIP_TINT_SHARE,
  filterChipColors,
  type FilterChipPalette,
} from './filter-chip.logic';

const marine: FilterChipPalette = {
  ink: themes.marine.ink,
  surface: neutrals.surface,
  line: neutrals.line,
  slate500: neutrals.slate500,
};

describe('filterChipColors — la sélection parle theme.ink, jamais l’indigo de Bob', () => {
  it('actif (marine) : bord #0C2340, fond teinté 9 % = #E9EBEE, encre ink', () => {
    expect(filterChipColors(true, marine)).toEqual({
      border: '#0C2340',
      bg: '#E9EBEE', // mixTint(#FFFFFF → #0C2340, 0.09) — « fond teinté 8-10 % »
      fg: '#0C2340',
    });
  });

  it('actif (indigo — le THÈME indigo reste permis, seul le canal sémantique ai est interdit)', () => {
    const indigo: FilterChipPalette = { ...marine, ink: themes.indigo.ink };
    const c = filterChipColors(true, indigo);
    expect(c.border).toBe('#312C8A');
    expect(c.fg).toBe('#312C8A');
    // Jamais les tokens du canal Bob (semantic.ai #4338CA / aiBg #F1EBFA).
    expect(c.border).not.toBe('#4338CA');
    expect(c.bg).not.toBe('#F1EBFA');
  });

  it('inactif : surface + bord line + encre slate500 (proposition neutre)', () => {
    expect(filterChipColors(false, marine)).toEqual({
      bg: neutrals.surface,
      border: neutrals.line,
      fg: neutrals.slate500,
    });
  });

  it('part de teinte bornée à l’arbitrage « 8-10 % »', () => {
    expect(FILTER_CHIP_TINT_SHARE).toBeGreaterThanOrEqual(0.08);
    expect(FILTER_CHIP_TINT_SHARE).toBeLessThanOrEqual(0.1);
  });
});

describe('géométrie — cible ≥ 44 pt par hitSlop (gants du chantier)', () => {
  it('corps 30 + hitSlop 7×2 = 44 ; croix 18 + hitSlop 13×2 = 44', () => {
    expect(FILTER_CHIP_HEIGHT + 2 * FILTER_CHIP_HIT_SLOP).toBeGreaterThanOrEqual(44);
    expect(FILTER_CHIP_REMOVE_DIAMETER + 2 * FILTER_CHIP_REMOVE_HIT_SLOP).toBeGreaterThanOrEqual(44);
  });
});
