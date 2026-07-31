/**
 * BobTabBar — LE RENDU, verrouillé comportement par comportement.
 *
 * CE QUE CE FICHIER PROUVE, ET QUE LA LOGIQUE PURE NE PEUT PAS PROUVER :
 *  · que les WORKLETS écrits en ligne dans le composant produisent EXACTEMENT ce que la fonction
 *    normative `tabBarGeometry()` calcule — sur une vingtaine de points ÉCHANTILLONNÉS de la
 *    course, et pas seulement aux deux extrémités, où un `max` mal placé passerait inaperçu.
 *    C'est un échantillonnage, pas une preuve exhaustive ; il s'obtient en EXÉCUTANT les
 *    worklets, pas en les relisant, et c'est ce qui interdit aux deux écritures de diverger ;
 *  · l'ORDRE DE PEINTURE, par la déclaration seule ;
 *  · le fail-CLOSED au PREMIER rendu : aucun détecteur de geste monté tant que le lecteur
 *    d'écran est inconnu ;
 *  · l'absence de `hitSlop`, de `zIndex` et d'`elevation` — contrôle STATIQUE, pas revue visuelle.
 *
 * COMMENT LES WORKLETS SONT EXÉCUTÉS. `useAnimatedStyle` est remplacé par un doublon qui APPELLE
 * l'updater au rendu et rend son résultat : le style présent dans l'arbre est donc la sortie
 * réelle du worklet pour la valeur courante de la progression. On pousse la progression, on
 * re-rend, on relit. Aucune approximation.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  ThemeProvider,
  TAB_BAR_BORDER_WIDTH,
  TAB_BAR_MARGIN,
  TAB_BAR_MINIMIZE_SPRING,
  TAB_BAR_ROW_PAD_H,
  TAB_BAR_SLIDE_SPRING,
  boundaryTick,
  defineTabHapticPort,
  highlightProximity,
  minimumWindowWidth,
  mixTint,
  tabBarGeometry,
  tabIndexAtX,
  tabTintPalette,
  touchTargetFloor,
  type TabBarMetrics,
  type TabBarPlatform,
} from '@bob/ui';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WINDOW_WIDTH = 390;
const TAB_COUNT = 5;

// ── Doublons ────────────────────────────────────────────────────────────────────────────────

interface Mutable {
  value: number | boolean;
}

type Handler = (...args: never[]) => unknown;

const hoisted = vi.hoisted(() => ({
  shared: [] as { initial: unknown; box: { value: unknown } }[],
  gestures: {} as Record<string, Record<string, Handler>>,
  /** Cible ET configuration : un ressort se prouve par ses PARAMÈTRES, pas par son existence. */
  springs: [] as { target: number; config: unknown }[],
  /** Combien de fois le doublon de `GestureDetector` a été RENDU. Zéro est une information. */
  gestureDetectorRenders: { count: 0 },
  keyboardListeners: {} as Record<string, (() => void)[]>,
  isReduceMotionEnabled: vi.fn<() => Promise<boolean>>(),
  isScreenReaderEnabled: vi.fn<() => Promise<boolean>>(),
  fontScale: { value: 1 },
  windowWidth: { value: 390 },
  platform: { value: 'ios' as 'ios' | 'android' },
}));

vi.mock('react-native', async () => {
  const react = await import('react');
  return {
    AccessibilityInfo: {
      isReduceMotionEnabled: () => hoisted.isReduceMotionEnabled(),
      isScreenReaderEnabled: () => hoisted.isScreenReaderEnabled(),
      // Consommée par `ProgressiveBlurBob` via `useTransparencyPreference` : la retombée est
      // rendue par la barre, son doublon fait donc partie du contrat de ce test.
      isReduceTransparencyEnabled: () => Promise.resolve(false),
      addEventListener: () => ({ remove: () => undefined }),
    },
    PixelRatio: { getFontScale: () => hoisted.fontScale.value },
    Platform: {
      get OS() {
        return hoisted.platform.value;
      },
      select: (spec: Record<string, unknown>) => spec[hoisted.platform.value],
    },
    Pressable: 'Pressable',
    StyleSheet: {
      absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
      create: (styles: unknown) => styles,
      flatten: (style: unknown) => style,
    },
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({
      width: hoisted.windowWidth.value,
      height: 844,
      scale: 3,
      fontScale: hoisted.fontScale.value,
    }),
    // `Animated` de React Native — consommé par d'autres composants du barrel `@bob/ui`
    // (`pressable-scale`, `fade-in`, `sheet`). Le doublon doit donc être complet, sinon le
    // barrel casse à l'import et aucun test ne collecte.
    Animated: {
      View: 'RNAnimated.View',
      Text: 'RNAnimated.Text',
      Value: class {
        setValue(): void {
          /* doublon : aucune valeur à propager */
        }
      },
      timing: () => ({ start: () => undefined }),
      spring: () => ({ start: () => undefined }),
      parallel: () => ({ start: () => undefined }),
      sequence: () => ({ start: () => undefined }),
      loop: () => ({ start: () => undefined, stop: () => undefined }),
      createAnimatedComponent: (component: unknown) => `RNAnimated(${String(component)})`,
    },
    Modal: 'Modal',
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
    Easing: { bezier: () => 'easing', inOut: () => 'easing', ease: 'ease', out: () => 'easing' },
    Dimensions: { get: () => ({ width: hoisted.windowWidth.value, height: 844 }) },
    // Le doublon MÉMORISE les abonnés : sans cela on ne pourrait pas ouvrir le clavier, donc
    // pas prouver que la barre se retire. Un doublon qui jette ses arguments ne prouve rien.
    Keyboard: {
      addListener: (event: string, handler: () => void) => {
        (hoisted.keyboardListeners[event] ??= []).push(handler);
        return {
          remove: () => {
            const list = hoisted.keyboardListeners[event] ?? [];
            const at = list.indexOf(handler);
            if (at >= 0) list.splice(at, 1);
          },
        };
      },
    },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    // Utilisé par `react-test-renderer` via `react-native` dans certains chemins de rendu.
    createElement: react.createElement,
  };
});

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

// `react-native-svg` atteint le VRAI `react-native` (Flow) s'il n'est pas doublé : plusieurs
// composants du barrel `@bob/ui` l'importent, et le barrel est chargé en entier.
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Svg: 'Svg',
  Path: 'Path',
  Circle: 'Circle',
  Rect: 'Rect',
  G: 'G',
  Defs: 'Defs',
  LinearGradient: 'SvgLinearGradient',
  RadialGradient: 'RadialGradient',
  Stop: 'Stop',
  ClipPath: 'ClipPath',
  Mask: 'Mask',
  Line: 'Line',
  Polyline: 'Polyline',
  Polygon: 'Polygon',
  Text: 'SvgText',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('react-native-worklets', () => ({
  // Un worklet qui planifie du JS : on l'exécute tout de suite, c'est ce que le test veut voir.
  scheduleOnRN: (fn: (...args: never[]) => unknown, ...args: never[]) => fn(...args),
}));

/**
 * ─── LE DOUBLON QUI A COÛTÉ UN TEST TAUTOLOGIQUE ────────────────────────────────────────────
 *
 * La rédaction précédente écrivait `GestureDetector: ({ children }) => children`. C'est un
 * composant COMPOSITE, et `react-test-renderer.toJSON()` n'émet QUE des composants HÔTES : aucun
 * nœud du JSON ne pouvait donc porter la prop `gesture`, et l'assertion
 * `nodes(...).filter(n => n.props['gesture'] !== undefined)` rendait `[]` **dans tous les cas** —
 * détecteur monté ou non. Le test le plus dur de la suite ne pouvait pas échouer.
 *
 * Ici le doublon rend un nœud HÔTE (`'GestureDetector'`, une chaîne) qui porte un marqueur
 * `testID`, ET incrémente un compteur de rendus. Deux moyens indépendants d'observer la même
 * chose : l'ARBRE et l'APPEL. Retirer la garde `scrubAllowed(...)` du composant fait rougir les
 * deux — c'est vérifié, pas supposé.
 */
