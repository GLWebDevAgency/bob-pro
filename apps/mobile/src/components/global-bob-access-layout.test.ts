import { describe, expect, it } from 'vitest';
import {
  deriveGlobalBobAccessHorizontalLayout,
  GLOBAL_BOB_ACCESS_EDGE_GAP,
  GLOBAL_BOB_ACCESS_MAX_CARD_WIDTH,
} from './global-bob-access-layout';

describe('GlobalBobAccess — placement horizontal canonique', () => {
  it('reste toujours en bas à gauche avec un espace après la safe-area', () => {
    expect(deriveGlobalBobAccessHorizontalLayout({
      windowWidth: 390,
      safeAreaLeft: 0,
      safeAreaRight: 0,
    })).toEqual({
      left: GLOBAL_BOB_ACCESS_EDGE_GAP,
      maxCardWidth: GLOBAL_BOB_ACCESS_MAX_CARD_WIDTH,
    });

    expect(deriveGlobalBobAccessHorizontalLayout({
      windowWidth: 844,
      safeAreaLeft: 47,
      safeAreaRight: 47,
    }).left).toBe(47 + GLOBAL_BOB_ACCESS_EDGE_GAP);
  });

  it('borne la carte à la largeur réellement disponible sur un petit écran', () => {
    expect(deriveGlobalBobAccessHorizontalLayout({
      windowWidth: 320,
      safeAreaLeft: 0,
      safeAreaRight: 0,
    }).maxCardWidth).toBe(320 - (GLOBAL_BOB_ACCESS_EDGE_GAP * 2));
  });

  it('neutralise des insets natifs invalides au lieu de déplacer Bob hors écran', () => {
    expect(deriveGlobalBobAccessHorizontalLayout({
      windowWidth: Number.NaN,
      safeAreaLeft: -12,
      safeAreaRight: Number.POSITIVE_INFINITY,
    })).toEqual({ left: GLOBAL_BOB_ACCESS_EDGE_GAP, maxCardWidth: 0 });
  });
});
