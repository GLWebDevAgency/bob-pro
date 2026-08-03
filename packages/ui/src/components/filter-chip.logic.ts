/**
 * FilterChip — logique PURE (Lot 3, plan DA 01/08 « 1er commit du lot ») : chip de filtre
 * ACTIF supprimable (croix) qui résorbe le motif dupliqué ActiveFilterChip/DateRangeChips/
 * chips d'autocomplete. ARBITRAGE SÉLECTION : la sélection utilisateur parle theme.ink
 * (fond teinté ~9 %, bord ink) — l'indigo redevient le canal EXCLUSIF de Bob, le vert
 * reste la récompense du geste commis.
 */
import { mixTint } from './bob-tab-bar.logic';

/** Sous-ensemble de tokens nécessaires (injecté depuis useTheme). */
export interface FilterChipPalette {
  /** theme.ink — bord et encre du filtre actif. */
  ink: string;
  /** neutrals.surface — base du fond teinté. */
  surface: string;
  /** neutrals.line — bord inactif. */
  line: string;
  /** neutrals.slate500 — encre inactive. */
  slate500: string;
}

export interface FilterChipColors {
  bg: string;
  border: string;
  fg: string;
}

/** Géométrie figée (gabarit de l'ActiveFilterChip historique : hauteur 30, croix 18). */
export const FILTER_CHIP_HEIGHT = 30;
export const FILTER_CHIP_REMOVE_DIAMETER = 18;
/** Part de teinte ink du fond actif — « fond teinté 8-10 % » de l'arbitrage sélection. */
export const FILTER_CHIP_TINT_SHARE = 0.09;
/** hitSlop de la croix : 18 + 2×13 = 44 — la cible reste ≥ 44 pt (gants du chantier). */
export const FILTER_CHIP_REMOVE_HIT_SLOP = Math.ceil(
  (44 - FILTER_CHIP_REMOVE_DIAMETER) / 2,
);
/** hitSlop vertical du corps : 30 + 2×7 = 44. */
export const FILTER_CHIP_HIT_SLOP = Math.ceil((44 - FILTER_CHIP_HEIGHT) / 2);

/** Actif = bord ink + fond teinté ~9 % + encre ink ; inactif = bord line + encre slate500. */
export function filterChipColors(active: boolean, p: FilterChipPalette): FilterChipColors {
  return active
    ? { bg: mixTint(p.surface, p.ink, FILTER_CHIP_TINT_SHARE), border: p.ink, fg: p.ink }
    : { bg: p.surface, border: p.line, fg: p.slate500 };
}
