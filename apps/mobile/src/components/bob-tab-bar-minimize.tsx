/**
 * REPLI/DÉPLI DE LA TAB BAR — la progression partagée et son pilote de scroll (04 § 1).
 *
 * UNE SEULE SOURCE DE VÉRITÉ : un `SharedValue` 0..1 (0 = étendu, icônes + labels ; 1 = replié,
 * icônes seules), PLUS un `target` qui mémorise la dernière cible demandée. Le `target` n'est
 * pas un raffinement : sans lui, chaque frame de scroll relance le ressort vers la même cible et
 * l'animation redémarre en permanence — un stutter visible. C'est la leçon que la référence
 * écrit noir sur blanc (`minimize-context.tsx` l. 54-60), et elle est bonne.
 *
 * UN RESSORT, PAS UN TIMING, et c'est motivé : la direction du scroll s'inverse en permanence,
 * et un ressort RECIBLE en conservant la vélocité là où une courbe de timing repartirait de
 * zéro. Amorti CRITIQUE (`dampingRatio` 1) parce qu'il anime de la LAYOUT — ni overshoot, ni
 * queue de stabilisation. C'est la condition explicite de l'exception d'animation de layout de
 * [10 § Règles d'implémentation](../../../docs/mobile-experience/10-performance-observability.md).
 *
 * AUCUN `setState` PAR FRAME : tout se passe sur le thread UI, dans un worklet de scroll.
 *
 * ─── POURQUOI LE PILOTE EST LIVRÉ MAIS N'EST BRANCHÉ SUR AUCUN ÉCRAN ─────────────────────
 * `useMinimizeOnScroll` doit être posé sur la liste défilante de CHAQUE écran d'onglet. Le faire
 * ici modifierait cinq écrans LIVRÉS, ce que la borne de livraison n° 1 du socle interdit tant
 * que la refonte visuelle est reportée. Le pilote est donc livré, testé et exporté ; son
 * adoption écran par écran est une étape distincte, sous le flag `mobile_tabs_experiment_v1`.
 */
import { createContext, useContext, useMemo, type PropsWithChildren, type ReactElement } from 'react';
import {
  useAnimatedScrollHandler,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import {
  MINIMIZE_DEAD_ZONE,
  MINIMIZE_TOP_GUARD,
  TAB_BAR_MINIMIZE_SPRING,
} from '@bob/ui';

export interface TabBarMinimizeState {
  /** 0 = étendu (icônes + labels), 1 = replié (icônes seules). */
  readonly progress: SharedValue<number>;
  /** Dernière cible demandée — permet aux écrivains de NE PAS relancer le ressort. */
  readonly target: SharedValue<number>;
  /**
   * `false` quand le mouvement est interdit (Reduce Motion actif, ou préférence encore
   * INCONNUE). La progression saute alors directement à sa cible : on n'anime pas avant de
   * savoir, et on ne re-joue rien à la résolution.
   */
  readonly animated: SharedValue<boolean>;
}

const MinimizeContext = createContext<TabBarMinimizeState | null>(null);

export function TabBarMinimizeProvider({ children }: PropsWithChildren): ReactElement {
  const progress = useSharedValue(0);
  const target = useSharedValue(0);
  const animated = useSharedValue(false);
  const state = useMemo(() => ({ progress, target, animated }), [progress, target, animated]);
  return <MinimizeContext.Provider value={state}>{children}</MinimizeContext.Provider>;
}

/**
 * État complet du repli. Le repli LOCAL n'est pas une commodité : il garde un écran fonctionnel
 * quand il est rendu hors du provider (galerie de composants, écran sans barre flottante), sans
 * que l'appelant ait à tester la présence d'un contexte.
 */
export function useTabBarMinimizeState(): TabBarMinimizeState {
  const shared = useContext(MinimizeContext);
  const progress = useSharedValue(0);
  const target = useSharedValue(0);
  const animated = useSharedValue(false);
  const local = useMemo(() => ({ progress, target, animated }), [progress, target, animated]);
  return shared ?? local;
}

/**
 * RECIBLAGE — appelable des deux threads. NO-OP quand on va déjà vers `next` : c'est la seule
 * ligne qui empêche le ressort de redémarrer à chaque frame de scroll.
 *
 * Quand le mouvement est interdit, on POSE la valeur au lieu de l'animer. C'est la règle
 * fail-closed appliquée au repli : pendant la fenêtre où la préférence est inconnue, la barre
 * est rendue dans son état final, sans course — et rien n'est rejoué à la résolution.
 */
export function setMinimized(state: TabBarMinimizeState, next: 0 | 1): void {
  'worklet';
  if (state.target.value === next) return;
  state.target.value = next;
  state.progress.value = state.animated.value
    ? withSpring(next, TAB_BAR_MINIMIZE_SPRING)
    : next;
}

/**
 * PILOTE DE SCROLL. Descendre minimise, remonter (ou être près du haut) étend. Les offsets sont
 * CLAMPÉS à la plage réellement défilable : sans ce clamp, le rubber-band d'overscroll inverse
 * le signe de `dy` le temps d'une frame et fait CLIGNOTER la barre.
 *
 * La décision elle-même est spécifiée et testée dans `bob-tab-bar.logic.ts`
 * (`minimizeDecision`) ; elle est réécrite ici en ligne parce qu'un worklet ne peut pas appeler
 * une fonction importée non workletisée. Les deux seuils, eux, sont IMPORTÉS — aucune constante
 * n'est recopiée dans un thread où personne ne pourrait la relire.
 */
export function useMinimizeOnScroll(): ReturnType<typeof useAnimatedScrollHandler> {
  const state = useTabBarMinimizeState();
  const previousY = useSharedValue(0);

  return useAnimatedScrollHandler({
    onScroll: (event) => {
      'worklet';
      const maxY = Math.max(event.contentSize.height - event.layoutMeasurement.height, 0);
      const y = Math.min(Math.max(event.contentOffset.y, 0), maxY);
      const dy = y - previousY.value;
      previousY.value = y;

      if (y < MINIMIZE_TOP_GUARD) setMinimized(state, 0);
      else if (dy > MINIMIZE_DEAD_ZONE) setMinimized(state, 1);
      else if (dy < -MINIMIZE_DEAD_ZONE) setMinimized(state, 0);
    },
  });
}
