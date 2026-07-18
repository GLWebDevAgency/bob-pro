import { describe, expect, it } from 'vitest';
import { neutrals, semantic, controls, themes } from '@bob/tokens';
import {
  BADGE_RADIUS,
  CHIP_HEIGHT,
  CHIP_HIT_SLOP,
  chipColors,
  statusBadgeColors,
  type StatusBadgePalette,
} from './status-badge.logic';

const palette: StatusBadgePalette = {
  danger: semantic.danger,
  dangerBadgeBg: controls.dangerBadgeBg,
  warning: semantic.warning,
  warningBg: semantic.warningBg,
  b2b: semantic.b2b,
  b2bBg: semantic.b2bBg,
  b2g: semantic.b2g,
  b2gBg: semantic.b2gBg,
  particulier: semantic.particulier,
  particulierBg: semantic.particulierBg,
  success: semantic.success,
  successBg: semantic.successBg,
};

describe('statusBadgeColors — redlines §7', () => {
  it('retard/impayé → danger + dangerBadgeBg (fond dédié des redlines)', () => {
    expect(statusBadgeColors('danger', palette)).toEqual({
      fg: semantic.danger,
      bg: controls.dangerBadgeBg,
    });
  });

  it('devis accepté / B2B → b2b + b2bBg', () => {
    expect(statusBadgeColors('b2b', palette)).toEqual({
      fg: semantic.b2b,
      bg: semantic.b2bBg,
    });
  });

  it('e-facture / IA / B2G → b2g + b2gBg', () => {
    expect(statusBadgeColors('b2g', palette)).toEqual({
      fg: semantic.b2g,
      bg: semantic.b2gBg,
    });
  });

  it('particulier / échéance → particulier + particulierBg', () => {
    expect(statusBadgeColors('particulier', palette)).toEqual({
      fg: semantic.particulier,
      bg: semantic.particulierBg,
    });
  });

  it('à justifier / en attente → warning + warningBg (ambre doux)', () => {
    expect(statusBadgeColors('warning', palette)).toEqual({
      fg: semantic.warning,
      bg: semantic.warningBg,
    });
  });

  it('payé / à jour → success + successBg', () => {
    expect(statusBadgeColors('success', palette)).toEqual({
      fg: semantic.success,
      bg: semantic.successBg,
    });
  });

  it('radius de badge = 6 (redlines §Fondations)', () => {
    expect(BADGE_RADIUS).toBe(6);
  });
});

describe('chipColors — mode filtre', () => {
  const chipPalette = {
    ink: themes.marine.ink,
    surface: neutrals.surface,
    line: neutrals.line,
    slate500: neutrals.slate500,
  };

  it('actif → fond ink du thème, texte surface', () => {
    expect(chipColors(true, chipPalette)).toEqual({
      bg: themes.marine.ink,
      border: themes.marine.ink,
      fg: neutrals.surface,
    });
  });

  it('inactif → surface + bord line, texte slate500', () => {
    expect(chipColors(false, chipPalette)).toEqual({
      bg: neutrals.surface,
      border: neutrals.line,
      fg: neutrals.slate500,
    });
  });

  it('hitSlop compense la hauteur 34 pour atteindre 44', () => {
    expect(CHIP_HEIGHT + 2 * CHIP_HIT_SLOP).toBeGreaterThanOrEqual(44);
  });
});
