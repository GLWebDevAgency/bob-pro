/**
 * PhotoViewer — logique PURE (Lot 4, plan DA 01/08). Le fade d'ouverture de la visionneuse
 * est gaté reduce-motion FAIL-CLOSED : préférence non résolue ou réduite ⇒ Modal
 * animationType 'none' (critère de preuve Lot 4 : « visionneuse sans fade »).
 */
export type PhotoViewerAnimation = 'none' | 'fade';

/** `reduceMotion` vient de useReduceMotion (fail-closed : unknown ⇒ true ⇒ 'none'). */
export function photoViewerAnimationType(reduceMotion: boolean): PhotoViewerAnimation {
  return reduceMotion ? 'none' : 'fade';
}
