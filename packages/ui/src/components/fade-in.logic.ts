/**
 * FadeIn/StaggeredList — la logique de l'apparition en cascade des sections (passe 18/07).
 * Doctrine : au PREMIER rendu du contenu (sortie de skeleton), les sections fondent en
 * entrant (opacité + 6 px de translation — transform, zéro layout shift), décalées de
 * 40 ms chacune, cap à 8 rangs (une longue liste ne doit jamais « pleuvoir » pendant
 * une demi-seconde). Reduced-motion : tout est instantané (durée 0, translation 0).
 */

/** Fondu d'une section (200-300 ms = petite transition, interaction-design §timing). */
export const FADE_IN_DURATION_MS = 240;
/** Translation d'entrée — assez pour donner la direction, jamais un saut. */
export const FADE_IN_TRANSLATE_PX = 6;
/** Décalage entre sections (fenêtre 30-50 ms de la cascade sobre). */
export const STAGGER_STEP_MS = 40;
/** Rang maximal décalé — au-delà, les sections partent ensemble (cascade bornée). */
export const STAGGER_MAX_STEPS = 8;

/** Délai d'un rang de cascade — borné à STAGGER_MAX_STEPS, jamais négatif. */
export function staggerDelayMs(index: number): number {
  const bounded = Math.min(Math.max(0, Math.trunc(index)), STAGGER_MAX_STEPS);
  return bounded * STAGGER_STEP_MS;
}

export interface FadeInMotion {
  readonly duration: number;
  readonly delay: number;
  readonly translate: number;
}

/** Le mouvement d'entrée d'un rang — reduced-motion : tout à zéro (apparition immédiate). */
export function resolveFadeInMotion(index: number, reduceMotion: boolean): FadeInMotion {
  if (reduceMotion) return { duration: 0, delay: 0, translate: 0 };
  return {
    duration: FADE_IN_DURATION_MS,
    delay: staggerDelayMs(index),
    translate: FADE_IN_TRANSLATE_PX,
  };
}
