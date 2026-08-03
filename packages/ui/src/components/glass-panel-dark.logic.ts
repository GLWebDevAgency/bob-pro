/**
 * GlassPanelDark — logique PURE (Lot 5, plan DA 01/08) : la matière « verre sombre »
 * vivait en TRIPLE copie dans diagnostic.tsx (constats de l'audit, 3 axes, plan d'action).
 * Une seule recette : fond overlays.white07, bord 1 white10, radius 18 — sur les fonds
 * indigo/navy profonds uniquement (les surfaces claires ont Card).
 */
import type { ViewStyle } from 'react-native';
import { overlays } from '@bob/tokens';

export const GLASS_PANEL_DARK_RADIUS = 18;

/** Recette figée du panneau — pure, testable en littéraux (mutants sur chaque façade). */
export function glassPanelDarkStyle(): ViewStyle {
  return {
    backgroundColor: overlays.white07,
    borderWidth: 1,
    borderColor: overlays.white10,
    borderRadius: GLASS_PANEL_DARK_RADIUS,
  };
}