vi.mock('react-native-gesture-handler', async () => {
  const react = await import('react');
  const build = (kind: string): Record<string, unknown> => {
    const handlers: Record<string, Handler> = {};
    hoisted.gestures[kind] = handlers;
    const record = (name: string) => (fn: Handler) => {
      handlers[name] = fn;
      return builder;
    };
    const passthrough = () => builder;
    const builder: Record<string, unknown> = {
      activeOffsetX: passthrough,
      failOffsetY: passthrough,
      maxDistance: passthrough,
      maxDuration: passthrough,
      onStart: record('onStart'),
      onUpdate: record('onUpdate'),
      onFinalize: record('onFinalize'),
      onEnd: record('onEnd'),
    };
    return builder;
  };
  return {
    Gesture: {
      Pan: () => build('pan'),
      Tap: () => build('tap'),
      Race: (...gestures: unknown[]) => ({ race: gestures }),
    },
    GestureDetector: ({ children }: { children: ReactNode }) => {
      hoisted.gestureDetectorRenders.count += 1;
      return react.createElement('GestureDetector', { testID: 'gesture-detector' }, children);
    },
  };
});

/** Marqueur du détecteur dans l'arbre RENDU — un nœud hôte, donc réellement observable. */
const GESTURE_DETECTOR_TESTID = 'gesture-detector';

vi.mock('react-native-reanimated', async () => {
  const react = await import('react');
  const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), high);
  const interpolate = (
    input: number,
    inputRange: readonly number[],
    outputRange: readonly number[],
  ): number => {
    const [i0 = 0, i1 = 1] = inputRange;
    const [o0 = 0, o1 = 0] = outputRange;
    const t = clamp((input - i0) / (i1 - i0), 0, 1);
    return o0 + (o1 - o0) * t;
  };
  const animated = {
    View: 'Animated.View',
    Text: 'Animated.Text',
    createAnimatedComponent: (component: unknown) => `Animated(${String(component)})`,
  };
  return {
    // Défaut ET niveau supérieur : selon l'interop appliquée au module transformé, `import
    // Animated from` peut recevoir l'un ou l'autre. On sert les deux, plutôt que de parier.
    default: animated,
    ...animated,
    Easing: { bezier: () => 'easing.enter' },
    Extrapolation: { CLAMP: 'clamp' },
    interpolate,
    interpolateColor: (
      input: number,
      inputRange: readonly number[],
      outputRange: readonly string[],
    ): string => {
      const [from = '#000000', to = '#000000'] = outputRange;
      const [i0 = 0, i1 = 1] = inputRange;
      return mixTint(from, to, clamp((input - i0) / (i1 - i0), 0, 1));
    },
    // L'updater est APPELÉ au rendu : le style présent dans l'arbre est la sortie du worklet.
    useAnimatedStyle: (updater: () => unknown) => updater(),
    useSharedValue: (initial: unknown) => {
      const box = react.useRef({ value: initial });
      const registered = react.useRef(false);
      if (!registered.current) {
        registered.current = true;
        hoisted.shared.push({ initial, box: box.current });
      }
      return box.current;
    },
    useAnimatedScrollHandler: (handlers: unknown) => handlers,
    // La CONFIG est enregistrée avec la cible : « un ressort est parti » ne prouve rien tant
    // qu'on ne sait pas lequel. Les deux ressorts du lot ont des paramètres DIFFÉRENTS et c'est
    // ce qui les distingue — 420 ms sous-amorti pour le highlight, 380 ms critique pour le repli.
    withSpring: (target: number, config: unknown) => {
      hoisted.springs.push({ target, config });
      return target;
    },
    withTiming: (target: number) => target,
  };
});

const { BobTabBar } = await import('./bob-tab-bar');

// ── Outils d'inspection d'arbre ─────────────────────────────────────────────────────────────

interface Node {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly Node[] | null;
}

/**
 * Aplatit l'arbre rendu. Les nœuds TEXTE sont des chaînes, pas des objets : les laisser passer
 * ferait planter toute lecture de `props` — c'est le premier piège de ce genre d'inspection.
 */
function flatten(node: unknown): readonly Node[] {
  if (node === null || node === undefined) return [];
  if (Array.isArray(node)) return node.flatMap((child) => flatten(child));
  if (typeof node !== 'object') return [];
  const single = node as Node;
  return [single, ...flatten(single.children ?? null)];
}

function nodes(renderer: ReactTestRenderer): readonly Node[] {
  return flatten(renderer.toJSON() as unknown as Node);
}

function byTestID(renderer: ReactTestRenderer, id: string): Node | undefined {
  return nodes(renderer).find((node) => node.props['testID'] === id);
}

function styleOf(node: Node | undefined): Record<string, unknown> {
  const raw = node?.props['style'];
  const list = Array.isArray(raw) ? raw : [raw];
  return Object.assign({}, ...list.filter((entry) => entry && typeof entry === 'object')) as Record<
    string,
    unknown
  >;
}

/**
 * Retire commentaires de bloc et de ligne — les contrôles statiques portent sur le CODE.
 *
 * ─── LA TAUTOLOGIE QUI GUETTE TOUS LES CONTRÔLES STATIQUES ─────────────────────────────────
 * Les quatre tests qui écrivent `expect(source).not.toMatch(...)` sont VERTS quand ils ne
 * trouvent rien. Si cette fonction rendait une chaîne vide — un `replace` trop gourmand, un
 * fichier renommé, une lecture qui échoue en silence — les quatre resteraient verts pour
 * toujours, en ne regardant plus rien. Le témoin ci-dessous l'interdit : on exige que le CODE
 * survive au dépouillement, et pas seulement les commentaires.
 */
function stripComments(source: string): string {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return stripped;
}

/** Le fichier dépouillé, plus son témoin de non-vacuité. Les contrôles statiques passent par ici. */
function strippedSource(file: string): string {
  const stripped = stripComments(readFileSync(join(__dirname, file), 'utf8'));
  // Trois marqueurs de CODE, pas de prose : si le dépouillement a mangé le fichier, on le sait
  // avant de conclure qu'il ne contient pas de `hitSlop`.
  expect(stripped, `${file} : dépouillement vide`).toMatch(/export function BobTabBar/);
  expect(stripped).toMatch(/useAnimatedStyle/);
  expect(stripped.length).toBeGreaterThan(4000);
  return stripped;
}

const ITEMS = [
  { key: 'index', label: "Aujourd'hui", icon: () => createElement('Glyph', { name: 'sunrise' }) },
  { key: 'clients', label: 'Clients', icon: () => createElement('Glyph', { name: 'people' }) },
  { key: 'argent', label: 'Argent', icon: () => createElement('Glyph', { name: 'wallet' }) },
  { key: 'documents', label: 'Documents', icon: () => createElement('Glyph', { name: 'folder' }) },
  { key: 'assistant', label: 'Assistant', icon: () => createElement('Glyph', { name: 'spark' }) },
];

const METRICS: TabBarMetrics = { platform: 'ios', windowWidth: WINDOW_WIDTH, tabCount: TAB_COUNT };

interface Harness {
  readonly renderer: ReactTestRenderer;
  readonly progress: Mutable;
  /** Cible du ressort : c'est ELLE qui rend `setMinimized` no-op quand on y va déjà. */
  readonly target: Mutable;
  readonly slideIndex: Mutable;
  readonly selected: string[];
  /** Ticks RÉELLEMENT joués par le port haptique injecté — pas une simulation du test. */
  readonly ticks: string[];
  setProgress(value: number): void;
  refresh(): Promise<void>;
}

interface MountOptions {
  activeKey?: string;
  screenReaderActive?: boolean;
  reduceMotion?: boolean;
  /** Injecte un port haptique SCELLÉ. Absent = le rang normal du dépôt (pas de tick). */
  haptics?: boolean;
}

