import { describe, expect, it } from 'vitest';
import { surfaceTint } from '@bob/tokens';
import { bobSurfaceColors } from './bob-surface.logic';

describe('bobSurfaceColors — kit « matière Bob » (P1 §1.2)', () => {
  it('résout flat/raised depuis surfaceTint, dans les 2 apparences', () => {
    expect(bobSurfaceColors({ tone: 'marine', emphasis: 'flat', appearance: 'light' })).toMatchObject({
      backgroundColor: surfaceTint.light.marine.flat,
      borderColor: surfaceTint.light.marine.border,
      borderWidth: 1,
      ink: surfaceTint.light.marine.ink,
      elevated: false,
    });
    expect(bobSurfaceColors({ tone: 'marine', emphasis: 'raised', appearance: 'dark' })).toMatchObject({
      backgroundColor: surfaceTint.dark.marine.raised,
      elevated: false,
    });
  });

  it('floating = fond raised + élévation (ombre posée par le composant)', () => {
    const colors = bobSurfaceColors({ tone: 'neutral', emphasis: 'floating', appearance: 'light' });
    expect(colors.backgroundColor).toBe(surfaceTint.light.neutral.raised);
    expect(colors.elevated).toBe(true);
  });

  it('Increase Contrast : bord RENFORCÉ (2 pt, encre pleine) — jamais un liseré pâle', () => {
    const colors = bobSurfaceColors({
      tone: 'warning',
      emphasis: 'flat',
      appearance: 'light',
      highContrast: true,
    });
    expect(colors.borderWidth).toBe(2);
    expect(colors.borderColor).toBe(surfaceTint.light.warning.ink);
  });

  it('reste opaque par construction (aucun canal alpha dans les valeurs résolues)', () => {
    for (const tone of ['neutral', 'marine', 'ai', 'success', 'warning', 'danger'] as const) {
      for (const emphasis of ['flat', 'raised', 'floating'] as const) {
        const colors = bobSurfaceColors({ tone, emphasis, appearance: 'light' });
        expect(colors.backgroundColor).toMatch(/^#[\da-f]{6}$/i);
        expect(colors.borderColor).toMatch(/^#[\da-f]{6}$/i);
      }
    }
  });
});
