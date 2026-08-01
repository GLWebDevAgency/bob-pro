/**
 * StickyActionBar — logique PURE des 2 variantes (Lot 0, plan DA 01/08, arbitrage STICKY
 * BARS : « fusion StickyCtaBar/StickyActionBar — UNE StickyActionBar à 2 variantes »).
 *  · 'bar'      — barre ANCRÉE au layout (fin d'écran de wizard) : surface + borderTop
 *                 lineSoft, slots montant/CTA. Géométrie de facture/new (18 / 10 / +12).
 *  · 'floating' — pilule ABSOLUE au-dessus du contenu : aplat ink du thème + ombre e3 +
 *                 liseré accent sémantique (le fil rouge « couleur de l'argent » de
 *                 client/[id]) + apparition FadeIn fail-closed. Géométrie de client/[id]
 *                 (left/right 18, bottom +14, pilule 52/16, pressed 0.98).
 */
import type { ViewStyle } from 'react-native';

export type StickyActionBarVariant = 'bar' | 'floating';

/** Géométrie figée de la variante 'bar' (littéraux de facture/new, la référence du plan). */
export const STICKY_BAR_PADDING_HORIZONTAL = 18;
export const STICKY_BAR_PADDING_TOP = 10;
export const STICKY_BAR_PADDING_BOTTOM_EXTRA = 12;

/** Géométrie figée de la variante 'floating' (littéraux de client/[id]). */
export const STICKY_FLOATING_SIDE_INSET = 18;
export const STICKY_FLOATING_BOTTOM_EXTRA = 14;
export const STICKY_FLOATING_MIN_HEIGHT = 52;
export const STICKY_FLOATING_RADIUS = 16;
export const STICKY_FLOATING_PRESSED_SCALE = 0.98;
/** Épaisseur du liseré accent (le trait « souligné » du standing). */
export const STICKY_FLOATING_ACCENT_WIDTH = 3;

export interface StickyBarPalette {
  /** neutrals.surface — fond de la barre ancrée. */
  surface: string;
  /** neutrals.lineSoft — filet supérieur de la barre ancrée. */
  lineSoft: string;
}

/** Conteneur de la variante 'bar' — ancré au layout, jamais absolu. */
export function stickyBarContainerStyle(insetsBottom: number, palette: StickyBarPalette): ViewStyle {
  return {
    paddingHorizontal: STICKY_BAR_PADDING_HORIZONTAL,
    paddingTop: STICKY_BAR_PADDING_TOP,
    paddingBottom: insetsBottom + STICKY_BAR_PADDING_BOTTOM_EXTRA,
    borderTopWidth: 1,
    borderTopColor: palette.lineSoft,
    backgroundColor: palette.surface,
  };
}

/** Conteneur de la variante 'floating' — absolu, au-dessus du contenu qui défile. */
export function stickyFloatingContainerStyle(insetsBottom: number): ViewStyle {
  return {
    position: 'absolute',
    left: STICKY_FLOATING_SIDE_INSET,
    right: STICKY_FLOATING_SIDE_INSET,
    bottom: insetsBottom + STICKY_FLOATING_BOTTOM_EXTRA,
  };
}

export interface StickyFloatingPillInput {
  readonly pressed: boolean;
  /** theme.ink — l'aplat signature. */
  readonly ink: string;
  /** Liseré accent sémantique (teinte du standing) — absent : aucun liseré rendu. */
  readonly accentColor?: string | undefined;
}

/**
 * Pilule de la variante 'floating' — aplat ink, radius 16, cible ≥ 52, pressed 0.98 ;
 * le liseré accent est un TRAIT BAS de 3 (le « souligné » du fil rouge), jamais un cadre.
 */
export function stickyFloatingPillStyle(input: StickyFloatingPillInput): ViewStyle {
  return {
    backgroundColor: input.ink,
    borderRadius: STICKY_FLOATING_RADIUS,
    minHeight: STICKY_FLOATING_MIN_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 18,
    ...(input.accentColor !== undefined
      ? {
          borderBottomWidth: STICKY_FLOATING_ACCENT_WIDTH,
          borderBottomColor: input.accentColor,
        }
      : {}),
    ...(input.pressed ? { transform: [{ scale: STICKY_FLOATING_PRESSED_SCALE }] } : {}),
  };
}
