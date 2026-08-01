/**
 * Toast — logique PURE des tones (Lot 0, plan DA 01/08 — arbitrage GRAMMAIRE D'ERREUR :
 * « Toast tone success/danger = feedback éphémère NON actionnable »). Le fond du toast
 * RESTE l'aplat ink du thème (signature) ; le tone choisit le GLYPHE par défaut et sa
 * teinte on-dark quand l'appelant n'injecte pas d'icône — c'est ce qui met fin à la
 * coche verte sur un échec (comptabilite, depenses) : tone 'danger' dessine une croix.
 */

export type ToastTone = 'success' | 'danger';

export interface ToastTonePalette {
  /** semantic.successOnDark — vert lisible sur les 4 inks de thème (≥ 7,4:1 mesuré). */
  successOnDark: string;
  /** surfaceTint.dark.danger.ink — l'encre danger ON-DARK certifiée du kit matière
   *  (≥ 8:1 sur les 4 inks de thème ; dangerVivid échouait le 3:1 sur l'ink forêt). */
  dangerOnDark: string;
}

export interface ToastToneAccent {
  glyph: 'check' | 'cross';
  color: string;
}

/**
 * Accent du tone — `undefined` sans tone (toast historique : aucun glyphe dessiné,
 * l'icône reste entièrement à l'appelant ; arbre STRICTEMENT inchangé).
 */
export function toastToneAccent(
  tone: ToastTone | undefined,
  palette: ToastTonePalette,
): ToastToneAccent | undefined {
  if (tone === undefined) return undefined;
  return tone === 'success'
    ? { glyph: 'check', color: palette.successOnDark }
    : { glyph: 'cross', color: palette.dangerOnDark };
}
