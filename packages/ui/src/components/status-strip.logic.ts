/**
 * StatusStrip — logique PURE (Lot 0, plan DA 01/08) : bandeau d'état « icône + fond
 * sémantique pastel + ENCRE FONCÉE AA » qui résorbe 6 duplications (PieceDetailView
 * deposit/progress/paidDone, facture/[id] ×3, transmission ×2). Chaque ton rend une paire
 * {fond pastel, encre} certifiée AA petit texte (status-strip.test) — c'est la raison
 * d'être des encres warningInk/successInk du lot : semantic.warning nu (2,99:1) et
 * semantic.danger nu (4,10:1) ne passaient pas le petit texte sur leur pastel.
 */

export type StatusStripTone = 'success' | 'warning' | 'danger' | 'b2b' | 'neutral';

/** Sous-ensemble de tokens nécessaires (injecté depuis useTheme + surfaceTint). */
export interface StatusStripPalette {
  /** semantic.successBg / semantic.successInk (6,99:1). */
  successBg: string;
  successInk: string;
  /** semantic.warningBg / semantic.warningInk (5,25:1 — patron creditInk). */
  warningBg: string;
  warningInk: string;
  /** semantic.dangerBg / surfaceTint.light.danger.ink (6,93:1). */
  dangerBg: string;
  dangerInk: string;
  /** semantic.b2bBg / semantic.b2b (9,72:1 — déjà une encre foncée). */
  b2bBg: string;
  b2bInk: string;
  /** neutrals.lineSoft / neutrals.slate500 (4,96:1). */
  neutralBg: string;
  neutralInk: string;
}

export interface StatusStripColors {
  bg: string;
  ink: string;
}

/** Géométrie figée (le gabarit dominant des 6 duplications : radius 10, 9/12, gap 8). */
export const STATUS_STRIP_RADIUS = 10;
export const STATUS_STRIP_PADDING_VERTICAL = 9;
export const STATUS_STRIP_PADDING_HORIZONTAL = 12;
export const STATUS_STRIP_GAP = 8;

/** Mappe le ton → {fond pastel, encre foncée AA}. Pure, testable sans RN. */
export function statusStripColors(tone: StatusStripTone, p: StatusStripPalette): StatusStripColors {
  switch (tone) {
    case 'success':
      return { bg: p.successBg, ink: p.successInk };
    case 'warning':
      return { bg: p.warningBg, ink: p.warningInk };
    case 'danger':
      return { bg: p.dangerBg, ink: p.dangerInk };
    case 'b2b':
      return { bg: p.b2bBg, ink: p.b2bInk };
    case 'neutral':
      return { bg: p.neutralBg, ink: p.neutralInk };
  }
}
