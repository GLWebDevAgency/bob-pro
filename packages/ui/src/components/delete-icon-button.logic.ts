/**
 * DeleteIconButton — logique pure de dimensionnement (composant corbeille canonique @bob/ui).
 * Cible tactile ≥ 44 pt NON NÉGOCIABLE (exigence accessibilité fondateur) : le composant
 * l'applique STRUCTURELLEMENT, même si un appelant tente une taille plus petite — jamais un
 * bouton corbeille sous le plancher d'accessibilité, nulle part dans l'app.
 */

/** Plancher d'accessibilité (redlines : toute cible tactile ≥ 44). */
export const DELETE_ICON_BUTTON_MIN_HIT_TARGET = 44;
/** Défaut : mêmes proportions que les corbeilles déjà en prod (DocumentActions 52/16,
 *  carte brouillon devis 40/12 — ratio radius/taille ≈ 0,3), ramenées au plancher 44 pt. */
export const DELETE_ICON_BUTTON_SIZE_DEFAULT = 44;
export const DELETE_ICON_BUTTON_RADIUS_DEFAULT = 14;
export const DELETE_ICON_BUTTON_HIT_SLOP_DEFAULT = 4;

/** Contraint la taille du bouton à la cible tactile minimale (44 pt) — jamais en-deçà. */
export function clampDeleteIconButtonSize(size?: number): number {
  if (size === undefined) return DELETE_ICON_BUTTON_SIZE_DEFAULT;
  return Math.max(DELETE_ICON_BUTTON_MIN_HIT_TARGET, size);
}

/** Même règle d'opacité que les corbeilles existantes (DocumentActions/carte brouillon) :
 *  0,5 dès que désactivé OU en cours (spinner). */
export function deleteIconButtonOpacity(disabled: boolean, loading: boolean): number {
  return disabled || loading ? 0.5 : 1;
}
