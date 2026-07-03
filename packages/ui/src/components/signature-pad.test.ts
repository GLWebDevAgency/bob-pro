import { describe, it, expect } from 'vitest';
import {
  appendPoint,
  isSignatureEmpty,
  signatureToDataUrl,
  signatureToSvg,
  strokeToSvgPath,
  strokesToSvgPaths,
  SIGNATURE_MIN_DISTANCE,
  type Stroke,
} from './signature-pad.logic';

describe('signature-pad.logic (réserve C03 — flux devis C21)', () => {
  it('appendPoint filtre le bruit (< distance min) et arrondit à 0,1 px', () => {
    let stroke: Stroke = [];
    stroke = appendPoint(stroke, { x: 10.123, y: 20.987 });
    expect(stroke).toEqual([{ x: 10.1, y: 21 }]);
    // Point trop proche (< SIGNATURE_MIN_DISTANCE) : ignoré, référence inchangée.
    const same = appendPoint(stroke, { x: 10.1 + SIGNATURE_MIN_DISTANCE / 2, y: 21 });
    expect(same).toBe(stroke);
    // Point assez loin : retenu.
    stroke = appendPoint(stroke, { x: 14, y: 21 });
    expect(stroke).toHaveLength(2);
  });

  it('strokeToSvgPath : point isolé = point d’encre, 2 points = segment, 3+ = lissage Q par points-milieux', () => {
    expect(strokeToSvgPath([])).toBe('');
    expect(strokeToSvgPath([{ x: 5, y: 6 }])).toBe('M 5 6 l 0.1 0');
    expect(strokeToSvgPath([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe('M 0 0 L 10 0');
    // 3 points : une courbe Q vers le milieu (5,5)→(10,10) = (7.5,7.5), puis L vers le dernier.
    expect(
      strokeToSvgPath([
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 10 },
      ]),
    ).toBe('M 0 0 Q 5 5 7.5 7.5 L 10 10');
  });

  it('vide ↔ non-vide : isSignatureEmpty pilote le dataURL (null tant que rien n’est tracé)', () => {
    const options = { width: 300, height: 160, strokeColor: 'ink' };
    expect(isSignatureEmpty([])).toBe(true);
    expect(isSignatureEmpty([[]])).toBe(true);
    expect(signatureToDataUrl([], options)).toBeNull();
    const strokes: Stroke[] = [[{ x: 1, y: 2 }, { x: 9, y: 4 }]];
    expect(isSignatureEmpty(strokes)).toBe(false);
    const url = signatureToDataUrl(strokes, options);
    expect(url).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(decodeURIComponent(url ?? '')).toContain('stroke="ink"');
  });

  it('signatureToSvg : document auto-porté (viewBox = zone), couleur/épaisseur injectées, tracés vides ignorés', () => {
    const svg = signatureToSvg([[{ x: 1, y: 2 }, { x: 9, y: 4 }], []], {
      width: 320,
      height: 128,
      strokeColor: 'encre-du-theme',
      strokeWidth: 3,
    });
    expect(svg).toContain('viewBox="0 0 320 128"');
    expect(svg).toContain('stroke="encre-du-theme"');
    expect(svg).toContain('stroke-width="3"');
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(strokesToSvgPaths([[], [{ x: 0, y: 0 }]])).toHaveLength(1);
  });
});
