/**
 * LA COUTURE QUI BRANCHE VRAIMENT LE COMPORTEMENT 1 — et le retap sur l'onglet actif.
 *
 * ─── POURQUOI CE FICHIER EXISTE ─────────────────────────────────────────────────────────
 * `useMinimizeOnScroll` était livré, testé, exporté… et appelé par AUCUN écran. Un comportement
 * qui n'est monté nulle part n'est pas livré : le socle écrit que « livrer cinq comportements sur
 * six ne satisfait pas `G11` ». Cette couture le monte réellement, sur QUATRE des cinq écrans
 * d'onglet — `index`, `clients`, `argent`, `documents`. Le cinquième, `assistant`, ne l'est pas,
 * et la raison est écrite dans `bob-tab-bar-minimize.tsx` : son fil de chat se recale tout seul
 * en bas à chaque message, et chacun de ces recalages replierait la barre sans que personne ait
 * bougé le doigt.
 *
 * ─── DEUX RESPONSABILITÉS, ET AUCUNE DE PLUS ────────────────────────────────────────────
 *  1. REPLI AU SCROLL — le worklet de `useMinimizeOnScroll` est attaché à la vue défilante ;
 *  2. RETAP SUR L'ONGLET ACTIF → RETOUR EN HAUT. C'est l'un des points du tableau « Ce que la
 *     référence ne fait PAS » (elle laisse `router.navigate` en no-op sur la route courante) et
 *     l'une des § Exigences communes. La vue défilante FOCUSÉE s'enregistre ; le layout
 *     d'onglets, qui seul sait qu'on a re-tapé l'onglet courant, appelle `scrollToTop()`. Sur un
 *     écran qui n'emploie pas cette couture — `assistant` — personne ne s'enregistre, et le
 *     retap ne fait rien : le registre reste vide, il ne remonte pas l'écran d'à côté.
 *
 * ─── LE FLAG DÉCIDE DU TYPE DE VUE, ET CE N'EST PAS UN DÉTAIL ───────────────────────────
 * Flag OFF → un `ScrollView` NU, avec les mêmes props à une près — la `ref`, dont la couture a
 * besoin pour s'enregistrer comme cible du retour en haut. Un test énumère les props rendues
 * pour que cette exception soit dite, pas supposée. Aucun gestionnaire de scroll n'est attaché,
 * donc aucun coût par frame. C'est une condition de VALIDITÉ de `PERF-13`, qui compare
 * les deux bras ON/OFF sur le même commit : si le bras OFF payait lui aussi un worklet de
 * scroll, la comparaison ne mesurerait plus rien. Le flag se lit depuis l'environnement et ne
 * change pas en cours de session — le type d'élément est donc stable, et React ne remonte rien.
 *
 * CE QUI RESTE PAYÉ HORS FLAG, et il faut le dire : un composant React de plus dans l'arbre
 * (celui-ci), et l'appel de `useMinimizeOnScroll` au MONTAGE — trois valeurs partagées et un
 * worklet fabriqué mais jamais attaché. Rien par frame, mais pas rien du tout.
 *
 * ─── CE QUI N'EST PAS ICI ───────────────────────────────────────────────────────────────
 * Aucun style, aucune couleur, aucune marge : les écrans gardent les leurs. Cette couture ne
 * restyle rien — c'est un branchement de comportement, pas une refonte visuelle.
 */
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
  type ReactElement,
} from 'react';
import { ScrollView, type ScrollViewProps } from 'react-native';
import Animated from 'react-native-reanimated';
import { isMobileTabsExperimentEnabled } from './bob-tab-bar-flag';
import { useMinimizeOnScroll } from './bob-tab-bar-minimize';

/** Ce qu'une vue défilante d'onglet expose au layout : remonter en haut, rien d'autre. */
export interface TabScrollTarget {
  scrollTo(options: { y: number; animated: boolean }): void;
}

interface TabScrollRegistry {
  readonly register: (target: TabScrollTarget | null) => void;
  readonly scrollToTop: () => void;
}

const TabScrollContext = createContext<TabScrollRegistry | null>(null);

/**
 * REGISTRE DU RETOUR EN HAUT. Une seule case : dans un navigateur d'onglets, un seul écran est
 * focusé à la fois, et c'est LUI qui s'enregistre. Une `ref` et non un `state` : s'enregistrer ne
 * doit re-rendre personne.
 */
export function TabScrollTopProvider({ children }: PropsWithChildren): ReactElement {
  const focused = useRef<TabScrollTarget | null>(null);
  const value = useMemo<TabScrollRegistry>(
    () => ({
      register: (target) => {
        focused.current = target;
      },
      scrollToTop: () => {
        focused.current?.scrollTo({ y: 0, animated: true });
      },
    }),
    [],
  );
  return <TabScrollContext.Provider value={value}>{children}</TabScrollContext.Provider>;
}

/**
 * Le retour en haut, vu du layout d'onglets. Rend une fonction inerte hors provider : un écran
 * rendu seul (galerie, test unitaire) ne doit pas avoir à tester la présence d'un contexte.
 */
export function useTabScrollTop(): () => void {
  const registry = useContext(TabScrollContext);
  return useCallback(() => registry?.scrollToTop(), [registry]);
}

/**
 * FOCUS DE LA SCÈNE. Les cinq écrans d'onglet restent MONTÉS ensemble : sans cette information,
 * le dernier monté volerait le registre aux quatre autres et le retap remonterait l'écran d'à
 * côté. Le focus est publié par `screenLayout` (le seul endroit qui le connaisse sans qu'un
 * écran ait à appeler un hook de navigation) et vaut `true` par défaut — un écran rendu hors
 * navigateur est le seul à l'écran.
 */
const TabSceneFocusContext = createContext(true);

export function TabSceneFocus({
  focused,
  children,
}: PropsWithChildren<{ readonly focused: boolean }>): ReactElement {
  return <TabSceneFocusContext.Provider value={focused}>{children}</TabSceneFocusContext.Provider>;
}

/**
 * `ScrollView` d'un écran d'onglet. Mêmes props que le `ScrollView` de React Native — c'est un
 * remplacement en place, pas une nouvelle API à apprendre.
 */
export const TabsScrollView = forwardRef<ScrollView, PropsWithChildren<ScrollViewProps>>(
  function TabsScrollView({ children, ...props }, ref): ReactElement {
    const focused = useContext(TabSceneFocusContext);
    /*
     * LE HOOK EST APPELÉ INCONDITIONNELLEMENT — règle des hooks — mais son gestionnaire n'est
     * ATTACHÉ que sous le flag. Non attaché, il ne reçoit aucun événement : le bras OFF de
     * `PERF-13` ne paie donc rien par frame, seulement la création d'un worklet au montage.
     */
    const onScroll = useMinimizeOnScroll();
    const ported = isMobileTabsExperimentEnabled();

    const registry = useContext(TabScrollContext);
    const self = useRef<TabScrollTarget | null>(null);
    useEffect(() => {
      if (registry === null || !focused) return undefined;
      registry.register(self.current);
      return () => registry.register(null);
    }, [registry, focused]);

    const keep = useCallback(
      (node: ScrollView | null) => {
        self.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref !== null) ref.current = node;
      },
      [ref],
    );

    if (!ported) {
      return (
        <ScrollView ref={keep} {...props}>
          {children}
        </ScrollView>
      );
    }
    return (
      <Animated.ScrollView ref={keep} onScroll={onScroll} scrollEventThrottle={16} {...props}>
        {children}
      </Animated.ScrollView>
    );
  },
);
