/**
 * HeaderVeil — logique PURE des variantes du voile de header (Lot 0, plan DA 01/08,
 * arbitrage HEADERS : « le voile ProgressiveBlurBob est UN mécanisme kit unique monté en
 * variantes sur AppHeaderNavy, InnerScreenHeader et StickyBackRow »).
 *
 * Le MÉCANISME (bandes + lavis + voile, port injecté, fail-closed intégral) est
 * ProgressiveBlurBob — ce fichier n'ajoute AUCUNE mécanique : il fige les PRÉRÉGLAGES
 * par point de montée, pour que les trois montées (Lots 1 et 5) ne re-négocient ni
 * l'ancrage ni le ton ni la hauteur.
 */
import { patterns, type SurfaceVeilTone } from '@bob/tokens';

/** Les trois points de montée arbitrés par le plan. */
export type HeaderVeilVariant = 'appHeaderNavy' | 'innerScreenHeader' | 'stickyBackRow';

export interface HeaderVeilPreset {
  /** Chrome HAUT dans les trois variantes : la retombée s'ancre au bord supérieur. */
  readonly anchor: 'top';
  /** Ton du voile ET du lavis (famille surfaceVeil). */
  readonly tone: SurfaceVeilTone;
  /** Hauteur d'enveloppe par défaut — le débord du contrat (patterns.edgeFalloff.bleed). */
  readonly height: number;
}

/**
 * Hauteur par défaut = le débord au-dessus du chrome du contrat de retombée (44 dp).
 * Une montée peut la surcharger via la prop `height` (géométrie mesurée du header).
 */
export const DEFAULT_HEADER_VEIL_HEIGHT: number = patterns.edgeFalloff.bleed;

/**
 * Préréglage d'une variante — PURE, testée par mutants :
 *  · innerScreenHeader / stickyBackRow : ton `canvas` — le fond d'app, la MÊME recette de
 *    fondu que la tab bar livrée (surfaceVeil.canvas ≡ patterns.bottomTabBar.fade) ;
 *  · appHeaderNavy : ton `marine` — la famille de surface marine ; la matière EXACTE du
 *    pied navy (rampe d1/d2/d3 du thème actif) est une décision de MONTÉE (Lot 1), pas de
 *    préréglage : ce ton ne préjuge pas du dégradé du header.
 */
export function headerVeilPreset(variant: HeaderVeilVariant): HeaderVeilPreset {
  switch (variant) {
    case 'appHeaderNavy':
      return { anchor: 'top', tone: 'marine', height: DEFAULT_HEADER_VEIL_HEIGHT };
    case 'innerScreenHeader':
      return { anchor: 'top', tone: 'canvas', height: DEFAULT_HEADER_VEIL_HEIGHT };
    case 'stickyBackRow':
      return { anchor: 'top', tone: 'canvas', height: DEFAULT_HEADER_VEIL_HEIGHT };
  }
}
