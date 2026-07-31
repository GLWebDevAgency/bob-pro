/**
 * COMPORTEMENT 1 — LE PILOTE DE SCROLL, exécuté.
 *
 * Le worklet de scroll est réécrit en ligne (un worklet n'appelle pas une fonction importée) :
 * ce test l'EXÉCUTE et compare sa sortie à `minimizeDecision`, la spécification pure et testée.
 * C'est la seule chose qui interdise aux deux de diverger.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MINIMIZE_DEAD_ZONE, minimizeDecision } from '@bob/ui';

const hoisted = vi.hoisted(() => ({
  springs: [] as number[],
  boxes: [] as { value: unknown }[],
}));

/**
 * Importer `@bob/ui` charge le barrel ENTIER, donc `react-native` — dont l'`index.js` est écrit
 * en Flow et ne se parse pas. Le doublon n'est pas une commodité : sans lui, aucun test de ce
 * fichier ne collecte.
 */
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    isScreenReaderEnabled: () => Promise.resolve(false),
    isReduceTransparencyEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove: () => undefined }),
  },
  Animated: {
    View: 'RNAnimated.View',
    Text: 'RNAnimated.Text',
    Value: class {
      setValue(): void {
        /* doublon */
      }
    },
    timing: () => ({ start: () => undefined }),
    spring: () => ({ start: () => undefined }),
    loop: () => ({ start: () => undefined, stop: () => undefined }),
    createAnimatedComponent: (component: unknown) => `RNAnimated(${String(component)})`,
  },
  Easing: { inOut: () => 'easing', ease: 'ease', out: () => 'easing', bezier: () => 'easing' },
  Modal: 'Modal',
  PanResponder: { create: () => ({ panHandlers: {} }) },
  PixelRatio: { getFontScale: () => 1 },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec['ios'] },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: {
    absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    create: (styles: unknown) => styles,
    flatten: (style: unknown) => style,
  },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Svg: 'Svg',
  Path: 'Path',
  Circle: 'Circle',
  Rect: 'Rect',
  G: 'G',
  Defs: 'Defs',
  LinearGradient: 'SvgLinearGradient',
  Stop: 'Stop',
  ClipPath: 'ClipPath',
  Line: 'Line',
  Text: 'SvgText',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('react-native-reanimated', () => ({
  useSharedValue: (initial: unknown) => {
    const box = { value: initial };
    hoisted.boxes.push(box);
    return box;
  },
  useAnimatedScrollHandler: (handlers: { onScroll: (event: unknown) => void }) => handlers,
  withSpring: (target: number) => {
    hoisted.springs.push(target);
    return target;
  },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    // Le pilote est un hook : on l'appelle hors composant, avec un `useContext` neutre et un
    // `useMemo` qui se contente d'évaluer. Rien d'autre du module React n'est doublé.
    useContext: () => null,
    useMemo: (factory: () => unknown) => factory(),
  };
});

const { setMinimized, useMinimizeOnScroll } = await import('./bob-tab-bar-minimize');

/** Le doublon rend l'objet de handlers tel quel ; le type publié, lui, est opaque. */
type ScrollHandler = { onScroll: (event: ScrollEvent) => void };

interface ScrollEvent {
  contentOffset: { y: number };
  contentSize: { height: number };
  layoutMeasurement: { height: number };
}

function scroll(y: number, contentHeight = 4000, layoutHeight = 800): ScrollEvent {
  return {
    contentOffset: { y },
    contentSize: { height: contentHeight },
    layoutMeasurement: { height: layoutHeight },
  };
}

beforeEach(() => {
  hoisted.springs.length = 0;
  hoisted.boxes.length = 0;
});

