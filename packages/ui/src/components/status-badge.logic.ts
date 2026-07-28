/**
 * StatusBadge / Chip — logique pure de mapping variante → tokens (redlines §7).
 * La palette est injectée depuis useTheme() ; réutilisée par avatar.tsx et icon-tile.tsx
 * (mêmes teintes pastel sémantiques).
 */

/** Les 5 variantes des redlines §7 + `warning` (état « à justifier », ambre doux)
 * + `neutral` (P1 §1.5 — états SORTIS du flux : Résilié, Annulée, Retirée, Échu). */
export type StatusBadgeVariant =
  | 'danger'
  | 'warning'
  | 'b2b'
  | 'b2g'
  | 'particulier'
  | 'success'
  | 'neutral';

/** Sous-ensemble de tokens nécessaires (injecté depuis useTheme). */
export interface StatusBadgePalette {
  /** semantic.danger — retard / impayé (fond = controls.dangerBadgeBg) */
  danger: string;
  dangerBadgeBg: string;
  /** P1 — état neutre sorti du flux (Retirée, Résilié…) : slate sur lineSoft. */
  neutralInk: string;
  neutralBg: string;
  /** semantic.warning — attention douce (payée à justifier, en attente) */
  warning: string;
  warningBg: string;
  /** semantic.b2b — devis accepté / B2B */
  b2b: string;
  b2bBg: string;
  /** semantic.b2g — e-facture / IA / B2G */
  b2g: string;
  b2gBg: string;
  /** semantic.particulier — particulier / échéance */
  particulier: string;
  particulierBg: string;
  /** semantic.success — payé / à jour */
  success: string;
  successBg: string;
}

export interface StatusBadgeColors {
  fg: string;
  bg: string;
}

/** Redlines §Fondations : fontSize 11 / 700 · padding 2/7 · radius 6. */
export const BADGE_FONT_SIZE = 11;
export const BADGE_FONT_WEIGHT = '700' as const;
export const BADGE_PADDING_VERTICAL = 2;
export const BADGE_PADDING_HORIZONTAL = 7;
export const BADGE_RADIUS = 6;

/** Chip filtre : hauteur 34 (hitSlop compense jusqu'à ≥ 44). */
export const CHIP_HEIGHT = 34;
export const CHIP_HIT_SLOP = Math.ceil((44 - CHIP_HEIGHT) / 2);

/** Mappe la variante → texte + fond pastel (redlines §7). Pure, testable sans RN. */
export function statusBadgeColors(
  variant: StatusBadgeVariant,
  p: StatusBadgePalette,
): StatusBadgeColors {
  switch (variant) {
    case 'danger':
      return { fg: p.danger, bg: p.dangerBadgeBg };
    case 'warning':
      return { fg: p.warning, bg: p.warningBg };
    case 'b2b':
      return { fg: p.b2b, bg: p.b2bBg };
    case 'b2g':
      return { fg: p.b2g, bg: p.b2gBg };
    case 'particulier':
      return { fg: p.particulier, bg: p.particulierBg };
    case 'success':
      return { fg: p.success, bg: p.successBg };
    case 'neutral':
      return { fg: p.neutralInk, bg: p.neutralBg };
  }
}

/** Sous-ensemble de tokens du Chip filtre (injecté depuis useTheme). */
export interface ChipPalette {
  /** theme.ink — fond actif */
  ink: string;
  /** neutrals.surface — fond inactif + texte actif */
  surface: string;
  /** neutrals.line — bord inactif */
  line: string;
  /** neutrals.slate500 — texte inactif */
  slate500: string;
}

export interface ChipColors {
  bg: string;
  border: string;
  fg: string;
}

/** Chip filtre : actif = fond ink du thème / texte surface ; inactif = surface + bord line. */
export function chipColors(active: boolean, p: ChipPalette): ChipColors {
  return active
    ? { bg: p.ink, border: p.ink, fg: p.surface }
    : { bg: p.surface, border: p.line, fg: p.slate500 };
}