async function mount(options: MountOptions = {}): Promise<Harness> {
  hoisted.shared.length = 0;
  hoisted.springs.length = 0;
  hoisted.gestureDetectorRenders.count = 0;
  hoisted.isReduceMotionEnabled.mockResolvedValue(options.reduceMotion ?? false);
  hoisted.isScreenReaderEnabled.mockResolvedValue(options.screenReaderActive ?? false);
  const activeKey = options.activeKey ?? 'argent';
  const selected: string[] = [];
  const ticks: string[] = [];
  const hapticPort =
    options.haptics === true ? defineTabHapticPort((kind) => ticks.push(kind)) : undefined;
  let renderer: ReactTestRenderer | undefined;
  /*
   * UN ÉLÉMENT NEUF À CHAQUE RENDU. `root.render(memeElement)` fait BAILLER React : l'identité
   * d'élément suffit à sauter le sous-arbre, et la valeur partagée qu'on vient de pousser ne
   * serait jamais relue. Le test verrait alors des styles périmés et validerait le vide.
   */
  const element = (): ReturnType<typeof createElement> =>
    createElement(
      ThemeProvider,
      null,
      createElement(BobTabBar, {
        items: ITEMS,
        activeKey,
        onSelect: (key: string) => selected.push(key),
        ...(hapticPort === undefined ? {} : { hapticPort }),
        testID: 'bar',
      }),
    );
  await act(async () => {
    renderer = create(element());
  });
  const tree = renderer as ReactTestRenderer;
  // Les trois premières valeurs partagées sont celles du repli (`progress`, `target`,
  // `animated`) ; la quatrième est `slideIndex`. On le VÉRIFIE plutôt que de le supposer.
  const progress = hoisted.shared[0]?.box as unknown as Mutable;
  const target = hoisted.shared[1]?.box as unknown as Mutable;
  const slideIndex = hoisted.shared[3]?.box as unknown as Mutable;
  expect(hoisted.shared[0]?.initial).toBe(0);
  expect(hoisted.shared[3]?.initial).toBe(ITEMS.findIndex((item) => item.key === activeKey));
  return {
    renderer: tree,
    progress,
    target,
    slideIndex,
    selected,
    ticks,
    setProgress: (value: number) => {
      progress.value = value;
      target.value = value >= 0.5 ? 1 : 0;
    },
    refresh: async () => {
      await act(async () => {
        tree.update(element());
      });
    },
  };
}

beforeEach(() => {
  hoisted.gestures = {};
  hoisted.fontScale.value = 1;
  hoisted.windowWidth.value = WINDOW_WIDTH;
  hoisted.platform.value = 'ios';
  hoisted.keyboardListeners = {};
  hoisted.gestureDetectorRenders.count = 0;
});

/** Ouvre ou ferme le clavier logiciel, comme l'OS le ferait. */
async function fireKeyboard(event: string): Promise<void> {
  await act(async () => {
    for (const handler of hoisted.keyboardListeners[event] ?? []) handler();
  });
}

/**
 * Renseigne les sondes de label : c'est ce qui donne à la barre ses HAUTEURS DE CONTENU. Sans
 * cette étape, la géométrie reste à ses planchers de taille standard.
 */
async function feedProbes(
  harness: Harness,
  layout: { width: number; height: number },
): Promise<void> {
  await feedProbesSplit(harness, layout, layout);
}

/**
 * Même chose, mais en distinguant les deux familles de sondes : les `n` premières mesurent le
 * label ENTIER, les `n` suivantes son MOT LE PLUS LONG. L'ordre est celui des deux `items.map`
 * de `LabelProbes` et il est VÉRIFIÉ ici (`toHaveLength(2 × n)`) avant d'être exploité —
 * distinguer les sondes par la longueur de leur texte serait une heuristique, donc un piège.
 */
