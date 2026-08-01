/**
 * toastToneAccent — logique PURE des tones du Toast (Lot 0, grammaire d'erreur).
 * Littéraux : successOnDark #6EE7B7 (semantic), dangerOnDark #FADDD9
 * (surfaceTint.dark.danger.ink — ≥ 8:1 mesuré sur les 4 inks de thème, là où
 * dangerVivid #E5544B échouait le 3:1 sur l'ink forêt #0C4A37 : 2,78).
 */
import { describe, expect, it } from 'vitest';
import { semantic, surfaceTint } from '@bob/tokens';
import { toastToneAccent, type ToastTonePalette } from './toast.logic';

const palette: ToastTonePalette = {
  successOnDark: semantic.successOnDark,
  dangerOnDark: surfaceTint.dark.danger.ink,
};

describe('toastToneAccent', () => {
  it('sans tone → undefined : le toast historique ne dessine RIEN (arbre inchangé)', () => {
    expect(toastToneAccent(undefined, palette)).toBeUndefined();
  });

  it('success → coche successOnDark (#6EE7B7)', () => {
    expect(toastToneAccent('success', palette)).toEqual({ glyph: 'check', color: '#6EE7B7' });
  });

  it('danger → CROIX (jamais une coche sur un échec) en encre danger on-dark (#FADDD9)', () => {
    expect(toastToneAccent('danger', palette)).toEqual({ glyph: 'cross', color: '#FADDD9' });
  });
});
