/**
 * Primitives AUTH — logique PURE (vague hors-lots, audit 03/08).
 *
 * Quatre copies du même CTA blanc-sur-navy vivaient dans la famille auth avec TROIS
 * grammaires de feedback différentes (opacity .7 + texte « … » / .68 + ActivityIndicator /
 * .88 sans busy), et trois champs navy dupliqués. Ces fonctions figent LA grammaire unique :
 * · busy → opacité 0.7 + ActivityIndicator (jamais un texte « … » sur le chemin critique) ;
 * · press scale 0.97 GATÉ reduce-motion (fail-closed : préférence inconnue = pas de scale) ;
 * · bord de champ : dangerVivid en erreur (graphique ≥3:1 on-dark), white16 au repos.
 * Testées par mutants, sans React Native.
 */

/** Cible tactile du CTA (HIG / WCAG 2.2) et rayon commun de la famille auth. */
export const AUTH_CTA_MIN_HEIGHT = 52;
export const AUTH_FIELD_RADIUS = 15;
export const AUTH_CTA_PRESSED_SCALE = 0.97;
export const AUTH_CTA_BUSY_OPACITY = 0.7;

/** Échelle du CTA pressé — 1 (aucun mouvement) si busy OU si le mouvement est réduit/inconnu. */
export function authCtaPressedScale(
  pressed: boolean,
  busy: boolean,
  reduceMotion: boolean,
): number {
  if (!pressed || busy || reduceMotion) return 1;
  return AUTH_CTA_PRESSED_SCALE;
}

/** Opacité du CTA — le feedback busy reste PERCEPTIBLE même sans mouvement. */
export function authCtaOpacity(busy: boolean): number {
  return busy ? AUTH_CTA_BUSY_OPACITY : 1;
}

export interface AuthFieldBorderPalette {
  readonly danger: string;
  readonly idle: string;
}

/** Bord du champ navy — l'état d'erreur est GRAPHIQUE (le message, lui, parle en encre AA). */
export function authFieldBorderColor(error: boolean, palette: AuthFieldBorderPalette): string {
  return error ? palette.danger : palette.idle;
}