describe('1 · pilote de scroll — la même décision que la spécification pure', () => {
  /**
   * ─── LE RECROISEMENT DE LA ROUE DÉCLARÉE n° 2 ─────────────────────────────────────────
   *
   * `minimizeDecision` est REDITE en ligne dans le worklet (un worklet n'appelle pas une
   * fonction importée). Deux écritures d'une même règle peuvent diverger sans bruit : ce test
   * est la seule chose qui l'interdise, et il compare DEUX sorties à chaque pas, pas une —
   *  · la CIBLE du ressort (`target`) ;
   *  · l'OFFSET CLAMPÉ mémorisé (`previousY`).
   * Comparer la seule cible laisserait passer une divergence de CLAMP, c'est-à-dire précisément
   * le défaut que le clamp existe pour corriger : un `dy` inversé par le rubber-band produit la
   * bonne cible une frame sur deux, et le test resterait vert.
   *
   * La course est DENSE et adverse : plateaux (dy = 0), micro-tremblements dans la zone morte,
   * inversions de direction, sur-défilement haut et bas, retour sous le seuil de dépli forcé.
   */
  const COURSE = [
    0, 8, 23, 24, 25, 28, 27, 26, 40, 42, 45, 45, 45, 90, 88, 60, 10, 0, -50, -200, 500, 1000,
    3200, 3200, 9999, 9999, 3000, 1200, 100, 26, 24, 23, 5, 0,
  ];

  it('replie, déplie, et ne bouge pas dans la zone morte — recroisé pas à pas', () => {
    const handler = useMinimizeOnScroll() as unknown as ScrollHandler;
    const [progress, , animated, previousBox] = hoisted.boxes as { value: unknown }[];
    // `animated` à vrai : on veut voir les ressorts partir.
    if (animated) animated.value = true;

    let previousY = 0;
    for (const y of COURSE) {
      const before = progress?.value;
      handler.onScroll(scroll(y));
      const expected = minimizeDecision({
        contentOffsetY: y,
        contentHeight: 4000,
        layoutHeight: 800,
        previousY,
      });
      // (1) l'offset CLAMPÉ que le worklet a mémorisé — la moitié qui manquait.
      expect(previousBox?.value, `y=${y} : offset clampé`).toBe(expected.y);
      // (2) la cible du ressort.
      if (expected.target === null) {
        expect(progress?.value, `y=${y} : zone morte`).toBe(before);
      } else {
        expect(progress?.value, `y=${y}`).toBe(expected.target);
      }
      previousY = expected.y;
    }
  });

  it('les deux écritures partagent les MÊMES seuils — importés, jamais recopiés', () => {
    const handler = useMinimizeOnScroll() as unknown as ScrollHandler;
    const [progress, , animated] = hoisted.boxes as { value: unknown }[];
    if (animated) animated.value = true;
    // Exactement à la frontière de la zone morte : rien ne bouge. Un seuil recopié à 2 ou à 4
    // ici, et la spécification pure dirait le contraire — ce test le verrait.
    handler.onScroll(scroll(200));
    const atThreshold = progress?.value;
    handler.onScroll(scroll(200 + MINIMIZE_DEAD_ZONE));
    expect(progress?.value).toBe(atThreshold);
    expect(
      minimizeDecision({
        contentOffsetY: 200 + MINIMIZE_DEAD_ZONE,
        contentHeight: 4000,
        layoutHeight: 800,
        previousY: 200,
      }).target,
    ).toBeNull();
    // Un point de plus, et les deux écritures basculent ENSEMBLE.
    handler.onScroll(scroll(200 + MINIMIZE_DEAD_ZONE + 1));
    expect(progress?.value).toBe(1);
  });

  it('CLAMPE l’offset — le rubber-band ne peut pas inverser la direction une frame', () => {
    const handler = useMinimizeOnScroll() as unknown as ScrollHandler;
    const [, , animated] = hoisted.boxes as { value: unknown }[];
    if (animated) animated.value = true;
    // Overscroll haut : l'offset négatif est ramené à 0, donc sous le seuil de retour haut.
    handler.onScroll(scroll(-200));
    expect(hoisted.boxes[0]?.value).toBe(0);
    // Overscroll bas : ramené à `contentSize − layout`, pas au-delà.
    handler.onScroll(scroll(9999));
    handler.onScroll(scroll(9999));
    // Deux frames au même offset clampé : `dy` vaut 0, donc zone morte, donc rien ne bouge.
    expect(hoisted.boxes[0]?.value).toBe(1);
  });
});

describe('recentrage — no-op quand on va déjà vers la cible', () => {
  it('ne relance PAS le ressort quand la cible ne change pas', () => {
    const state = {
      progress: { value: 0 },
      target: { value: 0 },
      animated: { value: true },
    };
    setMinimized(state as never, 1);
    expect(hoisted.springs).toEqual([1]);
    setMinimized(state as never, 1);
    setMinimized(state as never, 1);
    // Sans cette garde, chaque frame de scroll redémarrerait l'animation — un stutter visible.
    expect(hoisted.springs).toEqual([1]);
    setMinimized(state as never, 0);
    expect(hoisted.springs).toEqual([1, 0]);
  });

  it('POSE la valeur au lieu de l’animer quand le mouvement est interdit', () => {
    const state = {
      progress: { value: 0 },
      target: { value: 0 },
      // Fenêtre inconnue ou Reduce Motion actif : les deux valent `false` ici.
      animated: { value: false },
    };
    setMinimized(state as never, 1);
    expect(hoisted.springs).toEqual([]);
    expect(state.progress.value).toBe(1);
  });
});
