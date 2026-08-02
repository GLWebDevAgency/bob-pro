/**
 * BottomTabBar — raffinements STATIQUES portés de la barre PORTÉE vers la barre LIVRÉE
 * (Lot 1, plan DA 01/08, arbitrage « BARRE LIVRÉE vs PORTÉE (PERF-13) »).
 *
 * BORNES STRICTES : uniquement la géométrie AU REPOS et la teinte déjà VALIDÉES par
 * `bob-tab-bar.logic` (constantes du socle + palette certifiée AA sur la course) — rien
 * d'animé, rien de comportemental, rien de mesuré. Tout ce qui bouge (repli, highlight,
 * scrub, retombée) reste derrière le flag `mobile_tabs_experiment_v1` : moins l'ON/OFF
 * diffère cosmétiquement, plus PERF-13 mesure les comportements et non le maquillage.
 *
 * AUCUN nombre n'est inventé ici : chaque valeur est IMPORTÉE ou DÉRIVÉE des grandeurs de
 * `bob-tab-bar.logic` (la géométrie normative du socle, à `progress = 0`) :
 *   hauteurPressable = max(CIBLE plateforme, visuel étendu 50)  → 50 sur les DEUX OS
 *   boîte intérieure = pressable + 2 × rythme extérieur (4)     → 58
 *   rectangle mesuré = boîte + 2 × bordure (1)                  → 60
 *   borderRadius     = rectangle mesuré / 2                     → 30 (pilule pleinement ronde)
 *   padding H rangée = TAB_BAR_ROW_PAD_H                        → 4
 *   bordure          = palette validée (`tabTintPalette`)       → neutral.border
 */
import type { SurfaceTintAppearance } from '@bob/tokens';
import {
  TAB_BAR_BORDER_WIDTH,
  TAB_BAR_EXPANDED_VISUAL,
  TAB_BAR_OUTER_RHYTHM,
  TAB_BAR_ROW_PAD_H,
  tabTintPalette,
  touchTargetFloor,
  type TabBarPlatform,
} from './bob-tab-bar.logic';

export interface DeliveredPillStatics {
  /** Hauteur minimale du Pressable d'onglet : max(CIBLE plateforme, visuel étendu). */
  readonly pressableMinHeight: number;
  /** Rythme extérieur au repos (paddingVertical de la pilule). */
  readonly paddingVertical: number;
  /** Retrait intérieur entre la paroi et les onglets (paddingHorizontal). */
  readonly paddingHorizontal: number;
  readonly borderWidth: number;
  /** Pleinement ronde : rectangle MESURÉ / 2 — la formule du socle, pas une constante. */
  readonly borderRadius: number;
  /** Bordure de la palette validée AA (`tabTintPalette(appearance).border`). */
  readonly borderColor: string;
}

export function deliveredPillStatics(
  platform: TabBarPlatform,
  appearance: SurfaceTintAppearance,
): DeliveredPillStatics {
  const pressableMinHeight = Math.max(touchTargetFloor(platform), TAB_BAR_EXPANDED_VISUAL);
  const pillMeasuredHeight =
    pressableMinHeight + 2 * TAB_BAR_OUTER_RHYTHM + 2 * TAB_BAR_BORDER_WIDTH;
  return Object.freeze({
    pressableMinHeight,
    paddingVertical: TAB_BAR_OUTER_RHYTHM,
    paddingHorizontal: TAB_BAR_ROW_PAD_H,
    borderWidth: TAB_BAR_BORDER_WIDTH,
    borderRadius: pillMeasuredHeight / 2,
    borderColor: tabTintPalette(appearance).border,
  });
}
