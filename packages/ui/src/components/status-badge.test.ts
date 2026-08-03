import { describe, expect, it } from 'vitest';
import { neutrals, semantic, controls, themes } from '@bob/tokens';
import {
  BADGE_RADIUS,
  CHIP_HEIGHT,
  CHIP_HIT_SLOP,
  STATUS_BADGE_VARIANT_BY_LEGACY_TONE,
  chipColors,
  statusBadgeColors,
  statusBadgeVariantForLegacyTone,
  type LegacyBadgeTone,
  type StatusBadgePalette,
} from './status-badge.logic';

const palette: StatusBadgePalette = {
  danger: semantic.danger,
  dangerBadgeBg: controls.dangerBadgeBg,
  neutralInk: neutrals.slate500,
  neutralBg: neutrals.lineSoft,
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
  ai: semantic.ai,
  aiBg: semantic.aiBg,
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

describe('statusBadgeColors — variante additive `neutral` (P1 §1.5)', () => {
  it('état sorti du flux (Retirée, Résilié, Échu) → slate500 sur lineSoft', () => {
    expect(statusBadgeColors('neutral', palette)).toEqual({
      fg: neutrals.slate500,
      bg: neutrals.lineSoft,
    });
  });

  it('non-régression : les 6 variantes historiques restent inchangées au pixel', () => {
    expect(statusBadgeColors('danger', palette)).toEqual({ fg: semantic.danger, bg: controls.dangerBadgeBg });
    expect(statusBadgeColors('warning', palette)).toEqual({ fg: semantic.warning, bg: semantic.warningBg });
    expect(statusBadgeColors('b2b', palette)).toEqual({ fg: semantic.b2b, bg: semantic.b2bBg });
    expect(statusBadgeColors('b2g', palette)).toEqual({ fg: semantic.b2g, bg: semantic.b2gBg });
    expect(statusBadgeColors('particulier', palette)).toEqual({ fg: semantic.particulier, bg: semantic.particulierBg });
    expect(statusBadgeColors('success', palette)).toEqual({ fg: semantic.success, bg: semantic.successBg });
  });
});

describe('statusBadgeColors — variante additive `ai` (Lot 0, plan DA 01/08)', () => {
  it("la voix de Bob → semantic.ai sur aiBg — les MÊMES teintes que le Badge legacy tone 'ai' (littéraux)", () => {
    // Badge legacy (src/components/ui index.tsx l.202) : ai = { bg: '#F1EBFA', fg: '#4338CA' }.
    expect(statusBadgeColors('ai', palette)).toEqual({ fg: '#4338CA', bg: '#F1EBFA' });
  });
});

describe('table BadgeTone legacy → StatusBadgeVariant (Lot 0 — FIGÉE avant toute migration)', () => {
  it('couvre les 7 tones du Badge legacy, identité sur les 6 partagés et ai → ai', () => {
    expect(STATUS_BADGE_VARIANT_BY_LEGACY_TONE).toEqual({
      b2b: 'b2b',
      b2g: 'b2g',
      particulier: 'particulier',
      success: 'success',
      warning: 'warning',
      danger: 'danger',
      ai: 'ai',
    });
  });

  it('chaque tone legacy résout une variante qui REND des couleurs (aucun trou de mapping)', () => {
    const tones: LegacyBadgeTone[] = ['b2b', 'b2g', 'particulier', 'success', 'warning', 'danger', 'ai'];
    for (const tone of tones) {
      const variant = statusBadgeVariantForLegacyTone(tone);
      const colors = statusBadgeColors(variant, palette);
      expect(colors.fg, `fg de ${tone}`).toMatch(/^#/);
      expect(colors.bg, `bg de ${tone}`).toMatch(/^#/);
    }
  });

  it('la table est gelée (Object.freeze) — personne ne la « corrige » en douce pendant une migration', () => {
    expect(Object.isFrozen(STATUS_BADGE_VARIANT_BY_LEGACY_TONE)).toBe(true);
  });
});

describe('PREUVE DE TEINTE par tone legacy (verdict PR #61, P3) — pas seulement les noms', () => {
  // Le Badge legacy (src/components/ui index.tsx l.195-203) peignait : fg = semantic.<tone>,
  // bg = semantic.<tone>Bg — SAUF danger (bg = semantic.dangerBg). La table figée doit donc
  // prouver les COULEURS au pixel, tone par tone, en LITTÉRAUX (un drift de token casse ici).
  it.each([
    ['b2b', '#1B3A63', '#E6EDF6'],
    ['b2g', '#4338CA', '#EDEAFE'],
    ['particulier', '#C77A12', '#FBF0DF'],
    ['success', '#0E7C5A', '#EAF2EC'],
    ['warning', '#C77A12', '#FBF0DF'],
    ['ai', '#4338CA', '#F1EBFA'],
  ] as const)(
    'tone %s → mêmes teintes que le Badge legacy, au pixel (fg %s / bg %s)',
    (tone, fg, bg) => {
      expect(statusBadgeColors(statusBadgeVariantForLegacyTone(tone), palette)).toEqual({ fg, bg });
    },
  );

  it('tone danger → SEUL écart de teinte assumé : fond redlines §7 #FBE7E4 (controls.dangerBadgeBg), plus le semantic.dangerBg #FBEAE8 du legacy', () => {
    const colors = statusBadgeColors(statusBadgeVariantForLegacyTone('danger'), palette);
    expect(colors).toEqual({ fg: '#C8463C', bg: '#FBE7E4' });
    // L'écart est une DÉCISION (cible redlines §7 de l'extinction), pas un accident : le fond
    // legacy ne doit pas réapparaître ici par un « alignement » silencieux du token.
    expect(colors.bg).not.toBe('#FBEAE8');
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