async function feedProbesSplit(
  harness: Harness,
  natural: { width: number; height: number },
  longestWord: { width: number; height: number },
): Promise<void> {
  const probes = flatten(byTestID(harness.renderer, 'bob-tab-bar-label-probes') ?? null).filter(
    (node) => node.type === 'Text',
  );
  expect(probes).toHaveLength(ITEMS.length * 2);
  await act(async () => {
    probes.forEach((probe, at) => {
      const onLayout = probe.props['onLayout'] as (event: {
        nativeEvent: { layout: { width: number; height: number } };
      }) => void;
      onLayout({ nativeEvent: { layout: at < ITEMS.length ? natural : longestWord } });
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════

describe('1 · minimize-on-scroll — les worklets rendent EXACTEMENT la géométrie normative', () => {
  it('la pilule suit `tabBarGeometry()` sur toute la course échantillonnée, pas aux deux bouts', async () => {
    const harness = await mount();
    for (const p of [0, 0.1, 0.25, 0.4, 0.5, 0.75, 0.9, 1]) {
      harness.setProgress(p);
      await harness.refresh();
      const expected = tabBarGeometry(p, METRICS);
      const pill = styleOf(byTestID(harness.renderer, 'bar-pill'));
      expect(pill['height']).toBeCloseTo(expected.pillMeasuredHeight, 10);
      expect(pill['borderRadius']).toBeCloseTo(expected.pillMeasuredHeight / 2, 10);
      expect(pill['marginHorizontal']).toBeCloseTo(expected.sideInset, 10);
    }
  });

  it('la cible tactile mesurée ne descend JAMAIS sous le plancher, à tout instant', async () => {
    const harness = await mount();
    for (let i = 0; i <= 20; i += 1) {
      harness.setProgress(i / 20);
      await harness.refresh();
      const expected = tabBarGeometry(i / 20, METRICS);
      for (const item of ITEMS) {
        const pressable = styleOf(byTestID(harness.renderer, `bar-tab-${item.key}`));
        expect(pressable['height']).toBeCloseTo(expected.pressableHeight, 10);
        expect(pressable['height'] as number).toBeGreaterThanOrEqual(44);
      }
    }
  });

  it('le VISUEL intérieur descend à 35 pt alors que la cible reste à 44 — il est dessiné DEDANS', async () => {
    const harness = await mount();
    harness.setProgress(1);
    await harness.refresh();
    const pressable = styleOf(byTestID(harness.renderer, 'bar-tab-argent'));
    expect(pressable['height']).toBe(44);
    // Le visuel est le premier enfant du `Pressable` : sa hauteur est animée explicitement.
    const tab = byTestID(harness.renderer, 'bar-tab-argent');
    const visual = styleOf(tab?.children?.[0]);
    expect(visual['height']).toBe(35);
  });

  it('le rythme EXTÉRIEUR s’anime de 4 à 0 — c’est lui qui bouge, jamais la cible', async () => {
    const harness = await mount();
    const row = () =>
      nodes(harness.renderer).find(
        (node) => styleOf(node)['flexDirection'] === 'row' && 'paddingVertical' in styleOf(node),
      );
    expect(styleOf(row())['paddingVertical']).toBe(4);
    harness.setProgress(1);
    await harness.refresh();
    expect(styleOf(row())['paddingVertical']).toBe(0);
  });
});

/**
 * B1 — LA LARGEUR EST UNE CIBLE, PAS UNE DIVISION.
 *
 * Le critère d'acceptation n° 1 du socle exige `height ≥ CIBLE` **ET** `width ≥ CIBLE` sur les
 * cinq `Pressable`. La construction ne plancherait que la HAUTEUR : la largeur était
 * `(fenêtre − 102) / 5`, et le retrait latéral animé de 34 pt par côté la faisait tomber sous
 * la cible dès 320 pt.
 *
 * ─── COMMENT LA PREUVE SE PARTAGE, ET POURQUOI ────────────────────────────────────────────
 * Le balayage DENSE — 101 points de la course × 8 largeurs réelles × 2 OS — vit dans le test de
 * LOGIQUE PURE (`bob-tab-bar.logic.test.ts`), où il coûte quelques millisecondes. Le monter ici
 * demanderait 1 616 rendus complets et rendrait la suite instable par expiration de délai : un
 * test lent devient un test qu'on désactive. Ce fichier-ci prouve l'autre maillon, celui que la
 * logique ne peut pas prouver : que le COMPOSANT calcule la même largeur que la fonction
 * normative, sur les largeurs les plus serrées et aux trois points où le clamp mord.
 *
 * LA LARGEUR LUE EST CELLE DU HIGHLIGHT, et c'est légitime : le `Pressable` est `flex: 1` dans
 * une rangée de largeur `contentWidth`, donc sa largeur mesurée vaut `contentWidth / 5` — la
 * même expression, au même instant, que celle que le worklet du highlight écrit. Aucune autre
 * largeur d'onglet n'existe dans l'arbre rendu : `flex: 1` ne pose pas de `width`.
 */
describe('1bis · la LARGEUR de la cible, plancherée sur les écrans réels les plus étroits', () => {
  /** Les trois largeurs où le clamp MORD : couverture de pliable, petit téléphone, Android médian. */
  const TIGHT_WIDTHS = [280, 320, 360];

  for (const platform of ['ios', 'android'] as TabBarPlatform[]) {
    it(`sur ${platform}, le RENDU tient la cible dans les DEUX dimensions sur les écrans serrés`, async () => {
      hoisted.platform.value = platform;
      const floor = touchTargetFloor(platform);
      for (const width of TIGHT_WIDTHS) {
        hoisted.windowWidth.value = width;
        const harness = await mount();
        for (const p of [0, 0.5, 1]) {
          harness.setProgress(p);
          await harness.refresh();
          const where = `${platform} ${width}pt @ ${p}`;
          const expected = tabBarGeometry(p, { platform, windowWidth: width, tabCount: TAB_COUNT });
          const rendered = styleOf(byTestID(harness.renderer, 'bar-highlight'))['width'] as number;
          // Le composant calcule EXACTEMENT la largeur normative…
          expect(rendered, where).toBeCloseTo(expected.itemWidth, 10);
          // … et cette largeur tient la cible.
          expect(rendered, where).toBeGreaterThanOrEqual(floor - 1e-9);
          expect(expected.touchWidthHeld, where).toBe(true);
          // La HAUTEUR reste plancherée en même temps : les deux moitiés du critère, ensemble.
          for (const item of ITEMS) {
            const pressable = styleOf(byTestID(harness.renderer, `bar-tab-${item.key}`));
            expect(pressable['height'] as number, `${where} ${item.key}`).toBeGreaterThanOrEqual(
              floor,
            );
          }
        }
      }
    });
  }

  it('CE QUI CÈDE est le retrait latéral, et rien d’autre', async () => {
    // Écran large : le retrait vaut exactement les 34 pt du socle.
    hoisted.windowWidth.value = 390;
    let harness = await mount();
    harness.setProgress(1);
    await harness.refresh();
    expect(styleOf(byTestID(harness.renderer, 'bar-pill'))['marginHorizontal']).toBe(34);

    // Écran étroit : il est RABOTÉ, et c'est visible dans le style rendu — pas déduit.
    hoisted.windowWidth.value = 320;
    harness = await mount();
    harness.setProgress(1);
    await harness.refresh();
    const inset = styleOf(byTestID(harness.renderer, 'bar-pill'))['marginHorizontal'] as number;
    expect(inset).toBeLessThan(34);
    expect(inset).toBeGreaterThan(0);
    // La barre se replie MOINS, mais les cinq cibles tiennent : c'est le troc assumé.
    expect(tabBarGeometry(1, { platform: 'ios', windowWidth: 320, tabCount: 5 }).itemWidth)
      .toBeGreaterThanOrEqual(44 - 1e-9);
  });

  it('le mapping du doigt lit le retrait EFFECTIF, pas la constante du socle', async () => {
    // Sur un écran étroit, un mapping qui garderait 34 pt serait décalé exactement là où la
    // barre est la plus serrée — le pire endroit possible.
    hoisted.windowWidth.value = 320;
    const harness = await mount();
    harness.setProgress(1);
    await harness.refresh();
    const geometry = tabBarGeometry(1, { platform: 'ios', windowWidth: 320, tabCount: TAB_COUNT });
    const onUpdate = hoisted.gestures['pan']?.['onUpdate'] as (event: { x: number }) => void;
    const contentLeft = TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H;
    for (const factor of [0.5, 2.5, 4.5]) {
      onUpdate({ x: contentLeft + geometry.itemWidth * factor });
      expect(harness.slideIndex.value as number).toBeCloseTo(
        tabIndexAtX(contentLeft + geometry.itemWidth * factor, geometry, TAB_COUNT),
        10,
      );
    }
  });

  it('DÉCLARE la limite résiduelle au lieu de la subir', () => {
    // Sous ce seuil, même un retrait NUL ne tient plus : la barre n'a plus rien à céder, et elle
    // le DIT. Aucun téléphone visé ne s'y trouve — c'est plus étroit que tout écran du parc.
    expect(minimumWindowWidth('ios', 5)).toBe(254);
    expect(minimumWindowWidth('android', 5)).toBe(274);
    expect(tabBarGeometry(1, { platform: 'android', windowWidth: 260, tabCount: 5 }).touchWidthHeld)
      .toBe(false);
    expect(tabBarGeometry(1, { platform: 'android', windowWidth: 280, tabCount: 5 }).touchWidthHeld)
      .toBe(true);
  });
});

describe('2 · highlight glissant — un seul bloc, transform-only, suivi live du repli', () => {
  it('le nœud qui VOYAGE ne porte QUE `transform` — « transform-only » au sens strict', async () => {
    const harness = await mount();
    harness.slideIndex.value = 2;
    await harness.refresh();
    // Le style du nœud de voyage est lu par sa POSITION dans le tableau de styles : la première
    // entrée est statique (`position`, `left`, `top`), la seconde est la sortie du worklet.
    const travel = byTestID(harness.renderer, 'bar-highlight-travel');
    const animated = (travel?.props['style'] as Record<string, unknown>[])[1] ?? {};
    // Si un jour quelqu'un remet `height` ou `width` ici, ce test rougit — et c'est le but.
    expect(Object.keys(animated)).toEqual(['transform']);
  });

  it('se déplace par `translateX` seul et suit la largeur d’item calculée', async () => {
    const harness = await mount();
    for (const index of [0, 2, 4, 1.5]) {
      harness.slideIndex.value = index;
      await harness.refresh();
      const travel = styleOf(byTestID(harness.renderer, 'bar-highlight-travel'));
      const style = styleOf(byTestID(harness.renderer, 'bar-highlight'));
      const expected = tabBarGeometry(harness.progress.value as number, METRICS);
      const transform = travel['transform'] as { translateX: number }[];
      expect(transform).toEqual([
        { translateX: TAB_BAR_ROW_PAD_H + expected.itemWidth * index },
      ]);
      expect(style['width']).toBeCloseTo(expected.itemWidth, 10);
      // Rien d'autre ne bouge horizontalement : ni `left`, ni `marginLeft`.
      expect(travel['left']).toBe(0);
      expect(style['marginLeft']).toBeUndefined();
    }
  });

  it('suit la barre PENDANT qu’elle se replie — la géométrie est recalculée live', async () => {
    const harness = await mount();
    harness.slideIndex.value = 4;
    harness.setProgress(0);
    await harness.refresh();
    const open = styleOf(byTestID(harness.renderer, 'bar-highlight'));
    const openTravel = styleOf(byTestID(harness.renderer, 'bar-highlight-travel'));
    harness.setProgress(1);
    await harness.refresh();
    const closed = styleOf(byTestID(harness.renderer, 'bar-highlight'));
    const closedTravel = styleOf(byTestID(harness.renderer, 'bar-highlight-travel'));
    expect(closed['width'] as number).toBeLessThan(open['width'] as number);
    expect(closedTravel['transform']).not.toEqual(openTravel['transform']);
  });

  it('reste CENTRÉ dans la boîte intérieure de la pilule, à tout instant', async () => {
    const harness = await mount();
    for (const p of [0, 0.5, 1]) {
      harness.setProgress(p);
      await harness.refresh();
      const expected = tabBarGeometry(p, METRICS);
      const style = styleOf(byTestID(harness.renderer, 'bar-highlight'));
      expect(style['height']).toBeCloseTo(expected.innerVisualHeight, 10);
      expect(style['marginTop']).toBeCloseTo(
        (expected.pillInnerHeight - expected.innerVisualHeight) / 2,
        10,
      );
    }
  });
});

/**
 * LES RESSORTS SONT LA SIGNATURE DU LOT, et rien ne les prouvait : le doublon poussait sa cible
 * dans un tableau, et aucune assertion ne disait avec QUELS PARAMÈTRES ni À QUEL MOMENT. Un
 * `withTiming` aurait passé tous les tests précédents.
 */
describe('les ressorts — lesquels partent, avec quels paramètres, et à quel moment', () => {
  it('le TAP lance le ressort du HIGHLIGHT, 420 ms sous-amorti — pas celui du repli', async () => {
    const harness = await mount({ activeKey: 'index' });
    hoisted.springs.length = 0;
    const geometry = tabBarGeometry(0, METRICS);
    const onEnd = hoisted.gestures['tap']?.['onEnd'] as (
      event: { x: number },
      success: boolean,
    ) => void;
    onEnd({ x: TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H + geometry.itemWidth * 2.5 }, true);
    expect(hoisted.springs).toHaveLength(1);
    expect(hoisted.springs[0]?.target).toBe(2);
    expect(hoisted.springs[0]?.config).toBe(TAB_BAR_SLIDE_SPRING);
    expect(hoisted.springs[0]?.config).toEqual({ duration: 420, dampingRatio: 0.82 });
    void harness;
  });

  it('le RELÂCHEMENT du scrub recale au ressort du highlight, sur l’index ARRONDI', async () => {
    const harness = await mount({ activeKey: 'index' });
    const geometry = tabBarGeometry(0, METRICS);
    const contentLeft = TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H;
    (hoisted.gestures['pan']?.['onStart'] as () => void)();
    (hoisted.gestures['pan']?.['onUpdate'] as (e: { x: number }) => void)({
      x: contentLeft + geometry.itemWidth * 3.7,
    });
    hoisted.springs.length = 0;
    (hoisted.gestures['pan']?.['onFinalize'] as () => void)();
    expect(hoisted.springs).toHaveLength(1);
    // 3,7 − 0,5 = 3,2 → arrondi 3. Le ressort part vers un ENTIER, jamais vers la position brute.
    expect(hoisted.springs[0]?.target).toBe(3);
    expect(hoisted.springs[0]?.config).toBe(TAB_BAR_SLIDE_SPRING);
    expect(harness.selected).toEqual(['documents']);
  });

  it('le SCRUB ne lance AUCUN ressort pendant le drag — le doigt est propriétaire', async () => {
    await mount({ activeKey: 'index' });
    const geometry = tabBarGeometry(0, METRICS);
    const contentLeft = TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H;
    (hoisted.gestures['pan']?.['onStart'] as () => void)();
    hoisted.springs.length = 0;
    for (let step = 0; step <= 30; step += 1) {
      (hoisted.gestures['pan']?.['onUpdate'] as (e: { x: number }) => void)({
        x: contentLeft + geometry.itemWidth * (0.5 + step * 0.13),
      });
    }
    // Un ressort ici rendrait l'indicateur mou et en retard sur le doigt : mapping 1:1 STRICT.
    expect(hoisted.springs).toEqual([]);
  });

  it('la RÉ-EXPANSION au tap lance le ressort du REPLI, 380 ms critique-amorti', async () => {
    const harness = await mount({ activeKey: 'index' });
    harness.setProgress(1);
    hoisted.springs.length = 0;
    const geometry = tabBarGeometry(1, METRICS);
    const onEnd = hoisted.gestures['tap']?.['onEnd'] as (
      event: { x: number },
      success: boolean,
    ) => void;
    onEnd({ x: TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H + geometry.itemWidth * 2.5 }, true);
    const minimizeSprings = hoisted.springs.filter(
      (spring) => spring.config === TAB_BAR_MINIMIZE_SPRING,
    );
    expect(minimizeSprings).toHaveLength(1);
    expect(minimizeSprings[0]?.target).toBe(0);
    expect(minimizeSprings[0]?.config).toEqual({ duration: 380, dampingRatio: 1 });
  });

  it('la NAVIGATION PROGRAMMATIQUE fait VOYAGER le highlight — elle ne le fait pas sauter', async () => {
    // Deep link, geste de retour, action Bob à la voix : le même chemin.
    const harness = await mount({ activeKey: 'index' });
    hoisted.springs.length = 0;
    await act(async () => {
      harness.renderer.update(
        createElement(
          ThemeProvider,
          null,
          createElement(BobTabBar, {
            items: ITEMS,
            activeKey: 'assistant',
            onSelect: () => undefined,
            testID: 'bar',
          }),
        ),
      );
    });
    expect(hoisted.springs).toHaveLength(1);
    expect(hoisted.springs[0]?.target).toBe(4);
    expect(hoisted.springs[0]?.config).toBe(TAB_BAR_SLIDE_SPRING);
  });

  it('sous Reduce Motion, la position est POSÉE — aucun ressort, jamais', async () => {
    const harness = await mount({ activeKey: 'index', reduceMotion: true });
    hoisted.springs.length = 0;
    const geometry = tabBarGeometry(0, METRICS);
    const onEnd = hoisted.gestures['tap']?.['onEnd'] as (
      event: { x: number },
      success: boolean,
    ) => void;
    onEnd({ x: TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H + geometry.itemWidth * 2.5 }, true);
    expect(hoisted.springs).toEqual([]);
    // Mais la sélection, elle, a bien eu lieu : réduire le mouvement ne retire aucune fonction.
    expect(harness.selected).toEqual(['argent']);
    expect(harness.slideIndex.value).toBe(2);
  });
});

describe('3 · scrub — le worklet de geste, exécuté', () => {
  it('mappe le doigt 1:1 sur la MÊME formule que `tabIndexAtX`', async () => {
    const harness = await mount();
    const onUpdate = hoisted.gestures['pan']?.['onUpdate'];
    expect(onUpdate).toBeTypeOf('function');
    const geometry = tabBarGeometry(0, METRICS);
    const contentLeft = TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H;
    for (const factor of [0.5, 1.5, 2.2, 3.9, 4.5]) {
      const x = contentLeft + geometry.itemWidth * factor;
      (onUpdate as (event: { x: number }) => void)({ x });
      expect(harness.slideIndex.value as number).toBeCloseTo(
        tabIndexAtX(x, geometry, TAB_COUNT),
        10,
      );
    }
  });

  /**
   * CE TEST ÉTAIT TAUTOLOGIQUE, et c'est réparé ici. Sa rédaction précédente construisait le
   * tableau `ticks` **elle-même**, à partir de `boundaryTick(...)` calculé DANS le test : elle
   * vérifiait donc `boundaryTick` ∘ `tabIndexAtX`, deux fonctions pures déjà testées ailleurs, et
   * restait verte même si le composant n'avait jamais appelé son port haptique. Le tick n'était
   * verrouillé par AUCUN test au niveau du RENDU.
   *
   * Ici, un port haptique SCELLÉ est injecté dans la barre et l'on compte les ticks qu'il a
   * RÉELLEMENT reçus. La spécification pure sert de RÉFÉRENCE attendue, plus de source.
   */
  it('ne tick QU’au franchissement de frontière — ticks RÉELLEMENT joués par le port', async () => {
    const harness = await mount({ activeKey: 'index', haptics: true });
    const onStart = hoisted.gestures['pan']?.['onStart'] as (() => void) | undefined;
    const onUpdate = hoisted.gestures['pan']?.['onUpdate'] as
      | ((event: { x: number }) => void)
      | undefined;
    onStart?.();
    const geometry = tabBarGeometry(0, METRICS);
    const contentLeft = TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H;
    let lastTicked = 0;
    const expectedTicks: number[] = [];
    for (let step = 0; step <= 60; step += 1) {
      const factor = 0.5 + (step / 60) * (TAB_COUNT - 1);
      const x = contentLeft + geometry.itemWidth * factor;
      onUpdate?.({ x });
      const boundary = boundaryTick(lastTicked, tabIndexAtX(x, geometry, TAB_COUNT));
      if (boundary !== null) {
        expectedTicks.push(boundary);
        lastTicked = boundary;
      }
    }
    // Un balayage d'un bout à l'autre franchit exactement quatre frontières…
    expect(expectedTicks).toEqual([1, 2, 3, 4]);
    // … et le port en a reçu EXACTEMENT autant. Soixante-et-une frames, quatre ticks.
    expect(harness.ticks).toHaveLength(4);
    expect(harness.ticks).toEqual(['selection', 'selection', 'selection', 'selection']);
  });

  it('ne tick PAS quand le doigt bouge SANS franchir de frontière', async () => {
    const harness = await mount({ activeKey: 'index', haptics: true });
    const onStart = hoisted.gestures['pan']?.['onStart'] as () => void;
    const onUpdate = hoisted.gestures['pan']?.['onUpdate'] as (event: { x: number }) => void;
    onStart();
    const geometry = tabBarGeometry(0, METRICS);
    const contentLeft = TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H;
    // Vingt frames à l'intérieur du MÊME onglet : c'est le cas que la garde `lastTicked` existe
    // pour couvrir, et le seul qui distingue « tick au franchissement » de « tick par frame ».
    for (let step = 0; step <= 20; step += 1) {
      onUpdate({ x: contentLeft + geometry.itemWidth * (0.5 + step * 0.02) });
    }
    expect(harness.ticks).toEqual([]);
  });

  it('ne tick JAMAIS sans port — le rang normal du dépôt, et il ne lève pas', async () => {
    const harness = await mount({ activeKey: 'index' });
    const onStart = hoisted.gestures['pan']?.['onStart'] as () => void;
    const onUpdate = hoisted.gestures['pan']?.['onUpdate'] as (event: { x: number }) => void;
    onStart();
    const geometry = tabBarGeometry(0, METRICS);
    const contentLeft = TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H;
    for (const factor of [0.5, 1.5, 2.5, 3.5, 4.5]) {
      expect(() => onUpdate({ x: contentLeft + geometry.itemWidth * factor })).not.toThrow();
    }
    expect(harness.ticks).toEqual([]);
  });

  it('ne navigue QU’au relâchement, et jamais deux fois quand le pan a échoué', async () => {
    const harness = await mount({ activeKey: 'index' });
    const pan = hoisted.gestures['pan'] as Record<string, Handler>;
    const onUpdate = pan['onUpdate'] as (event: { x: number }) => void;
    const geometry = tabBarGeometry(0, METRICS);
    const contentLeft = TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H;

    (pan['onStart'] as () => void)();
    onUpdate({ x: contentLeft + geometry.itemWidth * 3.5 });
    // Rien n'a encore navigué : changer d'écran sous le doigt ferait sauter le contenu.
    expect(harness.selected).toEqual([]);
    (pan['onFinalize'] as () => void)();
    expect(harness.selected).toEqual(['documents']);

    // Second `onFinalize` sans `onStart` : le geste était un tap, la garde tient.
    (pan['onFinalize'] as () => void)();
    expect(harness.selected).toEqual(['documents']);
  });

  it('le tap sélectionne l’onglet sous le doigt et ré-étend la barre', async () => {
    const harness = await mount({ activeKey: 'index' });
    harness.setProgress(1);
    const geometry = tabBarGeometry(1, METRICS);
    const contentLeft = TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H;
    const onEnd = hoisted.gestures['tap']?.['onEnd'] as (
      event: { x: number },
      success: boolean,
    ) => void;
    onEnd({ x: contentLeft + geometry.itemWidth * 2.5 }, true);
    expect(harness.selected).toEqual(['argent']);
    // Ré-expansion forcée : toute interaction délibérée avec la barre la ré-étend.
    expect(harness.progress.value).toBe(0);
  });

  it('un tap qui échoue ne sélectionne rien', async () => {
    const harness = await mount({ activeKey: 'index' });
    const onEnd = hoisted.gestures['tap']?.['onEnd'] as (
      event: { x: number },
      success: boolean,
    ) => void;
    onEnd({ x: 100 }, false);
    expect(harness.selected).toEqual([]);
  });
});

describe('4 · flou de bord — la retombée du kit, déclarée AVANT le chrome', () => {
  it('est rendue et ne capte aucune touche', async () => {
    const harness = await mount();
    const falloff = byTestID(harness.renderer, 'bar-falloff');
    expect(falloff).toBeDefined();
    expect(falloff?.props['pointerEvents']).toBe('none');
  });

  it('est déclarée AVANT la pilule — l’ordre de peinture ne tient qu’à cela', async () => {
    const harness = await mount();
    const flat = nodes(harness.renderer);
    const falloffAt = flat.findIndex((node) => node.props['testID'] === 'bar-falloff');
    const pillAt = flat.findIndex((node) => node.props['testID'] === 'bar-pill');
    expect(falloffAt).toBeGreaterThanOrEqual(0);
    expect(pillAt).toBeGreaterThan(falloffAt);
  });

  it('n’est PAS réécrite : le composant du kit est consommé tel quel', () => {
    const source = readFileSync(join(__dirname, 'bob-tab-bar.tsx'), 'utf8');
    expect(source).toContain('ProgressiveBlurBob');
    expect(source).not.toContain('BlurView');
    expect(source).not.toContain('expo-blur');
  });
});

describe('6 · teinte pilotée par le highlight — mesurée sur la couleur rendue', () => {
  it('la couleur du label suit la DISTANCE au highlight, pas le focus', async () => {
    const harness = await mount({ activeKey: 'index' });
    const palette = tabTintPalette('light');
    const labelColor = (key: string): unknown => {
      const tab = byTestID(harness.renderer, `bar-tab-${key}`);
      const label = flatten(tab ?? null).find((node) => node.type === 'Animated.Text');
      return styleOf(label)['color'];
    };

    harness.slideIndex.value = 1.5;
    await harness.refresh();
    // À mi-course, DEUX onglets sont à mi-teinte — ce qu'un booléen de focus ne produit jamais.
    expect(labelColor('clients')).toBe(
      mixTint(palette.inactive, palette.active, highlightProximity(1.5, 1)),
    );
    expect(labelColor('argent')).toBe(
      mixTint(palette.inactive, palette.active, highlightProximity(1.5, 2)),
    );
    // Et l'onglet FOCUSÉ (index 0) est éteint, parce que le highlight n'est plus sur lui.
    expect(labelColor('index')).toBe(palette.inactive);
  });

  it('l’indigo de l’Assistant survit à l’interpolation', async () => {
    const harness = await mount({ activeKey: 'index' });
    const palette = tabTintPalette('light');
    harness.slideIndex.value = 4;
    await harness.refresh();
    const tab = byTestID(harness.renderer, 'bar-tab-assistant');
    const label = flatten(tab ?? null).find((node) => node.type === 'Animated.Text');
    expect(styleOf(label)['color']).toBe(palette.assistantActive);
  });

  it('monte DEUX glyphes par onglet, et les retire de l’arbre d’accessibilité', async () => {
    const harness = await mount();
    const tab = byTestID(harness.renderer, 'bar-tab-argent');
    const glyphs = flatten(tab ?? null).filter((node) => node.type === 'Glyph');
    expect(glyphs).toHaveLength(2);
    const holder = flatten(tab ?? null).find(
      (node) => node.props['importantForAccessibility'] === 'no-hide-descendants',
    );
    expect(holder).toBeDefined();
    expect(holder?.props['accessible']).toBe(false);
  });

  it('l’opacité du glyphe actif est la proximité, pas un booléen', async () => {
    const harness = await mount({ activeKey: 'index' });
    harness.slideIndex.value = 2.25;
    await harness.refresh();
    const tab = byTestID(harness.renderer, 'bar-tab-argent');
    const overlay = flatten(tab ?? null).find(
      (node) => node.type === 'Animated.View' && 'opacity' in styleOf(node),
    );
    expect(styleOf(overlay)['opacity']).toBeCloseTo(highlightProximity(2.25, 2), 10);
  });
});

describe('accessibilité — fail-closed, rôles, et scrub coupé sous lecteur d’écran', () => {
  /**
   * LE TÉMOIN DU TÉMOIN. Ces trois tests reposent tous sur la même observation — « le détecteur
   * est-il dans l'arbre ? ». Celui-ci prouve d'abord que cette observation VOIT quelque chose
   * quand le détecteur EST monté. Sans lui, les deux suivants pourraient être verts pour la
   * mauvaise raison, et c'est exactement ce qui s'était produit : le doublon rendait un composant
   * COMPOSITE, `toJSON()` n'émet que des HÔTES, et le filtre rendait `[]` dans tous les cas.
   */
  it('MONTE bien un détecteur quand le lecteur d’écran est connu et INACTIF', async () => {
    const harness = await mount();
    expect(byTestID(harness.renderer, GESTURE_DETECTOR_TESTID)).toBeDefined();
    expect(hoisted.gestureDetectorRenders.count).toBeGreaterThan(0);
    // Et il porte bien le geste construit par le composant, pas un objet vide.
    expect(hoisted.gestures['pan']?.['onUpdate']).toBeTypeOf('function');
  });

  it('ne monte AUCUN détecteur de geste tant que le lecteur d’écran est INCONNU', async () => {
    hoisted.shared.length = 0;
    hoisted.gestureDetectorRenders.count = 0;
    hoisted.isReduceMotionEnabled.mockReturnValue(new Promise(() => undefined));
    hoisted.isScreenReaderEnabled.mockReturnValue(new Promise(() => undefined));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        createElement(
          ThemeProvider,
          null,
          createElement(BobTabBar, {
            items: ITEMS,
            activeKey: 'argent',
            onSelect: () => undefined,
            testID: 'bar',
          }),
        ),
      );
    });
    // La pilule est là, les `Pressable` sont opérants — mais rien ne consomme les touches
    // d'exploration. L'état sûr est aussi l'état accessible.
    expect(byTestID(renderer as ReactTestRenderer, 'bar-pill')).toBeDefined();
    // DEUX observations indépendantes : l'ARBRE rendu, et le nombre d'APPELS du doublon.
    expect(byTestID(renderer as ReactTestRenderer, GESTURE_DETECTOR_TESTID)).toBeUndefined();
    expect(hoisted.gestureDetectorRenders.count).toBe(0);
  });

  it('ne monte AUCUN détecteur quand le lecteur d’écran est ACTIF', async () => {
    const harness = await mount({ screenReaderActive: true });
    expect(byTestID(harness.renderer, 'bar-pill')).toBeDefined();
    // L'assertion qui correspond au TITRE — elle manquait, et le test ne regardait que le
    // nombre d'onglets, vrai dans les deux cas.
    expect(byTestID(harness.renderer, GESTURE_DETECTOR_TESTID)).toBeUndefined();
    expect(hoisted.gestureDetectorRenders.count).toBe(0);
    // Les cinq `Pressable` restent le chemin de navigation, et ils suffisent.
    const pressables = nodes(harness.renderer).filter(
      (node) => node.props['accessibilityRole'] === 'tab',
    );
    expect(pressables).toHaveLength(TAB_COUNT);
  });

  it('n’anime RIEN tant que Reduce Motion est inconnu — aucun ressort lancé', async () => {
    hoisted.shared.length = 0;
    hoisted.springs.length = 0;
    hoisted.isReduceMotionEnabled.mockReturnValue(new Promise(() => undefined));
    hoisted.isScreenReaderEnabled.mockResolvedValue(false);
    await act(async () => {
      create(
        createElement(
          ThemeProvider,
          null,
          createElement(BobTabBar, {
            items: ITEMS,
            activeKey: 'argent',
            onSelect: () => undefined,
            testID: 'bar',
          }),
        ),
      );
    });
    expect(hoisted.springs).toEqual([]);
  });

  it('ne RÉ-ANIME rien quand la préférence se résout — l’état final n’est jamais rejoué', async () => {
    // Montage pendant la fenêtre inconnue, puis résolution : aucun ressort ne doit partir. Le
    // défaut symétrique du fail-closed est exactement celui-là — rendre sans animer, puis
    // ré-animer une fois la valeur revenue.
    const harness = await mount({ activeKey: 'argent' });
    expect(hoisted.springs).toEqual([]);
    await harness.refresh();
    expect(hoisted.springs).toEqual([]);
  });

  it('pose les rôles `tablist` / `tab` et l’état `selected` — la référence ne les pose pas', async () => {
    const harness = await mount({ activeKey: 'argent' });
    expect(byTestID(harness.renderer, 'bar-pill')?.props['accessibilityRole']).toBe('tablist');
    for (const item of ITEMS) {
      const tab = byTestID(harness.renderer, `bar-tab-${item.key}`);
      expect(tab?.props['accessibilityRole']).toBe('tab');
      expect(tab?.props['accessibilityLabel']).toBe(item.label);
      expect(tab?.props['accessibilityState']).toEqual({ selected: item.key === 'argent' });
    }
  });

  it('déclare AUCUN `hitSlop` — contrôle statique, pas revue visuelle', () => {
    expect(strippedSource('bob-tab-bar.tsx')).not.toMatch(/hitSlop/);
  });
});

describe('ordre de peinture — la déclaration est le seul arbitre', () => {
  // Le CODE, sans les commentaires : les mots interdits apparaissent dans la prose qui explique
  // pourquoi ils sont interdits. Chercher dans le fichier brut ferait échouer la règle sur son
  // propre énoncé — et pousserait à effacer l'explication pour faire passer le test. Le
  // dépouillement passe par `strippedSource`, qui refuse de rendre une chaîne vide.

  it('n’emploie ni `zIndex`, ni `elevation`, ni token d’ombre', () => {
    const source = strippedSource('bob-tab-bar.tsx');
    expect(source).not.toMatch(/zIndex/);
    expect(source).not.toMatch(/elevation/);
    expect(source).not.toMatch(/shadowNative/);
  });

  it('n’emploie pas non plus `adjustsFontSizeToFit`, interdit sur du texte porteur de sens', () => {
    expect(strippedSource('bob-tab-bar.tsx')).not.toMatch(/adjustsFontSizeToFit/);
  });

  it('n’importe aucune dépendance native nouvelle', () => {
    const source = strippedSource('bob-tab-bar.tsx');
    expect(source).not.toMatch(/from 'expo-haptics'/);
    expect(source).not.toMatch(/from 'expo-glass-effect'/);
    expect(source).not.toMatch(/from 'expo-symbols'/);
  });

  /**
   * LE TÉMOIN DU DÉPOUILLEMENT LUI-MÊME. Sans lui, on saurait que `strippedSource` refuse le
   * vide, mais pas qu'il retire réellement les commentaires — et un dépouillement inerte ferait
   * échouer les trois tests ci-dessus sur leur propre prose explicative.
   */
  it('le dépouillement retire bien les commentaires, et rien que les commentaires', () => {
    const raw = readFileSync(join(__dirname, 'bob-tab-bar.tsx'), 'utf8');
    // Le mot `hitSlop` est écrit DANS un commentaire du composant : brut il est là, dépouillé
    // il n'y est plus. C'est la démonstration en un couple.
    expect(raw).toMatch(/hitSlop/);
    expect(strippedSource('bob-tab-bar.tsx')).not.toMatch(/hitSlop/);
  });
});

describe('Dynamic Type — la sonde mesure, puis disparaît', () => {
  it('est montée tant qu’un label n’est pas mesuré, et démontée dès qu’ils le sont tous', async () => {
    const harness = await mount();
    expect(byTestID(harness.renderer, 'bob-tab-bar-label-probes')).toBeDefined();

    const probes = flatten(byTestID(harness.renderer, 'bob-tab-bar-label-probes') ?? null).filter(
      (node) => node.type === 'Text',
    );
    expect(probes).toHaveLength(ITEMS.length * 2);

    await feedProbes(harness, { width: 30, height: 12 });
    // Le coût au REPOS redevient celui de la barre seule — ce que `PERF-13 · P13-A` mesure.
    expect(byTestID(harness.renderer, 'bob-tab-bar-label-probes')).toBeUndefined();
  });

  it('RETIRE le label quand il ne tient plus, sans jamais le tronquer', async () => {
    const harness = await mount();
    // Largeur naturelle énorme : même deux lignes ne suffisent pas.
    await feedProbes(harness, { width: 900, height: 12 });
    const labels = nodes(harness.renderer).filter((node) => node.type === 'Animated.Text');
    expect(labels).toHaveLength(0);
    // Le nom n'est PAS perdu : il reste porté par `accessibilityLabel`.
    expect(byTestID(harness.renderer, 'bar-tab-argent')?.props['accessibilityLabel']).toBe('Argent');
  });

  it('garde deux lignes au maximum et n’active jamais le rétrécissement automatique', async () => {
    const harness = await mount();
    const label = nodes(harness.renderer).find((node) => node.type === 'Animated.Text');
    expect(label?.props['numberOfLines']).toBe(2);
    expect(label?.props['adjustsFontSizeToFit']).toBeUndefined();
  });
});

/**
 * B4 — LA PILULE GRANDIT, ET LE CONTENU N'EST PAS ROGNÉ.
 *
 * Le socle : « `hauteurÉtendue = hauteurPressable(0) + 2 × 4`, avec `hauteurPressable(0) =
 * max(CIBLE, hauteur MESURÉE du contenu à la taille de texte courante)`. **58 pt** est sa valeur
 * à la taille standard, donc un **plancher**, jamais un plafond. » Tant qu'aucun appelant ne
 * passait de hauteur mesurée, les 50/35 et 58/60 étaient des PLAFONDS et le commentaire qui
 * promettait le contraire était faux. Ces tests mesurent ce que le composant rend RÉELLEMENT.
 */
describe('Dynamic Type — la pilule GRANDIT avec le texte, elle ne le coupe pas', () => {
  /** Hauteurs de ligne plausibles : 12 pt à 100 %, ~24 pt à ~200 % pour un label de 10 pt. */
  const LINE_AT_100 = 12;
  const LINE_AT_200 = 24;

  it('à 100 %, la barre vaut exactement les chiffres du socle : 50 / 58 / 60', async () => {
    const harness = await mount();
    // Labels courts : une seule ligne. Contenu = 23 + 3 + 12 = 38 → sous le plancher de 50.
    await feedProbes(harness, { width: 30, height: LINE_AT_100 });
    harness.setProgress(0);
    await harness.refresh();
    const visual = styleOf(byTestID(harness.renderer, 'bar-tab-argent')?.children?.[0]);
    expect(visual['height']).toBe(50);
    expect(styleOf(byTestID(harness.renderer, 'bar-tab-argent'))['height']).toBe(50);
    expect(styleOf(byTestID(harness.renderer, 'bar-pill'))['height']).toBe(60);
  });

  it('à ~200 % sur DEUX lignes, la pilule grandit — 58 pt était un plancher', async () => {
    const harness = await mount();
    hoisted.fontScale.value = 2;
    await harness.refresh();
    /*
     * Largeur naturelle 100 pt pour une largeur d'item de ~57,6 : ne tient pas sur une ligne.
     * Le mot le plus long tient (40 pt), donc rang DEUX LIGNES — et « la pilule grandit
     * d'autant ». Hauteur de ligne 24 pt : contenu = 23 + 3 + 2×24 = 74 pt.
     */
    await feedProbesSplit(
      harness,
      { width: 100, height: LINE_AT_200 },
      { width: 40, height: LINE_AT_200 },
    );
    harness.setProgress(0);
    await harness.refresh();

    const expectedVisual = 23 + 3 + 2 * LINE_AT_200;
    const visual = styleOf(byTestID(harness.renderer, 'bar-tab-argent')?.children?.[0]);
    expect(visual['height']).toBe(expectedVisual);
    // Le `Pressable` suit le contenu — le plancher de 44 est LARGEMENT dépassé, et c'est le but.
    expect(styleOf(byTestID(harness.renderer, 'bar-tab-argent'))['height']).toBe(expectedVisual);
    // La pilule aussi : `contenu + 2 × rythme(4) + 2 × bordure(1)`.
    expect(styleOf(byTestID(harness.renderer, 'bar-pill'))['height']).toBe(expectedVisual + 10);
    // Et elle est bien PLUS HAUTE que les 60 pt de la taille standard : le plafond a sauté.
    expect(styleOf(byTestID(harness.renderer, 'bar-pill'))['height'] as number).toBeGreaterThan(60);
    // Le label est toujours là, sur deux lignes, sans rétrécissement automatique.
    const label = nodes(harness.renderer).find((node) => node.type === 'Animated.Text');
    expect(label?.props['numberOfLines']).toBe(2);
    expect(label?.props['adjustsFontSizeToFit']).toBeUndefined();
  });

  it('la boîte visuelle NE ROGNE RIEN au repos : elle mesure exactement le contenu', async () => {
    for (const line of [LINE_AT_100, LINE_AT_200]) {
      const harness = await mount();
      await feedProbes(harness, { width: 30, height: line });
      harness.setProgress(0);
      await harness.refresh();
      const visual = styleOf(byTestID(harness.renderer, 'bar-tab-argent')?.children?.[0])[
        'height'
      ] as number;
      // Hauteur requise par le contenu réel : glyphe + rythme + UNE ligne (labels courts).
      const required = 23 + 3 + line;
      expect(visual).toBeGreaterThanOrEqual(required);
    }
  });

  it('à ~200 %, le PALIER passe en icônes seules quand un MOT ne tient plus', async () => {
    const harness = await mount();
    hoisted.fontScale.value = 2;
    await harness.refresh();
    // Le mot le plus long dépasse la largeur d'item : deux lignes ne sauveraient rien, un mot
    // ne se coupe pas. Rang trois : le label est RETIRÉ, jamais tronqué.
    await feedProbes(harness, { width: 200, height: LINE_AT_200 });
    expect(nodes(harness.renderer).filter((node) => node.type === 'Animated.Text')).toHaveLength(0);
    // Et la barre retombe alors sur ses planchers : plus de label, plus de croissance.
    harness.setProgress(0);
    await harness.refresh();
    expect(styleOf(byTestID(harness.renderer, 'bar-pill'))['height']).toBe(60);
  });

  it('un changement de taille système JETTE les mesures d’hier', async () => {
    const harness = await mount();
    await feedProbes(harness, { width: 30, height: LINE_AT_100 });
    expect(byTestID(harness.renderer, 'bob-tab-bar-label-probes')).toBeUndefined();
    hoisted.fontScale.value = 2;
    await harness.refresh();
    // La sonde revient : sans cela la barre garderait une hauteur calculée à l'ancienne échelle.
    expect(byTestID(harness.renderer, 'bob-tab-bar-label-probes')).toBeDefined();
  });
});

/**
 * LE CLAVIER — l'un des deux points du tableau « Ce que la référence ne fait PAS » que le portage
 * avait perdus. La référence n'a AUCUNE gestion ; le socle exige un comportement « défini et
 * testé ». Le voici défini, et le voici testé.
 */
describe('clavier — la barre flottante se retire, et redevient tactile en se refermant', () => {
  it('au repos, la barre est visible et tactile', async () => {
    const harness = await mount();
    const root = byTestID(harness.renderer, 'bar');
    expect(styleOf(root)['display']).toBe('flex');
    expect(root?.props['pointerEvents']).toBe('box-none');
  });

  it('clavier OUVERT → la barre n’est plus rendue ni tactile', async () => {
    const harness = await mount();
    await fireKeyboard('keyboardDidShow');
    const root = byTestID(harness.renderer, 'bar');
    // `display: none` retire la vue du layout ET du dispatch : pas de cible fantôme sous le
    // clavier, et pas de pilule collée sous le champ de saisie sur Android `adjustResize`.
    expect(styleOf(root)['display']).toBe('none');
    expect(root?.props['pointerEvents']).toBe('none');
  });

  it('iOS annonce l’ouverture par `keyboardWillShow` — les quatre événements sont écoutés', async () => {
    const harness = await mount();
    await fireKeyboard('keyboardWillShow');
    expect(styleOf(byTestID(harness.renderer, 'bar'))['display']).toBe('none');
    await fireKeyboard('keyboardWillHide');
    expect(styleOf(byTestID(harness.renderer, 'bar'))['display']).toBe('flex');
  });

  it('la barre est MASQUÉE, pas démontée — la position du highlight survit', async () => {
    const harness = await mount({ activeKey: 'index' });
    harness.slideIndex.value = 3;
    await harness.refresh();
    await fireKeyboard('keyboardDidShow');
    await fireKeyboard('keyboardDidHide');
    // Démonter la barre remettrait `slideIndex` à sa valeur initiale et la ferait « sauter ».
    expect(harness.slideIndex.value).toBe(3);
    expect(byTestID(harness.renderer, 'bar-pill')).toBeDefined();
  });
});

describe('géométrie horizontale — marge de safe area et retrait animé sont deux grandeurs', () => {
  it('la marge latérale fixe est portée par le conteneur, le retrait animé par la pilule', async () => {
    const harness = await mount();
    const container = nodes(harness.renderer).find(
      (node) => styleOf(node)['marginHorizontal'] === TAB_BAR_MARGIN,
    );
    expect(container).toBeDefined();
    // `max(34 − 16, 12)` = 18 pour un inset bas de 34.
    expect(styleOf(container)['marginBottom']).toBe(18);
    expect(styleOf(byTestID(harness.renderer, 'bar-pill'))['marginHorizontal']).toBe(0);
  });
});
