/**
 * BobTabBar — LE RENDU des six comportements normatifs de la tab bar
 * (04 § Comportement normatif de la tab bar). La logique, elle, vit dans
 * `@bob/ui` → `bob-tab-bar.logic.ts`, testée séparément.
 *
 * ─── POURQUOI CE FICHIER EST DANS `apps/mobile` ET NON DANS `@bob/ui` ────────────────────
 * Il importe `react-native-reanimated` et `react-native-gesture-handler`. Ces deux runtimes
 * sont déclarés dans `apps/mobile/package.json` et NULLE PART ailleurs. Les déclarer aussi dans
 * `@bob/ui` obligerait à réécrire `pnpm-lock.yaml` (`auto-install-peers=true` le réécrit dès
 * qu'une `peerDependency` apparaît), ce qui ferait échouer tout `pnpm install --frozen-lockfile`
 * en intégration continue. C'est exactement la couture que le socle a déjà posée pour la
 * matière : le TYPE et la LOGIQUE dans `@bob/ui`, l'IMPLÉMENTATION qui touche le pont natif dans
 * `apps/mobile`. Le port haptique suit la même règle, et pour la même raison.
 *
 * ─── LES SIX, ET OÙ ILS SONT ────────────────────────────────────────────────────────────
 *  1. MINIMIZE-ON-SCROLL — `barStyle`, `rowStyle`, `pressableStyle`, `visualStyle` : une seule
 *     progression 0..1 partagée (`bob-tab-bar-minimize.tsx`), ressort critique-amorti, zéro
 *     `setState` par frame.
 *  2. HIGHLIGHT GLISSANT — `highlightStyle` : UN SEUL bloc en absolu, `translateX` transform-only,
 *     ressort sous-amorti reciblé en préservant la vélocité.
 *  3. SCRUB — `Gesture.Race(pan, tap)` sur toute la capsule, mapping 1:1 sans ressort pendant le
 *     drag, tick au FRANCHISSEMENT de frontière, navigation au RELÂCHEMENT seulement.
 *  4. FLOU DE BORD — `ProgressiveBlurBob` du kit de matière, déclaré AVANT le chrome. Il n'est
 *     pas réécrit ici : il est consommé.
 *  5. FADE-THROUGH — `bob-tab-slot.tsx`, à côté.
 *  6. TEINTE PILOTÉE PAR LE HIGHLIGHT — `glyphStyle` et `labelStyle` : opacité et couleur
 *     interpolées sur la DISTANCE au highlight, jamais sur un booléen de focus.
 *
 * ─── ORDRE DE PEINTURE : PAR LA DÉCLARATION SEULE ───────────────────────────────────────
 * CONTENU → RETOMBÉE → CHROME. Aucun `zIndex`, aucune `elevation`, aucun token d'ombre sur la
 * retombée. Android trie un `ViewGroup` par `Z = elevation + translationZ` et cela PRIME sur
 * l'ordre de déclaration ; iOS ignore `elevation` et suit la déclaration. Deux leviers en
 * désaccord ne se départagent pas — ils produisent deux rendus par OS. Le désaccord est
 * INTERDIT, pas arbitré. Un test lit ce fichier et le vérifie.
 *
 * ─── CE QUI EST INLINE DANS LES WORKLETS, ET POURQUOI ───────────────────────────────────
 * Un worklet ne peut pas appeler une fonction importée non workletisée. La composition
 * géométrique (`max`, `+`, `/`) est donc écrite dans les worklets — mais AUCUN nombre ne l'est :
 * toutes les constantes viennent de `@bob/ui`. Et les worklets ne sont pas crus sur parole : le
 * test de rendu les EXÉCUTE et compare leur sortie à `tabBarGeometry()`, la fonction normative,
 * sur une VINGTAINE DE POINTS échantillonnés de la course — pas seulement aux deux extrémités,
 * où un `max` mal placé passerait inaperçu. C'est un échantillonnage, pas une preuve
 * exhaustive : dit ainsi, il vaut ce qu'il vaut, et il vaut déjà beaucoup plus qu'une relecture.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ProgressiveBlurBob,
  SCRUB_ACTIVE_OFFSET_X,
  SCRUB_FAIL_OFFSET_Y,
  SCRUB_TAP_MAX_DISTANCE,
  SCRUB_TAP_MAX_DURATION,
  TAB_BAR_BLEED,
  TAB_BAR_BORDER_WIDTH,
  TAB_BAR_MARGIN,
  TAB_BAR_ROW_PAD_H,
  TAB_BAR_SIDE_INSET,
  TAB_BAR_SLIDE_SPRING,
  edgeFalloffHeight,
  font,
  longestWord,
  motionAllowed,
  resolveBarLabelTier,
  resolveTabLabelTier,
  scrubAllowed,
  tabActiveTint,
  tabBarBottomOffset,
  tabBarGeometry,
  tabBarGeometryBounds,
  tabTintPalette,
  tickSafely,
  useReduceMotionPreference,
  useScreenReaderPreference,
  useTheme,
  type TabBarGeometryBounds,
  type TabHapticPort,
  type TabLabelTier,
  type TabTintPalette,
} from '@bob/ui';
import { setMinimized, useTabBarMinimizeState } from './bob-tab-bar-minimize';

/** Taille de glyphe, reprise telle quelle de la barre livrée : la matière ne change pas. */
const ICON_SIZE = 23;
/** Taille du label — valeur LIVRÉE, certifiée AA en paire avec les rôles `navigation.*`. */
const LABEL_FONT_SIZE = 10;
/** Rythme intérieur entre le glyphe et le label, repris de la barre livrée. */
const ITEM_GAP = 3;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface BobTabBarItem {
  readonly key: string;
  readonly label: string;
  readonly icon: (state: { readonly color: string; readonly size: number }) => ReactNode;
}

