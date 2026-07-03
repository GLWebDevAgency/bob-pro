/**
 * Button — logique pure de mapping variante → tokens (redlines §18).
 * Aucune couleur en dur : la palette est injectée depuis useTheme() par button.tsx.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ai' | 'danger';

/** Sous-ensemble de tokens nécessaires au bouton (injecté depuis useTheme). */
export interface ButtonPalette {
  /** neutrals.surface — texte sur fond sombre */
  surface: string;
  /** neutrals.ink600 — texte du bouton secondaire */
  ink600: string;
  /** neutrals.slate300 — texte du bouton désactivé */
  slate300: string;
  /** semantic.danger — texte + bord du bouton danger */
  danger: string;
  /** semantic.ai — fond du bouton IA */
  ai: string;
  /** controls.segmentedTrack — fond du bouton désactivé */
  segmentedTrack: string;
  /** controls.buttonSecondaryBorder — bord du bouton secondaire */
  buttonSecondaryBorder: string;
}

export interface ButtonAppearance {
  /** true → le fond est le dégradé `cta` du thème (primaire actif). */
  gradient: boolean;
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  textColor: string;
}

/** Hauteur minimale — hit-target terrain-first (redlines §18 : ≥ 44). */
export const BUTTON_MIN_HEIGHT = 48;
/** CTA compact des cartes priorité (réf dc.html) : padding 9/15, texte 13.5/600.
 *  La cible tactile ≥ 44 est garantie par hitSlop côté composant. */
export const BUTTON_COMPACT_PADDING_VERTICAL = 9;
export const BUTTON_COMPACT_PADDING_HORIZONTAL = 15;
export const BUTTON_COMPACT_FONT_SIZE = 13.5;
export const BUTTON_COMPACT_HIT_SLOP = 6;
/** Écart icône ↔ libellé (redlines §18). */
export const BUTTON_ICON_GAP = 7;
/** Échelle au press (redlines §18 : scale 0.94). */
export const BUTTON_PRESSED_SCALE = 0.94;
/** Bornes de radius autorisées par les redlines §18 (11–15). */
export const BUTTON_RADIUS_MIN = 11;
export const BUTTON_RADIUS_MAX = 15;
export const BUTTON_RADIUS_DEFAULT = 13;

/** Contraint le radius aux bornes des redlines §18. */
export function clampButtonRadius(radius?: number): number {
  if (radius === undefined) return BUTTON_RADIUS_DEFAULT;
  return Math.min(BUTTON_RADIUS_MAX, Math.max(BUTTON_RADIUS_MIN, radius));
}

/** Mappe (variante, désactivé) → couleurs du §18. Fonction pure, testable sans RN. */
export function resolveButtonAppearance(
  variant: ButtonVariant,
  disabled: boolean,
  p: ButtonPalette,
): ButtonAppearance {
  if (disabled) {
    return {
      gradient: false,
      backgroundColor: p.segmentedTrack,
      borderColor: 'transparent',
      borderWidth: 0,
      textColor: p.slate300,
    };
  }
  switch (variant) {
    case 'primary':
      // Fond réel = dégradé `cta` du thème, rendu par le composant.
      return {
        gradient: true,
        backgroundColor: 'transparent',
        borderColor: 'transparent',
        borderWidth: 0,
        textColor: p.surface,
      };
    case 'secondary':
      return {
        gradient: false,
        backgroundColor: p.surface,
        borderColor: p.buttonSecondaryBorder,
        borderWidth: 1,
        textColor: p.ink600,
      };
    case 'ai':
      return {
        gradient: false,
        backgroundColor: p.ai,
        borderColor: 'transparent',
        borderWidth: 0,
        textColor: p.surface,
      };
    case 'danger':
      return {
        gradient: false,
        backgroundColor: 'transparent',
        borderColor: p.danger,
        borderWidth: 1,
        textColor: p.danger,
      };
  }
}
