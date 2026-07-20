/**
 * PressableScale — la logique du press feedback STANDARD (passe états/feel 18/07).
 * Doctrine : tout élément interactif « surface » (tuile, ligne, carte) répond au doigt
 * par un enfoncement scale ~0.98 + légère baisse d'opacité, cible ≥ 44 pt. Les boutons
 * pleins gardent leur scale 0.94 instantané (button.logic) ; PressableScale couvre le reste.
 * Reduced-motion : transitions à durée 0 (le feedback reste, le mouvement disparaît) —
 * même règle que Sheet (use-reduce-motion.ts).
 */

/** Enfoncement standard d'une surface interactive (plus doux que le 0.94 des boutons pleins). */
export const PRESSABLE_SCALE_PRESSED = 0.98;
/** Baisse d'opacité pressée — perceptible sans éteindre le contenu. */
export const PRESSABLE_SCALE_OPACITY_PRESSED = 0.9;
/** Entrée rapide (le doigt vient de toucher — réponse immédiate). */
export const PRESSABLE_SCALE_IN_MS = 90;
/** Sortie légèrement plus longue (relâchement naturel, jamais sec). */
export const PRESSABLE_SCALE_OUT_MS = 150;
/** Cible tactile minimale (HIG/Material). */
export const PRESSABLE_SCALE_MIN_TARGET = 44;

export interface PressMotion {
  /** Cible du progrès animé : 1 = pressé, 0 = relâché. */
  readonly toValue: 0 | 1;
  readonly duration: number;
}

/** Durées du press feedback — reduced-motion : 0 (instantané, jamais coupé). */
export function resolvePressMotion(pressed: boolean, reduceMotion: boolean): PressMotion {
  if (reduceMotion) return { toValue: pressed ? 1 : 0, duration: 0 };
  return pressed
    ? { toValue: 1, duration: PRESSABLE_SCALE_IN_MS }
    : { toValue: 0, duration: PRESSABLE_SCALE_OUT_MS };
}