export interface BobTabBarProps {
  readonly items: readonly BobTabBarItem[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
  /**
   * PORT HAPTIQUE, injecté par l'application. ABSENT par défaut, et c'est le rang normal :
   * `expo-haptics` n'est pas dans le dépôt et `UX-ADR-006` est encore `Proposed`. Absent = pas
   * de tick, jamais d'erreur.
   */
  readonly hapticPort?: TabHapticPort | undefined;
  /** Préférence système de retour haptique. Faux = on se tait, quoi qu'il arrive. */
  readonly hapticsEnabled?: boolean;
  readonly testID?: string | undefined;
}

interface LabelMeasure {
  readonly natural: number;
  readonly longestWord: number;
}

type LabelMeasures = Readonly<Record<string, LabelMeasure>>;

/** Palier de la barre : un seul label qui ne tient pas fait passer TOUS les onglets en icônes. */
function barLabelTier(
  items: readonly BobTabBarItem[],
  measures: LabelMeasures,
  availableWidth: number,
): TabLabelTier {
  return resolveBarLabelTier(
    items.map((item) => {
      const measure = measures[item.key];
      return resolveTabLabelTier(
        measure === undefined
          ? undefined
          : {
              naturalWidth: measure.natural,
              longestWordWidth: measure.longestWord,
              availableWidth,
            },
      );
    }),
  );
}

export function BobTabBar({
  items,
  activeKey,
  onSelect,
  hapticPort,
  hapticsEnabled = true,
  testID,
}: BobTabBarProps): ReactElement {
  const { appearance } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const reduceMotion = useReduceMotionPreference();
  const screenReader = useScreenReaderPreference();
  const minimize = useTabBarMinimizeState();

  const palette = useMemo(() => tabTintPalette(appearance), [appearance]);
  const tabCount = Math.max(items.length, 1);
  const activeIndex = Math.max(
    items.findIndex((item) => item.key === activeKey),
    0,
  );

  const bounds = useMemo(
    () =>
      tabBarGeometryBounds({
        platform: Platform.OS === 'android' ? 'android' : 'ios',
        windowWidth,
        tabCount,
      }),
    [windowWidth, tabCount],
  );
  const expanded = useMemo(
    () =>
      tabBarGeometry(0, {
        platform: Platform.OS === 'android' ? 'android' : 'ios',
        windowWidth,
        tabCount,
      }),
    [windowWidth, tabCount],
  );

  // ── Position du highlight : la SEULE source de la teinte (comportement 6) ─────────────
  const slideIndex = useSharedValue(activeIndex);
  const isDragging = useSharedValue(false);
  const lastTicked = useSharedValue(activeIndex);
  const progress = minimize.progress;

  /**
   * MOUVEMENT AUTORISÉ — trois états, l'INCONNU compte comme ACTIF. Publié dans un `SharedValue`
   * pour que les worklets de geste puissent le lire sans repasser par le thread JS.
   *
   * RIEN N'EST REJOUÉ à la résolution : quand la préférence arrive, on met à jour le drapeau et
   * c'est tout. La position courante n'est pas ré-animée — seules les interactions SUIVANTES
   * animent. C'est la règle A18 appliquée telle quelle.
   */
  const canAnimate = motionAllowed(reduceMotion);
  useEffect(() => {
    minimize.animated.value = canAnimate;
  }, [canAnimate, minimize]);

  const tick = useCallback(() => {
    tickSafely({ port: hapticPort, hapticsEnabled });
  }, [hapticPort, hapticsEnabled]);

  const selectIndex = useCallback(
    (index: number) => {
      const item = items[Math.min(Math.max(index, 0), items.length - 1)];
      if (item !== undefined) onSelect(item.key);
    },
    [items, onSelect],
  );

  /**
   * NAVIGATION PROGRAMMATIQUE — deep link, geste de retour, action Bob à la voix : le highlight
   * VOYAGE aussi dans ces cas-là, il ne saute pas. Et pendant un drag, le DOIGT est propriétaire
   * du highlight : on ne le recale jamais sous lui.
   */
  const lastActiveIndex = useRef<number | null>(null);
  useEffect(() => {
    /*
     * ON N'AGIT QUE SI L'ONGLET ACTIF A CHANGÉ. `canAnimate` est une dépendance de cet effet et
     * il change TOUT SEUL — de la fenêtre inconnue à sa valeur réelle, quelques millisecondes
     * après le montage. Sans cette garde, la résolution de la préférence relançait un ressort
     * sur une barre déjà en place : une RÉ-ANIMATION à la résolution, que la règle A18 interdit
     * mot pour mot. Le même défaut a été constaté et corrigé sur le slot d'écran.
     */
    if (lastActiveIndex.current === activeIndex) return;
    lastActiveIndex.current = activeIndex;
    if (isDragging.value) return;
    slideIndex.value = canAnimate ? withSpring(activeIndex, TAB_BAR_SLIDE_SPRING) : activeIndex;
    lastTicked.value = activeIndex;
  }, [activeIndex, canAnimate, isDragging, lastTicked, slideIndex]);

  // ── Comportement 3 · le geste ────────────────────────────────────────────────────────
  const gesture = useMemo(() => {
    const sideInsetMax = TAB_BAR_SIDE_INSET;
    const margin = TAB_BAR_MARGIN;
    const border = TAB_BAR_BORDER_WIDTH;
    const rowPad = TAB_BAR_ROW_PAD_H;
    const count = tabCount;
    const width = windowWidth;
    const animate = canAnimate;

    const pan = Gesture.Pan()
      .activeOffsetX([-SCRUB_ACTIVE_OFFSET_X, SCRUB_ACTIVE_OFFSET_X])
      .failOffsetY([-SCRUB_FAIL_OFFSET_Y, SCRUB_FAIL_OFFSET_Y])
      .onStart(() => {
        'worklet';
        isDragging.value = true;
        lastTicked.value = Math.round(slideIndex.value);
        // Scruber est une interaction DÉLIBÉRÉE avec la barre : elle se ré-étend.
        setMinimized(minimize, 0);
      })
      .onUpdate((event) => {
        'worklet';
        const sideInset = interpolate(
          progress.value,
          [0, 1],
          [0, sideInsetMax],
          Extrapolation.CLAMP,
        );
        const pillWidth = Math.max(width - 2 * margin - 2 * sideInset, 0);
        const contentWidth = Math.max(pillWidth - 2 * border - 2 * rowPad, 0);
        const itemWidth = contentWidth / count;
        if (!(itemWidth > 0)) return;
        // Mapping 1:1 STRICT, sans ressort : l'indicateur doit se sentir attaché au doigt.
        const raw = (event.x - border - rowPad) / itemWidth - 0.5;
        const index = Math.min(Math.max(raw, 0), count - 1);
        slideIndex.value = index;

        // TICK AU FRANCHISSEMENT DE FRONTIÈRE, jamais par frame. Spécifié et testé par
        // `boundaryTick` ; réécrit ici parce qu'un worklet n'appelle pas une fonction importée.
        const rounded = Math.round(index);
        if (rounded !== lastTicked.value) {
          lastTicked.value = rounded;
          scheduleOnRN(tick);
        }
      })
      .onFinalize(() => {
        'worklet';
        // Se déclenche AUSSI à l'échec (le geste était un tap) : sans cette garde, on volerait
        // la navigation du tap et l'écran changerait deux fois.
        if (!isDragging.value) return;
        const rounded = Math.round(slideIndex.value);
        // Le recalage au ressort et la navigation partent dans la MÊME frame : un ressort n'est
        // pas une porte (A22). L'onglet cible est lu AVANT de lancer le ressort, parce que c'est
        // lui qui fixe la position d'arrivée — dépendance de valeur, pas séquence temporelle.
        slideIndex.value = animate ? withSpring(rounded, TAB_BAR_SLIDE_SPRING) : rounded;
        isDragging.value = false;
        scheduleOnRN(selectIndex, rounded);
      });

    const tap = Gesture.Tap()
      .maxDistance(SCRUB_TAP_MAX_DISTANCE)
      .maxDuration(SCRUB_TAP_MAX_DURATION)
      .onEnd((event, success) => {
        'worklet';
        if (!success) return;
        const sideInset = interpolate(
          progress.value,
          [0, 1],
          [0, sideInsetMax],
          Extrapolation.CLAMP,
        );
        const pillWidth = Math.max(width - 2 * margin - 2 * sideInset, 0);
        const contentWidth = Math.max(pillWidth - 2 * border - 2 * rowPad, 0);
        const itemWidth = contentWidth / count;
        if (!(itemWidth > 0)) return;
        const raw = (event.x - border - rowPad) / itemWidth - 0.5;
        const index = Math.round(Math.min(Math.max(raw, 0), count - 1));
        slideIndex.value = animate ? withSpring(index, TAB_BAR_SLIDE_SPRING) : index;
        setMinimized(minimize, 0);
        scheduleOnRN(selectIndex, index);
      });

    return Gesture.Race(pan, tap);
  }, [
    canAnimate,
    isDragging,
    lastTicked,
    minimize,
    progress,
    selectIndex,
    slideIndex,
    tabCount,
    tick,
    windowWidth,
  ]);

  // ── Comportement 1 · la pilule rétrécit dans les DEUX dimensions ─────────────────────
  const barStyle = useAnimatedStyle(() => {
    const visual = interpolate(
      progress.value,
      [0, 1],
      [bounds.visual[0], bounds.visual[1]],
      Extrapolation.CLAMP,
    );
    // `max` et non interpolation des bouts : la cible est un PLANCHER, pas une extrémité.
    const pressable = Math.max(bounds.touchFloor, visual);
    const rhythm = interpolate(
      progress.value,
      [0, 1],
      [bounds.rhythm[0], bounds.rhythm[1]],
      Extrapolation.CLAMP,
    );
    const measured = pressable + 2 * rhythm + 2 * bounds.borderWidth;
    return {
      height: measured,
      borderRadius: measured / 2,
      marginHorizontal: interpolate(
        progress.value,
        [0, 1],
        [bounds.sideInset[0], bounds.sideInset[1]],
        Extrapolation.CLAMP,
      ),
    };
  });

  /** Le rythme EXTÉRIEUR s'anime ; la cible, elle, ne bouge pas. */
  const rowStyle = useAnimatedStyle(() => ({
    paddingVertical: interpolate(
      progress.value,
      [0, 1],
      [bounds.rhythm[0], bounds.rhythm[1]],
      Extrapolation.CLAMP,
    ),
  }));

  // ── Comportement 2 · un seul bloc de highlight, transform-only ───────────────────────
  const highlightStyle = useAnimatedStyle(() => {
    const visual = interpolate(
      progress.value,
      [0, 1],
      [bounds.visual[0], bounds.visual[1]],
      Extrapolation.CLAMP,
    );
    const pressable = Math.max(bounds.touchFloor, visual);
    const rhythm = interpolate(
      progress.value,
      [0, 1],
      [bounds.rhythm[0], bounds.rhythm[1]],
      Extrapolation.CLAMP,
    );
    const sideInset = interpolate(
      progress.value,
      [0, 1],
      [bounds.sideInset[0], bounds.sideInset[1]],
      Extrapolation.CLAMP,
    );
    const pillWidth = Math.max(bounds.windowWidth - 2 * bounds.margin - 2 * sideInset, 0);
    const contentWidth = Math.max(pillWidth - 2 * bounds.borderWidth - 2 * bounds.rowPadH, 0);
    const itemWidth = contentWidth / bounds.tabCount;
    return {
      height: visual,
      width: itemWidth,
      borderRadius: visual / 2,
      // Centré dans la boîte INTÉRIEURE de la pilule — le highlight suit la barre pendant
      // qu'elle s'ouvre, il n'est jamais recalé après coup.
      top: (pressable + 2 * rhythm - visual) / 2,
      transform: [{ translateX: bounds.rowPadH + itemWidth * slideIndex.value }],
    };
  });

  // ── Dynamic Type · le palier du label ────────────────────────────────────────────────
  const fontScale = PixelRatio.getFontScale();
  const [measures, setMeasures] = useState<LabelMeasures>({});
  const measuredScale = useRef(fontScale);
  if (measuredScale.current !== fontScale) {
    // La taille système a changé : les mesures d'hier ne valent plus rien. On repart d'une
    // sonde neuve — et la sonde se démonte dès qu'elle a répondu, donc rien ne persiste.
    measuredScale.current = fontScale;
    if (Object.keys(measures).length > 0) setMeasures({});
  }
  const pending = items.some((item) => measures[item.key] === undefined);
  const reportMeasure = useCallback(
    (key: string, kind: 'natural' | 'longestWord', width: number) => {
      setMeasures((current) => {
        const previous = current[key] ?? { natural: 0, longestWord: 0 };
        if (previous[kind] === width) return current;
        return { ...current, [key]: { ...previous, [kind]: width } };
      });
    },
    [],
  );
  const showLabel = barLabelTier(items, measures, expanded.itemWidth) !== 'icon-only';

  // ── Comportement 4 · la retombée, déclarée AVANT le chrome ───────────────────────────
  const bottomOffset = tabBarBottomOffset(insets.bottom);
  const falloffHeight = edgeFalloffHeight({
    safeAreaInset: bottomOffset,
    // Enveloppe dimensionnée UNE FOIS, sur l'état le PLUS HAUT : le repli se produit à
    // l'INTÉRIEUR de l'enveloppe. Une hauteur recalculée par frame serait une animation de
    // layout par frame, que la règle « jamais animée » interdit.
    chromeHeight: expanded.pillMeasuredHeight,
    bleed: TAB_BAR_BLEED,
  });

  const pill = (
    <Animated.View
      accessibilityRole="tablist"
      testID={testID === undefined ? undefined : `${testID}-pill`}
      style={[
        {
          backgroundColor: palette.pill,
          borderWidth: TAB_BAR_BORDER_WIDTH,
          borderColor: palette.border,
          borderCurve: 'continuous' as const,
          overflow: 'hidden' as const,
        },
        barStyle,
      ]}
    >
      {/* 1 — LA CAPSULE DE HIGHLIGHT, déclarée d'abord : elle passe SOUS les icônes et les
             labels. C'est ce qui en fait un FOND DE TEXTE, et c'est pour cela que sa teinte
             est une contrainte de contraste (§ 2, A23), pas un goût. */}
      <Animated.View
        pointerEvents="none"
        testID={testID === undefined ? undefined : `${testID}-highlight`}
        style={[
          {
            position: 'absolute' as const,
            left: 0,
            backgroundColor: palette.highlight,
            borderCurve: 'continuous' as const,
          },
          highlightStyle,
        ]}
      />

      {/* 2 — LA RANGÉE D'ONGLETS, déclarée ensuite : peinte AU-DESSUS du highlight. */}
      <Animated.View
        style={[
          {
            flex: 1,
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            paddingHorizontal: TAB_BAR_ROW_PAD_H,
          },
          rowStyle,
        ]}
      >
        {items.map((item, index) => (
          <TabItem
            key={item.key}
            item={item}
            index={index}
            selected={index === activeIndex}
            slideIndex={slideIndex}
            progress={progress}
            bounds={bounds}
            palette={palette}
            showLabel={showLabel}
            testID={testID === undefined ? undefined : `${testID}-tab-${item.key}`}
            onPress={() => {
              // Ré-expansion forcée : toute interaction délibérée avec la barre la ré-étend.
              // Ce chemin sert VoiceOver/TalkBack et le focus clavier, pour qui le détecteur de
              // geste n'existe pas — et il est le chemin UNIQUE quand le scrub est désactivé.
              setMinimized(minimize, 0);
              slideIndex.value = canAnimate ? withSpring(index, TAB_BAR_SLIDE_SPRING) : index;
              onSelect(item.key);
            }}
          />
        ))}
      </Animated.View>
    </Animated.View>
  );

  return (
    <View
      pointerEvents="box-none"
      testID={testID}
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
    >
      {/* CONTENU → RETOMBÉE → CHROME, par l'ordre de DÉCLARATION seul. La retombée est en mode
          NOMINAL teinté : sur cette barre, le mode flouté ne coexiste jamais avec un chrome dont
          la hauteur s'anime (§ 4). Aucun port de flou n'est donc injecté — c'est le rang normal
          de l'algorithme, pas une dégradation. */}
      <ProgressiveBlurBob
        anchor="bottom"
        height={falloffHeight}
        tone="canvas"
        testID={testID === undefined ? undefined : `${testID}-falloff`}
      />

      <View
        pointerEvents="box-none"
        style={{ marginHorizontal: TAB_BAR_MARGIN, marginBottom: bottomOffset }}
      >
        {/* Le détecteur n'est MONTÉ que si le lecteur d'écran est connu ET inactif : il consomme
            les touches d'exploration, et sans cette coupure la barre deviendrait un bloc opaque
            au geste de VoiceOver/TalkBack. Pendant la fenêtre INCONNUE il n'est pas monté non
            plus — l'état sûr est aussi l'état accessible, et les `Pressable` gardent la main. */}
        {scrubAllowed(screenReader) ? (
          <GestureDetector gesture={gesture}>{pill}</GestureDetector>
        ) : (
          pill
        )}
      </View>

      {/* SONDE DE MESURE — montée UNIQUEMENT tant qu'un label n'a pas été mesuré à la taille de
          texte courante, puis démontée : le coût au REPOS reste celui de la barre seule, ce que
          `PERF-13 · P13-A` mesure. Elle rend le label SANS contrainte de largeur, donc à sa
          largeur naturelle — la seule façon de savoir s'il tient. La référence, elle, ne mesure
          rien du tout et calcule sa géométrie par index : cela tient pour les LARGEURS D'ONGLET,
          qui divisent la fenêtre et ne dépendent pas du texte, mais pas pour le LABEL. */}
      {pending ? <LabelProbes items={items} onMeasure={reportMeasure} /> : null}
    </View>
  );
}

interface TabItemProps {
  readonly item: BobTabBarItem;
  readonly index: number;
  readonly selected: boolean;
  readonly slideIndex: SharedValue<number>;
  readonly progress: SharedValue<number>;
  readonly bounds: TabBarGeometryBounds;
  readonly palette: TabTintPalette;
  readonly showLabel: boolean;
  readonly onPress: () => void;
  readonly testID?: string | undefined;
}

/**
 * UN ONGLET. La cible tactile est le `Pressable` LUI-MÊME et rien d'autre : sa hauteur est
 * animée EXPLICITEMENT et plancherée à 44 pt (iOS) / 48 dp (Android), à tout instant de
 * l'animation. AUCUN `hitSlop` n'est déclaré ici, et ce n'est pas un oubli : un `hitSlop` ne
 * franchit jamais les bornes d'un ancêtre, il ne pourrait donc rien compléter.
 *
 * La hauteur est animée plutôt que déduite du contenu parce qu'une taille dérivée du layout est
 * EN RETARD sur l'animation du thread UI — l'icône ne resterait pas centrée pendant le repli.
 */
function TabItem({
  item,
  index,
  selected,
  slideIndex,
  progress,
  bounds,
  palette,
  showLabel,
  onPress,
  testID,
}: TabItemProps): ReactElement {
  const activeTint = tabActiveTint(item.key, palette);

  const pressableStyle = useAnimatedStyle(() => {
    const visual = interpolate(
      progress.value,
      [0, 1],
      [bounds.visual[0], bounds.visual[1]],
      Extrapolation.CLAMP,
    );
    return { height: Math.max(bounds.touchFloor, visual) };
  });

  /** Le VISUEL intérieur est dessiné DANS le `Pressable` : il ne le redimensionne jamais. */
  const visualStyle = useAnimatedStyle(() => ({
    height: interpolate(
      progress.value,
      [0, 1],
      [bounds.visual[0], bounds.visual[1]],
      Extrapolation.CLAMP,
    ),
  }));

  /**
   * COMPORTEMENT 6 — l'opacité du glyphe ACTIF est une fonction continue de la DISTANCE au
   * highlight : `1 − min(|slide − index|, 1)`. Aucun booléen de focus n'intervient. Pendant un
   * scrub les icônes s'allument au passage du doigt ; sur un tap, la lumière VOYAGE.
   */
  const glyphStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(Math.abs(slideIndex.value - index), 1),
  }));

  /** Le label suit la MÊME fonction — le socle exige que l'icône ET le label la suivent. */
  const labelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4], [1, 0], Extrapolation.CLAMP),
    color: interpolateColor(
      1 - Math.min(Math.abs(slideIndex.value - index), 1),
      [0, 1],
      [palette.inactive, activeTint],
    ),
  }));

  return (
    <AnimatedPressable
      accessibilityRole="tab"
      accessibilityLabel={item.label}
      accessibilityState={{ selected }}
      testID={testID}
      onPress={onPress}
      style={[
        { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const },
        pressableStyle,
      ]}
    >
      <Animated.View
        style={[
          {
            alignItems: 'center' as const,
            justifyContent: 'center' as const,
            overflow: 'hidden' as const,
          },
          visualStyle,
        ]}
      >
        {/* LES DEUX GLYPHES SONT DÉCORATIFS et sortent de l'arbre d'accessibilité : sans cela,
            TalkBack annoncerait DEUX éléments par onglet. Le nom accessible reste porté par le
            `Pressable` (`accessibilityRole="tab"` + `accessibilityLabel`). C'est le moyen
            « double glyphe » qui crée le doublon, pas l'invariant du § 6. */}
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          style={{ width: ICON_SIZE, height: ICON_SIZE }}
        >
          {item.icon({ color: palette.inactive, size: ICON_SIZE })}
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { alignItems: 'center' as const, justifyContent: 'center' as const },
              glyphStyle,
            ]}
          >
            {item.icon({ color: activeTint, size: ICON_SIZE })}
          </Animated.View>
        </View>

        {/* Le label ne se TRONQUE jamais : deux lignes au maximum, puis il est RETIRÉ et son sens
            reste porté par `accessibilityLabel`. `adjustsFontSizeToFit` est interdit — il
            annulerait silencieusement la préférence de taille de l'utilisateur. */}
        {showLabel ? (
          <Animated.Text
            numberOfLines={2}
            style={[
              font('meta'),
              { fontSize: LABEL_FONT_SIZE, marginTop: ITEM_GAP, textAlign: 'center' as const },
              labelStyle,
            ]}
          >
            {item.label}
          </Animated.Text>
        ) : null}
      </Animated.View>
    </AnimatedPressable>
  );
}

