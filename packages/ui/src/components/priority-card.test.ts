/**
 * Tests de la logique pure de PriorityCard (aucun import react-native ni .tsx).
 * Les couleurs de test sont construites numériquement (zéro littéral hex — token-lint).
 */
import { describe, expect, it } from 'vitest';
import {
  DONE_BORDER_MIX,
  mixHex,
  priorityAccentToken,
  resolvePriorityCardColors,
  type PriorityCardPalette,
} from './priority-card.logic';

/** Construit "#rrggbb" à partir de canaux numériques (pas de littéral hex en source). */
const hex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

const palette: PriorityCardPalette = {
  accents: {
    dangerVivid: hex(229, 84, 75), // semantic.dangerVivid
    ink600: hex(27, 58, 99), // neutrals.ink600
    b2g: hex(67, 56, 202), // semantic.b2g
  },
  surface: hex(255, 255, 255),
  cardBorder: hex(234, 238, 243),
  ink800: hex(15, 34, 53),
  success: hex(14, 124, 90),
  successBg: hex(234, 242, 236),
};

describe('priorityAccentToken', () => {
  it('mappe retard → dangerVivid', () => {
    expect(priorityAccentToken('retard')).toBe('dangerVivid');
  });
  it('mappe marine → ink600', () => {
    expect(priorityAccentToken('marine')).toBe('ink600');
  });
  it('mappe conformite → b2g', () => {
    expect(priorityAccentToken('conformite')).toBe('b2g');
  });
});

describe('mixHex', () => {
  const black = hex(0, 0, 0);
  const white = hex(255, 255, 255);

  it('retourne la couleur de départ à t=0', () => {
    expect(mixHex(black, white, 0)).toBe(black);
  });
  it('retourne la couleur cible à t=1', () => {
    expect(mixHex(black, white, 1)).toBe(white);
  });
  it('interpole au milieu (arrondi canal par canal)', () => {
    expect(mixHex(black, white, 0.5)).toBe(hex(128, 128, 128));
  });
  it('borne t hors [0,1]', () => {
    expect(mixHex(black, white, -3)).toBe(black);
    expect(mixHex(black, white, 7)).toBe(white);
  });
  it('interpole chaque canal indépendamment', () => {
    expect(mixHex(hex(100, 200, 40), hex(200, 100, 40), 0.5)).toBe(hex(150, 150, 40));
  });
});

describe('resolvePriorityCardColors', () => {
  it('au repos : fond surface, bord cardBorder, titre ink800, accent par statut', () => {
    const c = resolvePriorityCardColors('retard', false, palette);
    expect(c).toEqual({
      accent: palette.accents.dangerVivid,
      background: palette.surface,
      border: palette.cardBorder,
      title: palette.ink800,
    });
    expect(resolvePriorityCardColors('marine', false, palette).accent).toBe(
      palette.accents.ink600,
    );
    expect(resolvePriorityCardColors('conformite', false, palette).accent).toBe(
      palette.accents.b2g,
    );
  });

  it('fait : fond successBg, titre et accent success, bord dérivé (assombri vers success)', () => {
    const c = resolvePriorityCardColors('retard', true, palette);
    expect(c.background).toBe(palette.successBg);
    expect(c.title).toBe(palette.success);
    expect(c.accent).toBe(palette.success);
    expect(c.border).toBe(mixHex(palette.successBg, palette.success, DONE_BORDER_MIX));
    expect(c.border).not.toBe(palette.successBg); // bien dérivé, pas le fond
  });

  it('le bord « fait » est plus sombre que successBg sur chaque canal', () => {
    const { border } = resolvePriorityCardColors('marine', true, palette);
    const channels = (color: string): number[] =>
      [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
    const derived = channels(border);
    const bg = channels(palette.successBg);
    derived.forEach((v, i) => {
      expect(v).toBeLessThan(bg[i] ?? Number.POSITIVE_INFINITY);
    });
  });
});
