/**
 * StatusStrip — logique PURE (Lot 0) : chaque ton rend {fond pastel, encre foncée} et
 * chaque paire est certifiée AA petit texte ICI (formules WCAG identiques à index.test.ts
 * de @bob/tokens, ratios recalculés — littéraux vérifiés à la main en commentaire).
 */
import { describe, expect, it } from 'vitest';
import { neutrals, semantic, surfaceTint } from '@bob/tokens';
import {
  STATUS_STRIP_GAP,
  STATUS_STRIP_PADDING_HORIZONTAL,
  STATUS_STRIP_PADDING_VERTICAL,
  STATUS_STRIP_RADIUS,
  statusStripColors,
  type StatusStripPalette,
  type StatusStripTone,
} from './status-strip.logic';

const palette: StatusStripPalette = {
  successBg: semantic.successBg,
  successInk: semantic.successInk,
  warningBg: semantic.warningBg,
  warningInk: semantic.warningInk,
  dangerBg: semantic.dangerBg,
  dangerInk: surfaceTint.light.danger.ink,
  b2bBg: semantic.b2bBg,
  b2bInk: semantic.b2b,
  neutralBg: neutrals.lineSoft,
  neutralInk: neutrals.slate500,
};

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

describe('statusStripColors — encres foncées AA sur pastel', () => {
  it('épingle les 5 paires en littéraux', () => {
    expect(statusStripColors('success', palette)).toEqual({ bg: '#EAF2EC', ink: '#0E5C44' });
    expect(statusStripColors('warning', palette)).toEqual({ bg: '#FBF0DF', ink: '#8A5A12' });
    expect(statusStripColors('danger', palette)).toEqual({ bg: '#FBEAE8', ink: '#8F2F27' });
    expect(statusStripColors('b2b', palette)).toEqual({ bg: '#E6EDF6', ink: '#1B3A63' });
    expect(statusStripColors('neutral', palette)).toEqual({ bg: '#F1F4F7', ink: '#5B6B7B' });
  });

  it('certifie AA (≥ 4,5) CHAQUE encre sur son pastel — 6,99 / 5,25 / 6,93 / 9,72 / 4,96', () => {
    const tones: StatusStripTone[] = ['success', 'warning', 'danger', 'b2b', 'neutral'];
    for (const tone of tones) {
      const { bg, ink } = statusStripColors(tone, palette);
      expect(contrastRatio(ink, bg), `${tone} : ${ink} sur ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // Les ratios exacts, à la main : success 6.992 · warning 5.246 · danger 6.927 ·
    // b2b 9.721 · neutral 4.962 (mêmes formules que @bob/tokens index.test.ts).
    expect(Number(contrastRatio('#0E5C44', '#EAF2EC').toFixed(3))).toBe(6.992);
    expect(Number(contrastRatio('#8F2F27', '#FBEAE8').toFixed(3))).toBe(6.927);
  });

  it('la raison d’être des encres : les teintes NUES échouaient le petit texte', () => {
    // semantic.warning nu : 2.995 < 4.5 · semantic.danger nu : 4.102 < 4.5.
    expect(contrastRatio(semantic.warning, semantic.warningBg)).toBeLessThan(4.5);
    expect(contrastRatio(semantic.danger, semantic.dangerBg)).toBeLessThan(4.5);
  });

  it('géométrie figée du gabarit dominant : radius 10, paddings 9/12, gap 8', () => {
    expect(STATUS_STRIP_RADIUS).toBe(10);
    expect(STATUS_STRIP_PADDING_VERTICAL).toBe(9);
    expect(STATUS_STRIP_PADDING_HORIZONTAL).toBe(12);
    expect(STATUS_STRIP_GAP).toBe(8);
  });
});