interface LabelProbesProps {
  readonly items: readonly BobTabBarItem[];
  readonly onMeasure: (key: string, kind: 'natural' | 'longestWord', width: number) => void;
}

/**
 * SONDE DE LARGEUR NATURELLE. Positionnée en absolu SANS contrainte de largeur, elle laisse
 * chaque `Text` se poser à sa largeur intrinsèque — ce qu'un label rendu dans un onglet ne peut
 * jamais donner, puisqu'il y est contraint.
 *
 * `onLayout` est employé ici pour une mesure NON ANIMÉE, ce que le socle autorise explicitement
 * (§ 2, A27 : « interdit comme source de la géométrie animée ; permis pour une assertion de test
 * ou une mesure non animée »). La géométrie ANIMÉE, elle, reste calculée par index et ne dépend
 * d'aucune mesure asynchrone.
 */
function LabelProbes({ items, onMeasure }: LabelProbesProps): ReactElement {
  const style = [font('meta'), { fontSize: LABEL_FONT_SIZE }];
  const measure =
    (key: string, kind: 'natural' | 'longestWord') =>
    (event: LayoutChangeEvent): void => {
      onMeasure(key, kind, event.nativeEvent.layout.width);
    };
  return (
    <View
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', top: 0, left: 0, opacity: 0 }}
      testID="bob-tab-bar-label-probes"
    >
      {items.map((item) => (
        <Text key={`${item.key}-n`} style={style} onLayout={measure(item.key, 'natural')}>
          {item.label}
        </Text>
      ))}
      {items.map((item) => (
        <Text key={`${item.key}-w`} style={style} onLayout={measure(item.key, 'longestWord')}>
          {longestWord(item.label)}
        </Text>
      ))}
    </View>
  );
}
