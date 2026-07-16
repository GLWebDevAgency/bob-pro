import { describe, expect, it } from 'vitest';
import {
  deriveGlobalBobCollapsedContentInset,
  deriveGlobalBobAccessHorizontalLayout,
  deriveGlobalBobAccessVerticalLayout,
  deriveIosKeyboardViewportOverlap,
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

describe('GlobalBobAccess — placement vertical canonique', () => {
  it('respecte la safe-area hors tabs sans clavier', () => {
    expect(deriveGlobalBobAccessVerticalLayout({
      inTabs: false,
      safeAreaBottom: 34,
      tabPaddingTop: 0,
      tabMinimumBottom: 0,
      bottomAvoidance: 0,
      keyboardOverlap: 0,
    })).toEqual({ bottom: 52 });
  });

  it('reste au-dessus de la tab bar flottante', () => {
    expect(deriveGlobalBobAccessVerticalLayout({
      inTabs: true,
      safeAreaBottom: 34,
      tabPaddingTop: 12,
      tabMinimumBottom: 26,
      bottomAvoidance: 0,
      keyboardOverlap: 0,
    })).toEqual({ bottom: 116 });
  });

  it('prend le maximum du clavier iOS et du chrome, sans double addition', () => {
    expect(deriveGlobalBobAccessVerticalLayout({
      inTabs: true,
      safeAreaBottom: 34,
      tabPaddingTop: 12,
      tabMinimumBottom: 26,
      bottomAvoidance: 24,
      keyboardOverlap: 291,
    })).toEqual({ bottom: 333 });
  });

  it('borne les métriques natives invalides', () => {
    expect(deriveGlobalBobAccessVerticalLayout({
      inTabs: false,
      safeAreaBottom: Number.NaN,
      tabPaddingTop: Number.POSITIVE_INFINITY,
      tabMinimumBottom: -4,
      bottomAvoidance: -10,
      keyboardOverlap: Number.NaN,
    })).toEqual({ bottom: GLOBAL_BOB_ACCESS_EDGE_GAP });
  });
});

describe('GlobalBobAccess — réserve de contenu', () => {
  it('réserve exactement l’orbe, son hitSlop et l’air visuel', () => {
    expect(deriveGlobalBobCollapsedContentInset({
      bobBottom: 104,
      viewportBottomInset: 0,
      keyboardViewportInset: 0,
      minimumBottom: 140,
    })).toEqual({ paddingBottom: 170, scrollIndicatorBottom: 170 });
    expect(deriveGlobalBobCollapsedContentInset({
      bobBottom: 112,
      viewportBottomInset: 0,
      keyboardViewportInset: 0,
      minimumBottom: 140,
    })).toEqual({ paddingBottom: 178, scrollIndicatorBottom: 178 });
    expect(deriveGlobalBobCollapsedContentInset({
      bobBottom: 52,
      viewportBottomInset: 0,
      keyboardViewportInset: 0,
      minimumBottom: 0,
    })).toEqual({ paddingBottom: 118, scrollIndicatorBottom: 118 });
  });

  it('ne compte deux fois ni footer ni clavier déjà sortis du viewport', () => {
    expect(deriveGlobalBobCollapsedContentInset({
      bobBottom: 204,
      viewportBottomInset: 86,
      keyboardViewportInset: 0,
      minimumBottom: 40,
    })).toEqual({ paddingBottom: 184, scrollIndicatorBottom: 184 });
    expect(deriveGlobalBobCollapsedContentInset({
      bobBottom: 343,
      viewportBottomInset: 0,
      keyboardViewportInset: 291,
      minimumBottom: 40,
    })).toEqual({ paddingBottom: 118, scrollIndicatorBottom: 118 });
  });

  it('borne les métriques invalides et conserve le minimum produit', () => {
    expect(deriveGlobalBobCollapsedContentInset({
      bobBottom: Number.NaN,
      viewportBottomInset: -8,
      keyboardViewportInset: Number.POSITIVE_INFINITY,
      minimumBottom: 24,
    })).toEqual({ paddingBottom: 66, scrollIndicatorBottom: 66 });
  });
});

describe('GlobalBobAccess — clavier iOS', () => {
  it('retient un clavier docké et ignore un clavier flottant', () => {
    expect(deriveIosKeyboardViewportOverlap({
      windowWidth: 390,
      windowHeight: 844,
      frameWidth: 390,
      frameHeight: 291,
    })).toBe(291);
    expect(deriveIosKeyboardViewportOverlap({
      windowWidth: 1024,
      windowHeight: 768,
      frameWidth: 360,
      frameHeight: 260,
    })).toBe(0);
  });

  it('borne un frame natif hostile à la fenêtre courante', () => {
    expect(deriveIosKeyboardViewportOverlap({
      windowWidth: 390,
      windowHeight: 500,
      frameWidth: 390,
      frameHeight: 900,
    })).toBe(500);
  });
});
