import { describe, expect, it } from 'vitest';
import { neutrals, semantic, controls } from '@bob/tokens';
import {
  BUTTON_RADIUS_DEFAULT,
  BUTTON_RADIUS_MAX,
  BUTTON_RADIUS_MIN,
  clampButtonRadius,
  resolveButtonAppearance,
  type ButtonPalette,
} from './button.logic';

const palette: ButtonPalette = {
  surface: neutrals.surface,
  ink600: neutrals.ink600,
  slate300: neutrals.slate300,
  danger: semantic.danger,
  ai: semantic.ai,
  segmentedTrack: controls.segmentedTrack,
  buttonSecondaryBorder: controls.buttonSecondaryBorder,
};

describe('resolveButtonAppearance', () => {
  it('primaire actif → dégradé cta + texte surface', () => {
    const a = resolveButtonAppearance('primary', false, palette);
    expect(a.gradient).toBe(true);
    expect(a.textColor).toBe(neutrals.surface);
    expect(a.borderWidth).toBe(0);
  });

  it('secondaire → surface + bord buttonSecondaryBorder + texte ink600', () => {
    const a = resolveButtonAppearance('secondary', false, palette);
    expect(a).toEqual({
      gradient: false,
      backgroundColor: neutrals.surface,
      borderColor: controls.buttonSecondaryBorder,
      borderWidth: 1,
      textColor: neutrals.ink600,
    });
  });

  it('IA → fond semantic.ai + texte surface', () => {
    const a = resolveButtonAppearance('ai', false, palette);
    expect(a.backgroundColor).toBe(semantic.ai);
    expect(a.textColor).toBe(neutrals.surface);
    expect(a.gradient).toBe(false);
  });

  it('danger léger → transparent + bord et texte danger', () => {
    const a = resolveButtonAppearance('danger', false, palette);
    expect(a.backgroundColor).toBe('transparent');
    expect(a.borderColor).toBe(semantic.danger);
    expect(a.borderWidth).toBe(1);
    expect(a.textColor).toBe(semantic.danger);
  });

  it('désactivé → piste segmentedTrack + texte slate300, quelle que soit la variante', () => {
    for (const variant of ['primary', 'secondary', 'ai', 'danger'] as const) {
      const a = resolveButtonAppearance(variant, true, palette);
      expect(a.gradient).toBe(false);
      expect(a.backgroundColor).toBe(controls.segmentedTrack);
      expect(a.textColor).toBe(neutrals.slate300);
    }
  });
});

describe('clampButtonRadius', () => {
  it('défaut sans valeur', () => {
    expect(clampButtonRadius()).toBe(BUTTON_RADIUS_DEFAULT);
  });
  it('contraint aux bornes 11–15 des redlines', () => {
    expect(clampButtonRadius(4)).toBe(BUTTON_RADIUS_MIN);
    expect(clampButtonRadius(30)).toBe(BUTTON_RADIUS_MAX);
    expect(clampButtonRadius(12)).toBe(12);
  });
});
