/**
 * StickyBackRow — logique PURE (Lot 0, plan DA 01/08). La rangée retour STICKY du haut
 * des écrans de pilotage (pilotage, comptabilite, cloture, depenses, recherche — Lot 5) :
 * fond `patterns.bottomTabBar.fade[1]` (le voile .92 déjà livré par la tab bar), cible
 * tactile ≥ 44 pt (les rangées ad hoc plafonnaient à 34), voile de dissolution OPTIONNEL
 * (HeaderVeil variant 'stickyBackRow' — le MÊME mécanisme que les headers).
 */
import type { ViewStyle } from 'react-native';
import { patterns } from '@bob/tokens';

/** Cible tactile minimale du bouton retour (HIG / WCAG 2.2 : ≥ 44 pt — était 34 ad hoc). */
export const STICKY_BACK_ROW_MIN_TARGET = 44;
/** Géométrie figée de la rangée (littéraux des 5 écrans consommateurs, pilotage en tête). */
export const STICKY_BACK_ROW_TOP_EXTRA = 10;
export const STICKY_BACK_ROW_PADDING_HORIZONTAL = 16;
export const STICKY_BACK_ROW_PADDING_BOTTOM = 8;

/** Conteneur de la rangée — fond = le stop .92 du fondu canvas (patterns.bottomTabBar.fade[1]). */
export function stickyBackRowContainerStyle(insetsTop: number): ViewStyle {
  return {
    paddingTop: insetsTop + STICKY_BACK_ROW_TOP_EXTRA,
    paddingHorizontal: STICKY_BACK_ROW_PADDING_HORIZONTAL,
    paddingBottom: STICKY_BACK_ROW_PADDING_BOTTOM,
    backgroundColor: patterns.bottomTabBar.fade[1],
  };
}
