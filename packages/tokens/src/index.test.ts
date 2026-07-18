import { describe, it, expect } from 'vitest';
import {
  controls,
  defaultTheme,
  gradients,
  neutrals,
  radius,
  resolveColorRole,
  themes,
  toCssVars,
  type,
} from './index';

const WCAG_AA_NORMAL_TEXT = 4.5;
const WCAG_AA_LARGE_TEXT_OR_UI = 3;

function relativeLuminance(hex: string): number {
  if (!/^#[\da-f]{6}$/i.test(hex)) {
    throw new Error(`Couleur hexadécimale #RRGGBB attendue, reçu: ${hex}`);
  }

  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );

  return (0.2126 * (linear[0] ?? 0)) + (0.7152 * (linear[1] ?? 0)) + (0.0722 * (linear[2] ?? 0));
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

const CERTIFIED_NORMAL_TEXT_PAIRS = [
  ['texte principal / surface', resolveColorRole('text.primary'), neutrals.surface],
  ['texte secondaire / surface', resolveColorRole('text.secondary'), neutrals.surface],
  ['texte atténué / surface', resolveColorRole('text.muted'), neutrals.surface],
  ['navigation active / surface', resolveColorRole('navigation.active'), neutrals.surface],
  ['navigation Bob active / surface', resolveColorRole('navigation.assistantActive'), neutrals.surface],
  ['navigation inactive / surface', resolveColorRole('navigation.inactive'), neutrals.surface],
  ['segment inactif / piste', resolveColorRole('text.muted'), controls.segmentedTrack],
] as const;

const CERTIFIED_LARGE_TEXT_OR_UI_PAIRS = [
  ['texte secondaire / fond app', resolveColorRole('text.secondary'), neutrals.bg],
  ['navigation inactive / fond app', resolveColorRole('navigation.inactive'), neutrals.bg],
] as const;

describe('tokens', () => {
  it('expose les 4 thèmes de marque avec marine par défaut', () => {
    expect(Object.keys(themes)).toEqual(['marine', 'foret', 'graphite', 'indigo']);
    expect(defaultTheme).toBe('marine');
    expect(themes.marine.d1).toBe('#0C2340');
  });
  it('dérive les dégradés du thème actif', () => {
    const g = gradients(themes.marine);
    expect(g.header).toContain('#0C2340');
    expect(g.cta).toContain('linear-gradient');
  });
  it('échelle typographique et rayons figés', () => {
    expect(type.heroNum.size).toBe(42);
    expect(radius.card).toBe(16);
  });

  it.each(CERTIFIED_NORMAL_TEXT_PAIRS)(
    'certifie %s à au moins 4,5:1 pour le petit texte',
    (_label, foreground, background) => {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    },
  );

  it.each(CERTIFIED_LARGE_TEXT_OR_UI_PAIRS)(
    'certifie %s à au moins 3:1 pour grand texte, icône ou composant',
    (_label, foreground, background) => {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT_OR_UI);
    },
  );

  it('sépare les rôles éditoriaux des états désactivés et décoratifs', () => {
    expect(resolveColorRole('nonContent.disabled')).toBe(neutrals.slate400);
    expect(resolveColorRole('nonContent.decorative')).toBe(neutrals.slate300);
    expect(resolveColorRole('nonContent.disabled')).not.toBe(resolveColorRole('text.muted'));
    expect(resolveColorRole('nonContent.decorative')).not.toBe(resolveColorRole('text.muted'));
  });

  it.each(Object.entries(themes))('publie les rôles accessibles en CSS pour le thème %s', (_name, theme) => {
    const css = toCssVars(theme);

    expect(css['--bob-color-text-primary']).toBe(resolveColorRole('text.primary'));
    expect(css['--bob-color-text-muted']).toBe(resolveColorRole('text.muted'));
    expect(css['--bob-color-navigation-inactive']).toBe(resolveColorRole('navigation.inactive'));
    expect(css['--bob-color-disabled']).toBe(resolveColorRole('nonContent.disabled'));
    expect(css['--bob-color-decorative']).toBe(resolveColorRole('nonContent.decorative'));
    expect(contrastRatio(css['--bob-color-navigation-inactive'] ?? '', css['--bob-color-surface'] ?? ''))
      .toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio(css['--bob-color-text-muted'] ?? '', css['--bob-control-segmented-track'] ?? ''))
      .toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });
});
