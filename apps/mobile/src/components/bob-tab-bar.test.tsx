/**
 * BobTabBar — LE RENDU, verrouillé comportement par comportement.
 *
 * CE QUE CE FICHIER PROUVE, ET QUE LA LOGIQUE PURE NE PEUT PAS PROUVER :
 *  · que les WORKLETS écrits en ligne dans le composant produisent EXACTEMENT ce que la fonction
 *    normative `tabBarGeometry()` calcule — sur une vingtaine de points ÉCHANTILLONNÉS de la
 *    course, et pas seulement aux deux extrémités, où un `max` mal placé passerait inaperçu.
 *    C'est un échantillonnage, pas une preuve exhaustive ; il s'obtient en EXÉCUTANT les
 *    worklets, pas en les relisant, et c'est ce qui interdit aux deux écritures de diverger ;
 *
 *    ⚠ CE QUE CETTE COMPARAISON-LÀ NE PROUVE PAS, ET IL FAUT LE DIRE AVANT DE LA LIRE : elle
 *    confronte le rendu à LA FONCTION QUI L'A PRODUIT. Elle établit la NON-DIVERGENCE de deux
 *    écritures de la même formule, jamais la justesse de la formule. Si `tabBarGeometry()`
 *    était fausse, ces tests-là resteraient verts. Les valeurs que le socle CHIFFRE sont donc
 *    posées ailleurs, en LITTÉRAUX calculés à la main, calcul écrit en commentaire, dans QUATRE
 *    blocs : « 1bis » (largeurs, retraits, table d'acceptation 60/46/50), « Dynamic Type »
 *    (50/58/60 et leur témoin), « overflow » (les deux prémisses) et « palette » (les six hex et
 *    leur contraste). Ce sont ces quatre blocs-là qui tuent une formule fausse — la rédaction
 *    précédente en énumérait quatre et en annonçait trois ;
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
  defineTabHapticPort,
  minimumWindowWidth,
  mixTint,
  tabBarGeometry,
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
  /**
   * ARGUMENTS des quatre SEUILS de geste. La rédaction précédente les déclarait en
   * `passthrough` : les valeurs étaient JETÉES, et aucun test ne pouvait dire si le pan gagnait
   * à 6 pt ou à 60, ni si le tap était borné à 16 pt de glissement — ou pas borné du tout, ce
   * qui est le défaut du paquet (voir l'en-tête du bloc « 3bis »).
   */
  gestureConfig: {} as Record<string, Record<string, unknown[]>>,
  /**
   * La SUITE des réglages appelés, dans l'ordre, un élément par appel. Sans elle, « une seule
   * fois chacun » serait indémontrable : un second `.maxDistance(20)` écraserait simplement le
   * premier dans `gestureConfig`, et personne ne verrait jamais qu'il a eu lieu.
   */
  gestureCalls: {} as Record<string, string[]>,
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
    const config: Record<string, unknown[]> = {};
    hoisted.gestureConfig[kind] = config;
    const calls: string[] = [];
    hoisted.gestureCalls[kind] = calls;
    const record = (name: string) => (fn: Handler) => {
      handlers[name] = fn;
      return builder;
    };
    /** Les seuils sont GARDÉS, pas jetés : c'est la seule façon de les verrouiller. */
    const keep =
      (name: string) =>
      (...args: unknown[]) => {
        config[name] = args;
        calls.push(name);
        return builder;
      };
    const builder: Record<string, unknown> = {
      activeOffsetX: keep('activeOffsetX'),
      failOffsetY: keep('failOffsetY'),
      maxDistance: keep('maxDistance'),
      maxDuration: keep('maxDuration'),
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
// Le VRAI fournisseur de repli — pas un doublon : le témoin « 1ter » monte la barre sous lui.
const { TabBarMinimizeProvider } = await import('./bob-tab-bar-minimize');

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
 * LE CONTENEUR DE CHROME : le seul nœud qui porte À LA FOIS la marge latérale de safe area et
 * la marge basse. La pilule, elle, porte un `marginHorizontal` ANIMÉ — deux grandeurs, deux
 * nœuds, et les confondre ferait lire le retrait du repli à la place de la marge d'écran.
 */
function chromeContainer(renderer: ReactTestRenderer): Node | undefined {
  return onlyOne(renderer, 'conteneur de chrome', (style) => {
    return 'marginHorizontal' in style && 'marginBottom' in style;
  });
}

/** La RANGÉE d'onglets : le seul nœud en ligne dont le rythme vertical s'anime. */
function tabRow(renderer: ReactTestRenderer): Node | undefined {
  return onlyOne(renderer, 'rangée d’onglets', (style) => {
    return style['flexDirection'] === 'row' && 'paddingVertical' in style;
  });
}

/**
 * Désigne un nœud par son STYLE, et EXIGE qu'il soit unique. Un `find` rendrait le premier
 * venu : le jour où deux nœuds répondent au même signalement, le test lirait le mauvais en
 * silence et resterait vert. « Le seul nœud qui… » est ici une assertion, pas un commentaire.
 */
function onlyOne(
  renderer: ReactTestRenderer,
  what: string,
  matches: (style: Record<string, unknown>) => boolean,
): Node | undefined {
  const found = nodes(renderer).filter((node) => matches(styleOf(node)));
  expect(found, `${what} : nœud non unique`).toHaveLength(1);
  return found[0];
}

/** La BOÎTE VISUELLE d'un onglet : premier enfant du `Pressable`, hauteur animée explicitement. */
function visualBox(renderer: ReactTestRenderer, key: string): Node | undefined {
  return byTestID(renderer, `bar-tab-${key}`)?.children?.[0];
}

function visualHeight(renderer: ReactTestRenderer, key: string): unknown {
  return styleOf(visualBox(renderer, key))['height'];
}

/**
 * ─── CONTRASTE WCAG 2.x, RÉÉCRIT ICI — ET C'EST DÉLIBÉRÉ ────────────────────────────────────
 *
 * `@bob/ui` exporte `contrastRatio`. L'importer ici ferait vérifier la teinte peinte PAR la
 * fonction que le paquet a écrite pour la justifier : une seconde lecture du même calcul, pas
 * une seconde opinion. Le dépôt tient déjà quatre implémentations pour cette raison exacte
 * (`bob-tab-bar.logic.ts`, « ROUE DÉCLARÉE n° 1 ») ; celle-ci est la cinquième, et la seule qui
 * parte des couleurs RÉELLEMENT présentes dans l'arbre rendu.
 */
function wcagContrast(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const n = Number.parseInt(hex.slice(1), 16);
    const channel = (shift: number): number => {
      const s = ((n >> shift) & 255) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return a >= b ? (a + 0.05) / (b + 0.05) : (b + 0.05) / (a + 0.05);
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

/**
 * Les glyphes REPORTENT la couleur qu'on leur passe. Sans cela, la teinte des icônes — moitié
 * du comportement 6 — ne serait observable nulle part dans l'arbre rendu, et « la barre peint
 * la palette » resterait une phrase.
 */
const glyph = (name: string) => (state: { readonly color: string; readonly size: number }) =>
  createElement('Glyph', { name, color: state.color, size: state.size });

const ITEMS = [
  { key: 'index', label: "Aujourd'hui", icon: glyph('sunrise') },
  { key: 'clients', label: 'Clients', icon: glyph('people') },
  { key: 'argent', label: 'Argent', icon: glyph('wallet') },
  { key: 'documents', label: 'Documents', icon: glyph('folder') },
  { key: 'assistant', label: 'Assistant', icon: glyph('spark') },
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
  hoisted.gestureConfig = {};
  hoisted.gestureCalls = {};
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
    expect(styleOf(tabRow(harness.renderer))['paddingVertical']).toBe(4);
    harness.setProgress(1);
    await harness.refresh();
    expect(styleOf(tabRow(harness.renderer))['paddingVertical']).toBe(0);
  });
});

/**
 * ─── 1ter · LE REPLI VIENT DU FOURNISSEUR — IDENTITÉ, PAS FORME ─────────────────────────────
 *
 * `useTabBarMinimizeState` rend `shared ?? local` : hors provider, un doublon LOCAL garde le
 * composant fonctionnel — et c'est le mode de TOUS les autres tests de ce fichier, qui ne
 * montent aucun provider. En production, la barre vit SOUS `TabBarMinimizeProvider`, et le
 * worklet de scroll des écrans écrit dans l'état du PROVIDER : une barre qui lirait son doublon
 * local resterait étendue pour toujours, et aucun test hors provider ne pourrait le voir — le
 * comportement 1 mourrait EN SILENCE. Ici on monte le VRAI provider autour de la VRAIE barre,
 * et on prouve que pousser la progression DU PROVIDER replie la barre RENDUE : ce n'est possible
 * que si l'état qu'elle consomme EST celui du provider.
 */
describe('1ter · la barre consomme l’état du PROVIDER, pas son doublon local', () => {
  it('pousser la progression du provider replie la barre rendue — le doublon local, lui, ne bouge pas', async () => {
    hoisted.shared.length = 0;
    hoisted.springs.length = 0;
    hoisted.isReduceMotionEnabled.mockResolvedValue(false);
    hoisted.isScreenReaderEnabled.mockResolvedValue(false);
    const element = (): ReturnType<typeof createElement> =>
      createElement(
        ThemeProvider,
        null,
        createElement(
          TabBarMinimizeProvider,
          null,
          createElement(BobTabBar, {
            items: ITEMS,
            activeKey: 'argent',
            onSelect: () => undefined,
            testID: 'bar',
          }),
        ),
      );
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(element());
    });
    const tree = renderer as ReactTestRenderer;

    /*
     * TÉMOIN D'OBSERVATION — l'ordre de création des valeurs partagées est VÉRIFIÉ avant d'être
     * exploité : trio du PROVIDER (progress 0, target 0, animated false), puis trio du doublon
     * LOCAL du hook (les hooks ne sont pas conditionnels : il est toujours créé), puis
     * `slideIndex` à l'index actif (argent = 2). Si cet ordre change un jour, on veut un rouge
     * ICI — pas une lecture silencieuse du mauvais carton.
     */
    expect(
      hoisted.shared.slice(0, 7).map((entry) => entry.initial),
      'l’ordre des valeurs partagées n’est pas celui attendu : le témoin lirait le mauvais carton',
    ).toEqual([0, 0, false, 0, 0, false, 2]);
    const providerProgress = hoisted.shared[0]?.box as unknown as Mutable;
    const localProgress = hoisted.shared[3]?.box as unknown as Mutable;
    const before = styleOf(byTestID(tree, 'bar-pill'));
    expect(before['height'], 'la pilule n’a pas été rendue : le test n’observe rien').toBeDefined();
    // Étendue au départ : 50 + 2×4 + 2×1 = 60 pt (littéral du socle).
    expect(before['height']).toBe(60);

    // On pousse la progression DU PROVIDER — ce que fait le pilote de scroll d'un écran.
    providerProgress.value = 1;
    await act(async () => {
      tree.update(element());
    });
    const pill = styleOf(byTestID(tree, 'bar-pill'));
    // Repliée : max(44 ; 35) + 2×0 + 2×1 = 46 pt, retrait latéral 34. Une barre branchée sur
    // son doublon local serait restée à 60 — c'est EXACTEMENT le silence qu'on interdit ici.
    expect(pill['height']).toBe(46);
    expect(pill['marginHorizontal']).toBe(34);
    // Et le doublon local n'a pas bougé : personne ne l'écrit, personne ne le lit.
    expect(localProgress.value).toBe(0);
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
 * ─── L'ATTENDU EST UN LITTÉRAL, ET C'EST TOUTE LA DIFFÉRENCE ──────────────────────────────
 * La rédaction précédente comparait le rendu à `tabBarGeometry(p, …)` — LA FONCTION QUI PRODUIT
 * cette valeur dans le composant. Elle comparait A à A : si la fonction normative était fausse,
 * le test restait vert en ne prouvant que sa propre cohérence. Tous les nombres attendus
 * ci-dessous sont posés AU CRAYON depuis le socle, avec leur calcul en commentaire, et aucune
 * fonction de la barre n'intervient dans leur construction.
 *
 * ─── CE QUE CE TEST LIT, ET CE QU'IL N'A PAS LE DROIT DE PRÉTENDRE ────────────────────────
 * `react-test-renderer` ne fait AUCUN layout : la largeur MESURÉE d'un `Pressable` `flex: 1`
 * n'existe nulle part dans l'arbre, et aucun test de ce fichier ne peut la lire. (La rédaction
 * précédente lisait la largeur du HIGHLIGHT en l'appelant « la largeur de la cible » : c'était
 * un raccourci, et il n'était pas dit.) Ce qui est lu ici, ce sont les CINQ grandeurs déclarées
 * qui déterminent cette largeur, chacune vérifiée contre un littéral :
 *   1. la marge de safe area portée par le conteneur ...................... 12 pt
 *   2. le retrait latéral ANIMÉ rendu sur la pilule ....................... table ci-dessous
 *   3. l'épaisseur de bordure de la pilule ................................. 1 pt
 *   4. le retrait intérieur de la rangée ................................... 4 pt
 *   5. `flex: 1` sur les cinq onglets, et AUCUNE `width` — donc part égale
 * plus la largeur du bloc de HIGHLIGHT, calculée par un worklet SÉPARÉ et large d'un onglet :
 * deux écritures indépendantes qui doivent tomber sur le même littéral.
 *
 * Le balayage DENSE — 101 points de la course × 8 largeurs réelles × 2 OS — reste dans le test
 * de LOGIQUE PURE, où il coûte quelques millisecondes ; ici il demanderait 1 616 rendus
 * complets, et un test lent devient un test qu'on désactive.
 */
describe('1bis · la LARGEUR de la cible, plancherée sur les écrans réels les plus étroits', () => {
  /**
   * ─── LA TABLE, CALCULÉE À LA MAIN DEPUIS LE SOCLE ─────────────────────────────────────────
   *
   *   fenêtreMinimale = 2×12 (marge) + 2×1 (bordure) + 2×4 (rangée) + 5 × CIBLE
   *   retraitMax      = min(34, max((fenêtre − fenêtreMinimale) / 2, 0))
   *   retrait(p)      = retraitMax × p
   *   largeurPilule   = fenêtre − 2×12 − 2×retrait(p)
   *   largeurOnglet   = (largeurPilule − 2×1 − 2×4) / 5
   *   hauteurCible(p) = max(CIBLE, 50 + (35 − 50) × p)
   *
   * Les trois fenêtres sont les écrans réels les plus serrés : couverture de pliable (~280),
   * petit téléphone (320), Android médian (360).
   */
  interface WidthRow {
    readonly window: number;
    /** Retrait latéral rendu à p = 0 / 0,5 / 1. */
    readonly inset: readonly [number, number, number];
    /** Largeur d'un onglet à p = 0 / 0,5 / 1. */
    readonly itemWidth: readonly [number, number, number];
    /** Hauteur du `Pressable` à p = 0 / 0,5 / 1. */
    readonly targetHeight: readonly [number, number, number];
  }

  /**
   * LA TABLE D'ACCEPTATION DU SOCLE, en hauteur, posée à la main — elle ne dépend pas de la
   * fenêtre : `pilule mesurée = max(CIBLE, visuel) + 2 × rythme + 2 × bordure`, avec le rythme
   * qui va de 4 à 0. iOS : 60 étendu, 46 replié (« 44/46 »). Android : 60 étendu, 50 replié
   * (« 48/50 »). La boîte INTÉRIEURE étendue vaut 58 dans les deux cas, et l'écart entre le
   * bord de la pilule et celui de la cible vaut 5 pt étendu, 1 pt replié.
   */
  const PILL_HEIGHT: Record<TabBarPlatform, readonly [number, number, number]> = {
    ios: [60, 50, 46], //     50 + 8 + 2  |  44 + 4 + 2  |  44 + 0 + 2
    android: [60, 54, 50], // 50 + 8 + 2  |  48 + 4 + 2  |  48 + 0 + 2
  };
  /** Écart pilule ↔ cible, de chaque côté : `rythme + bordure`, à p = 0 / 0,5 / 1. */
  const PILL_GAP: readonly [number, number, number] = [5, 3, 1];

  const TABLE: Record<TabBarPlatform, readonly WidthRow[]> = {
    // CIBLE = 44 pt → fenêtreMinimale = 24 + 2 + 8 + 5×44 = 254 pt.
    ios: [
      // 280 : retraitMax = (280 − 254)/2 = 13.
      // p=0   → pilule 280−24 = 256 ; onglet (256−10)/5 = 49,2 ; cible max(44, 50)   = 50
      // p=0,5 → pilule 280−24−13 = 243 ; onglet 233/5 = 46,6   ; cible max(44, 42,5) = 44
      // p=1   → pilule 280−24−26 = 230 ; onglet 220/5 = 44     ; cible max(44, 35)   = 44
      { window: 280, inset: [0, 6.5, 13], itemWidth: [49.2, 46.6, 44], targetHeight: [50, 44, 44] },
      // 320 : retraitMax = (320 − 254)/2 = 33 — le socle en demandait 34, il CÈDE d'un point.
      // p=0   → pilule 296 ; onglet 286/5 = 57,2
      // p=0,5 → pilule 320−24−33 = 263 ; onglet 253/5 = 50,6
      // p=1   → pilule 320−24−66 = 230 ; onglet 220/5 = 44 — la cible tenue au point près
      { window: 320, inset: [0, 16.5, 33], itemWidth: [57.2, 50.6, 44], targetHeight: [50, 44, 44] },
      // 360 : (360 − 254)/2 = 53 > 34 → le clamp NE MORD PAS, retrait = 34 pt du socle.
      // p=1   → pilule 360−24−68 = 268 ; onglet 258/5 = 51,6
      { window: 360, inset: [0, 17, 34], itemWidth: [65.2, 58.4, 51.6], targetHeight: [50, 44, 44] },
    ],
    // CIBLE = 48 dp → fenêtreMinimale = 24 + 2 + 8 + 5×48 = 274 dp.
    android: [
      // 280 : retraitMax = (280 − 274)/2 = 3. La barre ne se replie presque plus : c'est le troc.
      // p=1   → pilule 280−24−6 = 250 ; onglet 240/5 = 48     ; cible max(48, 35) = 48
      { window: 280, inset: [0, 1.5, 3], itemWidth: [49.2, 48.6, 48], targetHeight: [50, 48, 48] },
      // 320 : retraitMax = (320 − 274)/2 = 23.
      // p=1   → pilule 320−24−46 = 250 ; onglet 240/5 = 48
      { window: 320, inset: [0, 11.5, 23], itemWidth: [57.2, 52.6, 48], targetHeight: [50, 48, 48] },
      // 360 : (360 − 274)/2 = 43 > 34 → clamp inerte, retrait = 34.
      { window: 360, inset: [0, 17, 34], itemWidth: [65.2, 58.4, 51.6], targetHeight: [50, 48, 48] },
    ],
  };

  /** Les deux planchers, écrits à la main : 44 pt est une valeur iOS, 48 dp une valeur Android. */
  const FLOOR: Record<TabBarPlatform, number> = { ios: 44, android: 48 };

  for (const platform of ['ios', 'android'] as TabBarPlatform[]) {
    it(`sur ${platform}, le RENDU tient la cible dans les DEUX dimensions sur les écrans serrés`, async () => {
      hoisted.platform.value = platform;
      const floor = FLOOR[platform];
      // Le plancher écrit à la main est bien celui que le paquet expose — si les deux divergent,
      // c'est la table ci-dessus qu'il faut recalculer, pas l'assertion qu'il faut assouplir.
      expect(touchTargetFloor(platform)).toBe(floor);

      for (const row of TABLE[platform]) {
        hoisted.windowWidth.value = row.window;
        const harness = await mount();
        for (const [at, p] of [0, 0.5, 1].entries()) {
          harness.setProgress(p);
          await harness.refresh();
          const where = `${platform} ${row.window}pt @ ${p}`;

          // 1 · LA CHAÎNE QUI DÉTERMINE LA LARGEUR, lue nombre par nombre dans l'arbre rendu.
          const container = styleOf(chromeContainer(harness.renderer));
          expect(container['marginHorizontal'], `${where} marge`).toBe(12);
          const pill = styleOf(byTestID(harness.renderer, 'bar-pill'));
          expect(pill['borderWidth'], `${where} bordure`).toBe(1);
          expect(pill['marginHorizontal'] as number, `${where} retrait`).toBeCloseTo(
            row.inset[at] as number,
            10,
          );
          expect(styleOf(tabRow(harness.renderer))['paddingHorizontal'], `${where} rangée`).toBe(4);
          // La TABLE D'ACCEPTATION en hauteur, au passage : 60 étendu partout, 46 replié sur
          // iOS, 50 sur Android — et l'écart de 5 pt / 1 pt entre la pilule et la cible.
          expect(pill['height'] as number, `${where} pilule`).toBeCloseTo(
            PILL_HEIGHT[platform][at] as number,
            10,
          );
          expect(
            ((pill['height'] as number) - (row.targetHeight[at] as number)) / 2,
            `${where} écart`,
          ).toBeCloseTo(PILL_GAP[at] as number, 10);

          // 2 · LES CINQ ONGLETS SE PARTAGENT ÉGALEMENT ce qui reste : `flex: 1`, aucune `width`.
          //     C'est ce qui autorise la division ci-dessous — sans elle, elle ne voudrait rien
          //     dire, et c'est exactement ce que le raccourci précédent taisait.
          for (const item of ITEMS) {
            const pressable = styleOf(byTestID(harness.renderer, `bar-tab-${item.key}`));
            expect(pressable['flex'], `${where} ${item.key} flex`).toBe(1);
            expect(pressable['width'], `${where} ${item.key} width`).toBeUndefined();
            // La HAUTEUR : l'autre moitié du critère d'acceptation, au même instant.
            expect(pressable['height'] as number, `${where} ${item.key} h`).toBeCloseTo(
              row.targetHeight[at] as number,
              10,
            );
            expect(pressable['height'] as number, `${where} ${item.key} h≥`).toBeGreaterThanOrEqual(
              floor,
            );
          }

          // 3 · LA LARGEUR D'UN ONGLET. Le littéral de la table, et le même nombre reconstruit
          //     depuis les grandeurs LUES ci-dessus : `(fenêtre − 2×marge − 2×retrait − 2×bordure
          //     − 2×rangée) / 5`. Les deux doivent tomber ensemble.
          const fromRead = (row.window - 2 * 12 - 2 * (pill['marginHorizontal'] as number) - 2 - 8) / 5;
          expect(fromRead, `${where} reconstruction`).toBeCloseTo(row.itemWidth[at] as number, 10);
          // Le bloc de highlight est large d'UN onglet, et il sort d'un worklet SÉPARÉ.
          const highlight = styleOf(byTestID(harness.renderer, 'bar-highlight'))['width'] as number;
          expect(highlight, `${where} highlight`).toBeCloseTo(row.itemWidth[at] as number, 10);
          // Et cette largeur tient la cible — le point de tout l'exercice.
          expect(row.itemWidth[at] as number, `${where} table ≥ cible`).toBeGreaterThanOrEqual(floor);
          expect(highlight, `${where} rendu ≥ cible`).toBeGreaterThanOrEqual(floor - 1e-9);
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
    /*
     * Sur un écran étroit, un mapping qui garderait les 34 pt du socle serait décalé exactement
     * là où la barre est la plus serrée — le pire endroit possible.
     *
     * TOUT EST LITTÉRAL. Fenêtre 320, iOS, repli complet : retrait 33 (calcul de la table
     * ci-dessus), pilule 230, onglet 44, et le contenu commence à 1 (bordure) + 4 (rangée) = 5.
     * Un doigt au CENTRE de l'onglet `n` est donc à `5 + 44 × (n + 0,5)`, et l'index attendu est
     * `n` — un entier posé à la main. La rédaction précédente construisait l'attendu avec
     * `tabIndexAtX(…, tabBarGeometry(…))` : elle bougeait avec le code, et le mutant qui
     * débranche le clamp du retrait la laissait VERTE.
     */
    hoisted.windowWidth.value = 320;
    const harness = await mount();
    harness.setProgress(1);
    await harness.refresh();
    expect(styleOf(byTestID(harness.renderer, 'bar-pill'))['marginHorizontal']).toBeCloseTo(33, 10);
    const onUpdate = hoisted.gestures['pan']?.['onUpdate'] as (event: { x: number }) => void;
    for (const index of [0, 2, 4]) {
      onUpdate({ x: 5 + 44 * (index + 0.5) });
      expect(harness.slideIndex.value as number, `centre de l’onglet ${index}`).toBeCloseTo(
        index,
        10,
      );
    }
    // Et la FRONTIÈRE entre deux onglets tombe pile au demi : `5 + 44 × 3` = 137 → 2,5.
    onUpdate({ x: 5 + 44 * 3 });
    expect(harness.slideIndex.value as number).toBeCloseTo(2.5, 10);
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

  it('se déplace par `translateX` seul, d’un pas de 71,2 pt par onglet — littéraux, plus la fonction', async () => {
    /*
     * TOUT EST CALCULÉ À LA MAIN — fenêtre 390, repos (progress 0), cinq onglets :
     *   pilule  = 390 − 2×12 = 366 ; contenu = 366 − 2×1 − 2×4 = 356 ; onglet = 356 / 5 = 71,2.
     * Le voyage part du retrait de rangée : translateX(i) = 4 + 71,2 × i. La rédaction
     * précédente posait `TAB_BAR_ROW_PAD_H + tabBarGeometry(…).itemWidth × i` — la fonction qui
     * produit cette valeur DANS le composant : elle comparait A à A.
     */
    const harness = await mount();
    for (const [index, expectedX] of [
      [0, 4],
      [2, 146.4],
      [4, 288.8],
      [1.5, 110.8],
    ] as const) {
      harness.slideIndex.value = index;
      await harness.refresh();
      const travel = styleOf(byTestID(harness.renderer, 'bar-highlight-travel'));
      const style = styleOf(byTestID(harness.renderer, 'bar-highlight'));
      const transform = travel['transform'] as { translateX: number }[] | undefined;
      expect(transform?.[0], `index ${index} : aucun transform rendu — rien à observer`).toBeDefined();
      expect(transform?.[0]?.translateX, `index ${index}`).toBeCloseTo(expectedX, 10);
      expect(style['width'], `index ${index}`).toBeCloseTo(71.2, 10);
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

  it('reste CENTRÉ dans la boîte intérieure de la pilule — aux littéraux du socle', async () => {
    /*
     * visuel(p) = 50 + (35 − 50) × p ; boîte intérieure = max(44 ; visuel) + 2 × rythme(p) ;
     * marginTop = (boîte − visuel) / 2. À la main :
     *   p=0   → visuel 50   ; boîte 50 + 8 = 58 ; marginTop 4
     *   p=0,5 → visuel 42,5 ; boîte 44 + 4 = 48 ; marginTop 2,75
     *   p=1   → visuel 35   ; boîte 44 + 0 = 44 ; marginTop 4,5
     * (Rédaction précédente : l'attendu sortait de `tabBarGeometry(…)` — la fonction testée.)
     */
    const harness = await mount();
    for (const row of [
      { p: 0, height: 50, top: 4 },
      { p: 0.5, height: 42.5, top: 2.75 },
      { p: 1, height: 35, top: 4.5 },
    ]) {
      harness.setProgress(row.p);
      await harness.refresh();
      const style = styleOf(byTestID(harness.renderer, 'bar-highlight'));
      expect(style['height'], `p=${row.p} : rien de rendu — rien à observer`).toBeDefined();
      expect(style['height'], `p=${row.p}`).toBeCloseTo(row.height, 10);
      expect(style['marginTop'], `p=${row.p}`).toBeCloseTo(row.top, 10);
    }
  });
});

/**
 * ─── LES DEUX `overflow: 'hidden'` — DES CISEAUX, ET CE QUI LES REND INOFFENSIFS ────────────
 *
 * Le fichier en écrit DEUX : sur la PILULE (pour que le highlight ne déborde pas de l'arrondi) et
 * sur la BOÎTE VISUELLE d'un onglet (pour qu'un label déjà transparent ne dépasse pas de la
 * pilule pendant le repli). Dans l'ARBRE RENDU ils font six nœuds, la boîte visuelle étant
 * rendue cinq fois — deux déclarations, six paires de ciseaux. Aucun test ne les posait, ni les
 * prémisses qui font qu'ils ne coupent rien — et un jour ils couperont quelque chose.
 *
 * Une prémisse VÉRIFIABLE, c'est une inégalité sur des nombres lus dans l'arbre rendu, comparés
 * à des littéraux calculés à la main. Il en faut trois, une par ciseau et par dimension :
 *  · LA PILULE — le bloc de highlight, jusqu'au DERNIER onglet et à tout instant du repli, reste
 *    dans sa boîte intérieure, et il y reste avec une marge CONSTANTE de 4 pt ;
 *  · LA BOÎTE VISUELLE, en HAUTEUR — elle vaut toujours au moins son contenu au repos ; c'est le
 *    test « la boîte visuelle NE ROGNE RIEN au repos », plus bas, qui le pose sur les deux
 *    régimes (plancher et mesure) ;
 *  · LA BOÎTE VISUELLE, en LARGEUR — un label plus large qu'un onglet est RETIRÉ par le palier
 *    avant d'avoir pu déborder, et la frontière est posée au point près.
 */
describe('overflow: hidden — deux ciseaux déclarés, et les prémisses qui les désarment', () => {
  it('les DEUX déclarations sont là, et la barre ne peint pas un ciseau de plus', async () => {
    const harness = await mount();
    expect(styleOf(byTestID(harness.renderer, 'bar-pill'))['overflow']).toBe('hidden');
    expect(styleOf(visualBox(harness.renderer, 'argent'))['overflow']).toBe('hidden');
    /*
     * ET LA BARRE N'EN DÉCLARE AUCUN AUTRE : cinq boîtes visuelles + la pilule = six. Un
     * septième couperait quelque chose sans que personne l'ait décidé.
     *
     * La RETOMBÉE en porte un de plus — elle clippe ses propres bandes de dégradé. Celui-là
     * appartient à `ProgressiveBlurBob`, le composant du kit de matière que la barre CONSOMME
     * sans le réécrire : il se prouve chez lui. On l'écarte nommément plutôt que de gonfler le
     * compte attendu, ce qui reviendrait à épingler ici les entrailles d'un autre composant.
     */
    const hiddenIn = (root: Node | undefined): readonly Node[] =>
      flatten(root ?? null).filter((node) => styleOf(node)['overflow'] === 'hidden');
    // UN SEUL instantané d'arbre : `toJSON()` reconstruit des objets NEUFS à chaque appel, et
    // comparer par identité deux relevés différents ne rapprocherait rien du tout.
    const tree = nodes(harness.renderer);
    expect(hiddenIn(tree.find((node) => node.props['testID'] === 'bar-pill'))).toHaveLength(
      TAB_COUNT + 1,
    );
    const fromFalloff = new Set(
      hiddenIn(tree.find((node) => node.props['testID'] === 'bar-falloff')),
    );
    const own = tree.filter(
      (node) => styleOf(node)['overflow'] === 'hidden' && !fromFalloff.has(node),
    );
    expect(own).toHaveLength(TAB_COUNT + 1);
  });

  /**
   * PRÉMISSE HORIZONTALE, calculée à la main pour une fenêtre de 390 pt et cinq onglets :
   *
   *   dedans(p)     = largeurPilule(p) − 2×1     ← un absolu `left: 0` part DANS la bordure
   *   voyage(4)     = 4 + largeurOnglet × 4      ← le dernier onglet, le seul qui frôle le bord
   *   bordDroit     = voyage(4) + largeurOnglet = 4 + 5 × largeurOnglet = largeurPilule − 6
   *   dedans − bordDroit = 4 pt, À TOUT `p`      ← exactement le retrait de rangée de droite
   *
   * Ce 4 pt CONSTANT est la prémisse : ce n'est pas « ça passe de justesse », c'est « il reste
   * toujours la même marge, et elle vaut le retrait intérieur qu'on a posé ».
   *
   * LA SEULE HYPOTHÈSE DE CE CALCUL est l'origine d'un enfant positionné en absolu : la
   * padding-box, bordure exclue, comme en CSS. Si c'était la border-box, la paroi serait
   * `largeurPilule` et la marge vaudrait 6 pt au lieu de 4 — le highlight resterait dedans dans
   * les deux lectures, seul le chiffre changerait. La prémisse ne dépend donc pas du pari.
   */
  it('PRÉMISSE · la pilule ne coupe jamais le highlight, et la marge est constante', async () => {
    const ROWS = [
      // p=0   : retrait 0  → pilule 366 ; dedans 364 ; onglet (366−10)/5 = 71,2 ; voyage 288,8
      //         visuel 50   ; boîte intérieure 50 + 2×4 = 58 ; marginTop (58 − 50)/2 = 4
      { p: 0, inset: 0, item: 71.2, travel: 288.8, inside: 364, visual: 50, inner: 58, top: 4 },
      // p=0,5 : retrait 17 → pilule 332 ; dedans 330 ; onglet 322/5 = 64,4 ; voyage 261,6
      //         visuel 42,5 ; boîte intérieure max(44 ; 42,5) + 2×2 = 48 ; marginTop 2,75
      { p: 0.5, inset: 17, item: 64.4, travel: 261.6, inside: 330, visual: 42.5, inner: 48, top: 2.75 },
      // p=1   : retrait 34 → pilule 298 ; dedans 296 ; onglet 288/5 = 57,6 ; voyage 234,4
      //         visuel 35   ; boîte intérieure 44 + 0 = 44 ; marginTop (44 − 35)/2 = 4,5
      { p: 1, inset: 34, item: 57.6, travel: 234.4, inside: 296, visual: 35, inner: 44, top: 4.5 },
    ];
    const harness = await mount();
    for (const row of ROWS) {
      // Le DERNIER onglet : celui dont le highlight touche le bord droit de la pilule.
      harness.slideIndex.value = TAB_COUNT - 1;
      harness.setProgress(row.p);
      await harness.refresh();
      const where = `p=${row.p}`;

      const inset = styleOf(byTestID(harness.renderer, 'bar-pill'))['marginHorizontal'] as number;
      expect(inset, `${where} retrait`).toBeCloseTo(row.inset, 10);
      // `dedans` reconstruit depuis la fenêtre et le retrait lus, puis confronté au littéral.
      const inside = WINDOW_WIDTH - 2 * 12 - 2 * inset - 2 * 1;
      expect(inside, `${where} dedans`).toBeCloseTo(row.inside, 10);

      const travel = (styleOf(byTestID(harness.renderer, 'bar-highlight-travel'))['transform'] as {
        translateX: number;
      }[])[0]?.translateX as number;
      const width = styleOf(byTestID(harness.renderer, 'bar-highlight'))['width'] as number;
      expect(travel, `${where} voyage`).toBeCloseTo(row.travel, 10);
      expect(width, `${where} largeur`).toBeCloseTo(row.item, 10);
      // LA PRÉMISSE : le bord droit du highlight tombe 4 pt avant la paroi, à tout instant.
      expect(inside - (travel + width), `${where} marge droite`).toBeCloseTo(4, 10);
      expect(travel + width, `${where} dedans ?`).toBeLessThanOrEqual(inside);
      // À gauche, le highlight part du retrait de rangée : il ne mord pas non plus la bordure.
      expect(styleOf(byTestID(harness.renderer, 'bar-highlight-travel'))['left'], where).toBe(0);

      // ET LA MÊME CHOSE EN HAUTEUR : la boîte intérieure de la pilule contient le highlight,
      // avec la même marge des deux côtés (il est CENTRÉ).
      const boxed = styleOf(byTestID(harness.renderer, 'bar-highlight'));
      const measured = styleOf(byTestID(harness.renderer, 'bar-pill'))['height'] as number;
      expect(measured - 2 * 1, `${where} boîte intérieure`).toBeCloseTo(row.inner, 10);
      expect(boxed['height'] as number, `${where} visuel`).toBeCloseTo(row.visual, 10);
      expect(boxed['marginTop'] as number, `${where} haut`).toBeCloseTo(row.top, 10);
      expect(boxed['marginTop'] as number, `${where} haut ≥ 0`).toBeGreaterThanOrEqual(0);
      expect(
        (boxed['marginTop'] as number) + (boxed['height'] as number),
        `${where} bas`,
      ).toBeLessThanOrEqual(row.inner);
    }
  });

  /**
   * TROISIÈME PRÉMISSE — la boîte visuelle, en LARGEUR. Elle est `overflow: 'hidden'` : un
   * label plus large qu'elle serait COUPÉ NET — un « Docume » sans ellipse, la pire des
   * troncatures. Ce n'est pas le `hidden` qui l'interdit, c'est le PALIER : au-delà de la
   * largeur d'un onglet — `(390 − 2×12 − 2×1 − 2×4) / 5 = 71,2 pt` au repos — un mot qui ne se
   * coupe pas fait passer TOUTE la barre en icônes.
   */
  it('PRÉMISSE · un label plus large qu’un onglet est RETIRÉ, jamais laissé déborder', async () => {
    // 71 ≤ 71,2 : le mot tient, le label reste (sur deux lignes, sa largeur totale le demande).
    const fits = await mount();
    await feedProbesSplit(fits, { width: 100, height: 12 }, { width: 71, height: 12 });
    expect(nodes(fits.renderer).filter((node) => node.type === 'Animated.Text')).toHaveLength(
      TAB_COUNT,
    );
    // 72 > 71,2 : un point de trop, et le label disparaît AVANT d'avoir pu être coupé.
    const over = await mount();
    await feedProbesSplit(over, { width: 100, height: 12 }, { width: 72, height: 12 });
    expect(nodes(over.renderer).filter((node) => node.type === 'Animated.Text')).toHaveLength(0);
  });
});

/**
 * ─── LA BARRE PEINT-ELLE LA PALETTE ? LE MAILLON QUI MANQUAIT ───────────────────────────────
 *
 * La preuve AA du lot porte sur `tabTintPalette()` et sur l'échantillonnage de sa course
 * (`sampleTintCourse`), tous deux dans la logique pure. Rien ne disait que le COMPOSANT envoie
 * ces couleurs-là au moteur de rendu : il aurait pu peindre n'importe quel gris et la preuve
 * serait restée verte. Ce bloc lit les couleurs RÉELLEMENT présentes dans l'arbre et les
 * confronte, une par une, aux hex du socle — écrits ici À LA MAIN, jamais lus depuis la
 * fonction qu'ils sont censés vérifier.
 *
 * CE QUE CE BLOC NE DIT PAS : rien de l'apparence SOMBRE. `ThemeProvider` rend `appearance:
 * 'light'` EN DUR tant qu'`UX-ADR-004` n'a pas activé le dark ; la branche sombre de
 * `tabTintPalette` n'est donc atteignable par aucun rendu, et c'est la logique pure qui la
 * couvre.
 */
describe('la barre PEINT la palette — et ces couleurs-là sont celles que la preuve AA vise', () => {
  const PILL = '#FFFFFF'; //      surfaceTint.light.neutral.flat
  const HIGHLIGHT = '#EAEEF3'; // surfaceTint.light.neutral.raised
  const BORDER = '#E0E6EE'; //    surfaceTint.light.neutral.border
  const ACTIVE = '#0C2340'; //    navigation.active        (ink900)
  const ASSISTANT = '#4338CA'; // navigation.assistantActive (semantic.ai — la règle Bob)
  const INACTIVE = '#5B6B7B'; //  navigation.inactive      (slate500)

  /** Couleur du label d'un onglet, telle qu'elle est dans l'arbre rendu. */
  function labelColor(harness: Harness, key: string): unknown {
    const tab = byTestID(harness.renderer, `bar-tab-${key}`);
    return styleOf(flatten(tab ?? null).find((node) => node.type === 'Animated.Text'))['color'];
  }

  /** Les DEUX glyphes d'un onglet, dans l'ordre de déclaration : l'inactif, puis l'actif. */
  function glyphColors(harness: Harness, key: string): unknown[] {
    const tab = byTestID(harness.renderer, `bar-tab-${key}`);
    return flatten(tab ?? null)
      .filter((node) => node.type === 'Glyph')
      .map((node) => node.props['color']);
  }

  it('peint les trois SURFACES de la pilule avec les tons livrés', async () => {
    const harness = await mount();
    const pill = styleOf(byTestID(harness.renderer, 'bar-pill'));
    expect(pill['backgroundColor']).toBe(PILL);
    expect(pill['borderColor']).toBe(BORDER);
    expect(pill['borderWidth']).toBe(1);
    // La capsule est un APLAT OPAQUE, jamais un voile : ni `opacity`, ni couleur transparente.
    const highlight = styleOf(byTestID(harness.renderer, 'bar-highlight'));
    expect(highlight['backgroundColor']).toBe(HIGHLIGHT);
    expect(highlight['opacity']).toBeUndefined();
  });

  it('peint les trois ENCRES là où le socle les met — dont l’indigo de l’Assistant', async () => {
    const harness = await mount({ activeKey: 'index' });
    harness.slideIndex.value = 0;
    await harness.refresh();
    // Onglet sous le highlight : encre active. Onglets éloignés : encre inactive.
    expect(labelColor(harness, 'index')).toBe(ACTIVE);
    expect(labelColor(harness, 'argent')).toBe(INACTIVE);
    // Les deux glyphes : le calque du dessous est l'inactif, celui du dessus l'actif.
    expect(glyphColors(harness, 'argent')).toEqual([INACTIVE, ACTIVE]);
    // L'ASSISTANT ne prend pas l'encre commune, et c'est une règle Bob absente de la référence.
    expect(glyphColors(harness, 'assistant')).toEqual([INACTIVE, ASSISTANT]);
    harness.slideIndex.value = TAB_COUNT - 1;
    await harness.refresh();
    expect(labelColor(harness, 'assistant')).toBe(ASSISTANT);
  });

  it('les couleurs PEINTES tiennent AA sur les DEUX fonds qu’elles rencontrent', async () => {
    const harness = await mount({ activeKey: 'index' });
    harness.slideIndex.value = 0;
    await harness.refresh();
    // Tout est lu dans l'arbre : le texte, la pilule, ET la capsule qui passe SOUS le texte.
    const pill = styleOf(byTestID(harness.renderer, 'bar-pill'))['backgroundColor'] as string;
    const highlight = styleOf(byTestID(harness.renderer, 'bar-highlight'))[
      'backgroundColor'
    ] as string;
    const inks = [
      labelColor(harness, 'index') as string,
      labelColor(harness, 'argent') as string,
      glyphColors(harness, 'assistant')[1] as string,
    ];
    for (const ink of inks) {
      for (const background of [pill, highlight]) {
        expect(
          wcagContrast(ink, background),
          `${ink} sur ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Le fond de highlight est le POINT DUR : `marine.raised` (#E2E9F2), qu'une rédaction
    // antérieure du socle donnait en exemple, ferait tomber l'encre inactive à 4,48:1. Le témoin
    // dit que ce test SAIT le voir — sans lui, un seuil mal placé passerait inaperçu.
    expect(wcagContrast(INACTIVE, '#E2E9F2')).toBeLessThan(4.5);
    expect(wcagContrast(INACTIVE, highlight)).toBeGreaterThanOrEqual(4.5);
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

  it('pendant un DRAG, la navigation programmatique ne recale JAMAIS le doigt', async () => {
    /*
     * Le doigt est PROPRIÉTAIRE du highlight pendant un drag. Si un deep link (ou une action
     * Bob à la voix) change l'onglet actif à ce moment-là, recaler l'indicateur SOUS le doigt
     * le ferait sauter — c'est la garde `isDragging` de l'effet de navigation.
     */
    const harness = await mount({ activeKey: 'index' });
    const pan = hoisted.gestures['pan'] as Record<string, Handler> | undefined;
    expect(pan?.['onStart'], 'aucun worklet de pan : le test n’observe rien').toBeTypeOf('function');
    (pan?.['onStart'] as () => void)();
    // Doigt au centre de l'onglet 1 : x = 5 + 71,2 × 1,5 = 111,8 → index 1 (mapping 1:1).
    (pan?.['onUpdate'] as (event: { x: number }) => void)({ x: 111.8 });
    expect(harness.slideIndex.value as number).toBeCloseTo(1, 10);
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
    // Ni ressort, ni recalage : le doigt garde la main jusqu'au relâchement.
    expect(hoisted.springs).toEqual([]);
    expect(harness.slideIndex.value as number).toBeCloseTo(1, 10);
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

  it('sous Reduce Motion, le RELÂCHEMENT du scrub POSE l’index — pas de ressort là non plus', async () => {
    /*
     * Le test précédent couvre le TAP ; celui-ci couvre l'autre chemin de recalage, le
     * `onFinalize` du pan — celui qui recale l'indicateur sur l'entier le plus proche. Sous
     * Reduce Motion il doit POSER la valeur, jamais lancer un ressort.
     */
    const harness = await mount({ activeKey: 'index', reduceMotion: true });
    const pan = hoisted.gestures['pan'] as Record<string, Handler> | undefined;
    expect(pan?.['onFinalize'], 'aucun worklet de pan : le test n’observe rien').toBeTypeOf('function');
    (pan?.['onStart'] as () => void)();
    // Doigt au centre de l'onglet 3 : x = 5 + 71,2 × 3,5 = 254,2 → index 3 (mapping 1:1).
    (pan?.['onUpdate'] as (event: { x: number }) => void)({ x: 254.2 });
    hoisted.springs.length = 0;
    (pan?.['onFinalize'] as () => void)();
    expect(hoisted.springs).toEqual([]);
    expect(harness.slideIndex.value).toBe(3);
    expect(harness.selected).toEqual(['documents']);
  });
});

describe('3 · scrub — le worklet de geste, exécuté', () => {
  it('mappe le doigt 1:1 — sur les littéraux de la spécification, posés à la main', async () => {
    /*
     * Fenêtre 390, repos : onglet 71,2 pt (pilule 366, contenu 356 — calcul au bloc « 2 »), et
     * le contenu commence à 1 (bordure) + 4 (rangée) = 5. Un doigt à `5 + 71,2 × f` tombe donc
     * à l'index `f − 0,5`, borné à [0 ; 4] :
     *   f = 0,5 → 0 ; 1,5 → 1 ; 2,2 → 1,7 ; 3,9 → 3,4 ; 4,5 → 4 (borne haute).
     * Ces littéraux sont LES MÊMES que ceux qui épinglent `tabIndexAtX` dans la logique pure :
     * c'est par eux que les deux écritures restent d'accord — plus par un appel à la fonction
     * qui produirait l'attendu (la rédaction précédente comparait A à A).
     */
    const harness = await mount();
    const onUpdate = hoisted.gestures['pan']?.['onUpdate'];
    expect(onUpdate, 'aucun worklet de pan : le test n’observe rien').toBeTypeOf('function');
    for (const [factor, expected] of [
      [0.5, 0],
      [1.5, 1],
      [2.2, 1.7],
      [3.9, 3.4],
      [4.5, 4],
    ] as const) {
      (onUpdate as (event: { x: number }) => void)({ x: 5 + 71.2 * factor });
      expect(harness.slideIndex.value as number, `f=${factor}`).toBeCloseTo(expected, 10);
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
    expect(onUpdate, 'aucun worklet de pan : le test n’observe rien').toBeTypeOf('function');
    onStart?.();
    /*
     * SOIXANTE-ET-UNE frames balaient l'index de 0 à 4 : le doigt va de `5 + 71,2 × 0,5` à
     * `5 + 71,2 × 4,5` (mêmes littéraux que le mapping ci-dessus). L'index ARRONDI ne change
     * qu'aux QUATRE demi-frontières — 0,5 ; 1,5 ; 2,5 ; 3,5 — donc quatre ticks, posés à la
     * main, et pas un de plus. (La rédaction précédente construisait l'attendu avec
     * `boundaryTick(…, tabIndexAtX(…))` — les fonctions testées elles-mêmes.)
     */
    for (let step = 0; step <= 60; step += 1) {
      const factor = 0.5 + (step / 60) * 4;
      onUpdate?.({ x: 5 + 71.2 * factor });
    }
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

  it('borne la sélection aux onglets RÉELS — un index hors bornes choisit le plus proche', async () => {
    /*
     * Une valeur partagée peut revenir HORS BORNES du pont natif — overshoot d'un ressort
     * sous-amorti, écriture étrangère. `selectIndex` doit alors choisir l'onglet réel le PLUS
     * PROCHE, jamais lire `items[10]` (undefined → aucune sélection, en silence).
     */
    const harness = await mount({ activeKey: 'index' });
    const pan = hoisted.gestures['pan'] as Record<string, Handler> | undefined;
    expect(pan?.['onFinalize'], 'aucun worklet de pan : le test n’observe rien').toBeTypeOf('function');
    (pan?.['onStart'] as () => void)();
    harness.slideIndex.value = 9.7;
    (pan?.['onFinalize'] as () => void)();
    expect(harness.selected).toEqual(['assistant']);
    // Et par le bas : −3,2 arrondi à −3, borné à 0 → le premier onglet.
    (pan?.['onStart'] as () => void)();
    harness.slideIndex.value = -3.2;
    (pan?.['onFinalize'] as () => void)();
    expect(harness.selected).toEqual(['assistant', 'index']);
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

/**
 * ─── 3bis · LES QUATRE SEUILS — CE QUI DÉPARTAGE LE TAP DU SCRUB ────────────────────────────
 *
 * Aucun test ne les posait : le doublon de `react-native-gesture-handler` déclarait les quatre
 * réglages en `passthrough`, donc JETAIT leurs arguments. Un composant qui aurait oublié les
 * quatre appels passait toute la suite sans qu'une seule assertion bouge.
 *
 * CE QU'ILS CHANGENT — LU DANS LE PAQUET INSTALLÉ, PAS SUPPOSÉ :
 *  · `activeOffsetX ±6` et `failOffsetY ±14` rendent le pan DIRECTIONNEL. Sans eux, le pan
 *    s'active au slop du système, quelle que soit la direction (`PanGestureHandler.kt` :
 *    `minDist = vc.scaledTouchSlop`) : un défilement d'écran commencé sur la pilule serait capté
 *    par le scrub au lieu de rester au `ScrollView`.
 *  · `maxDistance 16` AJOUTE une borne qui n'existe pas par défaut. Sans `maxDist`, le contrôle
 *    de distance est purement SAUTÉ — iOS `RNTapHandler.m` (`NAN` + `TEST_MAX_IF_NOT_NAN`),
 *    Android `TapGestureHandler.kt` (`MAX_VALUE_IGNORE`), web (`MIN_SAFE_INTEGER`) — et un long
 *    glissement finissant sur la barre passerait pour un tap. Avec la borne il échoue, et le pan
 *    prend la main : c'est ce qui départage les deux gestes de la course.
 *  · `maxDuration 400` RESSERRE le défaut de 500 ms (iOS `defaultMaxDuration = 0.5`, Android
 *    `DEFAULT_MAX_DURATION_MS = 500`) : au-delà, c'est un appui long, plus un tap.
 *
 * Les quatre nombres sont écrits À LA MAIN. Les comparer aux constantes importées reviendrait à
 * demander au composant s'il est d'accord avec lui-même.
 */
describe('3bis · les quatre SEUILS de geste, réellement posés sur le détecteur', () => {
  it('le PAN gagne à ±6 pt horizontaux et ÉCHOUE à ±14 pt verticaux', async () => {
    await mount();
    // Symétriques : un gaucher scrube vers la gauche aussi souvent qu'un droitier vers la droite.
    expect(hoisted.gestureConfig['pan']?.['activeOffsetX']).toEqual([[-6, 6]]);
    // 14 pt vertical → le pan ÉCHOUE et c'est le scroll de l'écran qui garde le geste.
    expect(hoisted.gestureConfig['pan']?.['failOffsetY']).toEqual([[-14, 14]]);
  });

  it('le TAP est BORNÉ à 16 pt de glissement et 400 ms — sans quoi un scrub finirait en tap', async () => {
    await mount();
    expect(hoisted.gestureConfig['tap']?.['maxDistance']).toEqual([16]);
    expect(hoisted.gestureConfig['tap']?.['maxDuration']).toEqual([400]);
  });

  it('les quatre réglages sont posés sur le BON geste, et une seule fois chacun', async () => {
    await mount();
    /*
     * On lit la SUITE des appels, pas l'état final : deux appels au même réglage laisseraient
     * le même état et se verraient ici. L'ORDRE n'a aucune importance fonctionnelle — il est
     * figé avec le reste parce que c'est ce qui rend « une seule fois chacun » observable en une
     * assertion. Un `maxDistance` posé sur le pan, ou un `activeOffsetX` sur le tap, ne réglerait
     * rien du tout : chaque réglage n'existe que sur son geste.
     */
    expect(hoisted.gestureCalls['pan']).toEqual(['activeOffsetX', 'failOffsetY']);
    expect(hoisted.gestureCalls['tap']).toEqual(['maxDistance', 'maxDuration']);
  });
});

describe('4 · flou de bord — la retombée du kit, déclarée AVANT le chrome', () => {
  it('est rendue et ne capte aucune touche', async () => {
    const harness = await mount();
    const falloff = byTestID(harness.renderer, 'bar-falloff');
    expect(falloff).toBeDefined();
    expect(falloff?.props['pointerEvents']).toBe('none');
  });

  it('son enveloppe est dimensionnée sur l’état le PLUS HAUT du chrome — 122 pt, et elle ne bouge pas', async () => {
    /*
     * `edgeFalloffHeight = inset + hauteur ÉTENDUE du chrome + débord` : inset bas
     * `max(34 − 16, 12)` = 18, chrome ÉTENDU 60 (jamais les 46 du repli), débord 44 (token
     * livré) → 18 + 60 + 44 = 122. Le repli se produit À L'INTÉRIEUR de l'enveloppe : une
     * enveloppe qui suivrait l'état replié (18 + 46 + 44 = 108) serait recalculée par frame —
     * une animation de layout que la règle « jamais animée » interdit.
     */
    const harness = await mount();
    const falloff = byTestID(harness.renderer, 'bar-falloff');
    expect(falloff, 'aucune retombée rendue : le test n’observe rien').toBeDefined();
    expect(styleOf(falloff)['height']).toBe(122);
    harness.setProgress(1);
    await harness.refresh();
    expect(styleOf(byTestID(harness.renderer, 'bar-falloff'))['height']).toBe(122);
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
    const labelColor = (key: string): unknown => {
      const tab = byTestID(harness.renderer, `bar-tab-${key}`);
      const label = flatten(tab ?? null).find((node) => node.type === 'Animated.Text');
      expect(label, `${key} : aucun label rendu — le test n’observe rien`).toBeDefined();
      return styleOf(label)['color'];
    };

    harness.slideIndex.value = 1.5;
    await harness.refresh();
    /*
     * À mi-course, DEUX onglets sont à MI-TEINTE — ce qu'un booléen de focus ne produit jamais.
     * Le mélange sRGB à t = 0,5 entre l'encre inactive #5B6B7B (91, 107, 123) et l'encre active
     * #0C2340 (12, 35, 64), composante par composante et À LA MAIN :
     *   R (91 + 12) / 2 = 51,5 → 52 = 0x34 ; V (107 + 35) / 2 = 71 = 0x47 ;
     *   B (123 + 64) / 2 = 93,5 → 94 = 0x5E   →   #34475E.
     * (La rédaction précédente posait `mixTint(…, highlightProximity(…))` — les fonctions
     * mêmes que ce test veut surveiller, jusque dans le doublon d'`interpolateColor`.)
     */
    expect(labelColor('clients')).toBe('#34475E');
    expect(labelColor('argent')).toBe('#34475E');
    // Et l'onglet FOCUSÉ (index 0) est éteint — l'encre inactive du socle, en littéral.
    expect(labelColor('index')).toBe('#5B6B7B');
  });

  it('l’indigo de l’Assistant survit à l’interpolation', async () => {
    const harness = await mount({ activeKey: 'index' });
    harness.slideIndex.value = 4;
    await harness.refresh();
    const tab = byTestID(harness.renderer, 'bar-tab-assistant');
    const label = flatten(tab ?? null).find((node) => node.type === 'Animated.Text');
    expect(label, 'aucun label rendu : le test n’observe rien').toBeDefined();
    // Le littéral du socle : `semantic.ai` — la règle Bob que la référence n'a pas.
    expect(styleOf(label)['color']).toBe('#4338CA');
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
    expect(overlay, 'aucun calque de glyphe actif : le test n’observe rien').toBeDefined();
    // 1 − min(|2,25 − 2| ; 1) = 0,75 — un quart de largeur d'onglet, trois quarts d'allumage.
    // (Rédaction précédente : l'attendu sortait de `highlightProximity(…)`, la fonction testée.)
    expect(styleOf(overlay)['opacity']).toBeCloseTo(0.75, 10);
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

  it('le `Pressable` RE-ÉTEND la barre — le chemin unique de VoiceOver, TalkBack et du clavier', async () => {
    /*
     * Sous lecteur d'écran, le détecteur de geste n'est pas monté : `onPress` est le SEUL
     * chemin de sélection. Toute interaction délibérée avec la barre la ré-étend — sans le
     * `setMinimized(minimize, 0)` de ce chemin, un utilisateur de VoiceOver garderait une barre
     * repliée après avoir navigué, sans aucun geste pour la rouvrir.
     */
    const harness = await mount({ activeKey: 'index', screenReaderActive: true });
    harness.setProgress(1);
    await harness.refresh();
    const tab = byTestID(harness.renderer, 'bar-tab-argent');
    const onPress = tab?.props['onPress'] as (() => void) | undefined;
    expect(onPress, 'aucun `onPress` sur l’onglet : le test n’observe rien').toBeTypeOf('function');
    await act(async () => {
      (onPress as () => void)();
    });
    // Progression ET cible reviennent à 0 : la barre s'est ré-étendue — et la sélection a eu lieu.
    expect(harness.progress.value).toBe(0);
    expect(harness.target.value).toBe(0);
    expect(harness.selected).toEqual(['argent']);
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

  it('la sonde du MOT LE PLUS LONG rend le MOT — jamais le label entier', async () => {
    /*
     * Les cinq destinations réelles n'ont que des labels d'UN seul mot : sur elles, mot le plus
     * long et label entier se confondent, et une sonde qui rendrait le label entier resterait
     * invisible à tous les tests qui les emploient. La barre est GÉNÉRIQUE : un label à deux
     * mots la démasque. « Suivi chantier » → le mot le plus long est « chantier » (8 lettres
     * contre 5), posé ici en LITTÉRAL.
     */
    const items = [
      ...ITEMS.slice(0, 1),
      { key: 'chantiers', label: 'Suivi chantier', icon: glyph('crane') },
      ...ITEMS.slice(2),
    ];
    hoisted.isReduceMotionEnabled.mockResolvedValue(false);
    hoisted.isScreenReaderEnabled.mockResolvedValue(false);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        createElement(
          ThemeProvider,
          null,
          createElement(BobTabBar, {
            items,
            activeKey: 'index',
            onSelect: () => undefined,
            testID: 'bar',
          }),
        ),
      );
    });
    const probes = flatten(
      byTestID(renderer as ReactTestRenderer, 'bob-tab-bar-label-probes') ?? null,
    ).filter((node) => node.type === 'Text');
    expect(probes, 'aucune sonde rendue : le test n’observe rien').toHaveLength(10);
    const texts = probes.map((probe) => (probe.children ?? [])[0]);
    // Famille 1 (largeur NATURELLE) : le label entier. Famille 2 : le MOT le plus long.
    expect(texts[1]).toBe('Suivi chantier');
    expect(texts[6]).toBe('chantier');
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
    /*
     * Labels courts, une seule ligne. Contenu MESURÉ = 23 (glyphe) + 3 (rythme intérieur) + 12
     * (ligne) = 38 pt, SOUS le plancher de 50 : c'est donc le plancher qui gagne, et les trois
     * chiffres du socle sont ceux-là — visuel 50, boîte intérieure 50 + 2×4 = 58, rectangle
     * mesuré 58 + 2×1 = 60.
     */
    await feedProbes(harness, { width: 30, height: LINE_AT_100 });
    harness.setProgress(0);
    await harness.refresh();
    expect(visualHeight(harness.renderer, 'argent')).toBe(50);
    expect(styleOf(byTestID(harness.renderer, 'bar-tab-argent'))['height']).toBe(50);
    const measured = styleOf(byTestID(harness.renderer, 'bar-pill'))['height'] as number;
    expect(measured).toBe(60);
    // Le 58 du titre est la boîte INTÉRIEURE : le rectangle mesuré moins les deux bordures.
    expect(measured - 2 * 1).toBe(58);

    /*
     * ─── TÉMOIN — SANS LUI, CE TEST NE PROUVE RIEN DE B4 ────────────────────────────────────
     * 50 / 58 / 60 sont des PLANCHERS. Une barre entièrement SOURDE à la mesure les rendrait à
     * l'identique : le mutant qui retire `expandedContentHeight` / `minimizedContentHeight` du
     * `metrics` laissait donc les trois assertions ci-dessus VERTES. On refait ici la même
     * passe avec UNE SEULE chose de changée — la hauteur rendue par la sonde — et on exige un
     * AUTRE nombre : contenu 23 + 3 + 40 = 66 pt, qui dépasse le plancher et doit passer devant ;
     * pilule 66 + 2×4 + 2×1 = 76 pt.
     */
    const witness = await mount();
    await feedProbes(witness, { width: 30, height: 40 });
    witness.setProgress(0);
    await witness.refresh();
    expect(visualHeight(witness.renderer, 'argent')).toBe(66);
    expect(styleOf(byTestID(witness.renderer, 'bar-tab-argent'))['height']).toBe(66);
    expect(styleOf(byTestID(witness.renderer, 'bar-pill'))['height']).toBe(76);
  });

  it('à ~200 % sur DEUX lignes, la pilule grandit — 58 pt était un plancher', async () => {
    const harness = await mount();
    hoisted.fontScale.value = 2;
    await harness.refresh();
    /*
     * Largeur d'onglet au repos, calculée à la main : (390 − 2×12 − 2×1 − 2×4) / 5 = 71,2 pt.
     * Largeur naturelle du label 100 pt → il ne tient pas sur UNE ligne. Le mot le plus long
     * tient (40 ≤ 71,2), et 100 ≤ 2 × 71,2 : rang DEUX LIGNES, « la pilule grandit d'autant ».
     * Hauteur de ligne 24 pt → contenu = 23 + 3 + 2×24 = 74 pt, pilule 74 + 2×4 + 2×1 = 84 pt.
     */
    await feedProbesSplit(
      harness,
      { width: 100, height: LINE_AT_200 },
      { width: 40, height: LINE_AT_200 },
    );
    harness.setProgress(0);
    await harness.refresh();

    expect(visualHeight(harness.renderer, 'argent')).toBe(74);
    // Le `Pressable` suit le contenu — le plancher de 44 est LARGEMENT dépassé, et c'est le but.
    expect(styleOf(byTestID(harness.renderer, 'bar-tab-argent'))['height']).toBe(74);
    expect(styleOf(byTestID(harness.renderer, 'bar-pill'))['height']).toBe(84);
    // Et elle est bien PLUS HAUTE que les 60 pt de la taille standard : le plafond a sauté.
    expect(styleOf(byTestID(harness.renderer, 'bar-pill'))['height'] as number).toBeGreaterThan(60);
    // Le label est toujours là, sur deux lignes, sans rétrécissement automatique.
    const label = nodes(harness.renderer).find((node) => node.type === 'Animated.Text');
    expect(label?.props['numberOfLines']).toBe(2);
    expect(label?.props['adjustsFontSizeToFit']).toBeUndefined();
  });

  /**
   * DEUXIÈME PRÉMISSE du bloc « overflow » ci-dessus : la BOÎTE VISUELLE en HAUTEUR — celle qui
   * rend ses ciseaux inoffensifs. La rédaction précédente écrivait `visuel ≥ 23 + 3 + ligne` :
   * à 24 pt de ligne, le contenu vaut EXACTEMENT 50, c'est-à-dire le plancher, et l'assertion
   * était satisfaite par une barre sourde à toute mesure. Ici les deux RÉGIMES sont séparés et
   * chacun est comparé à un littéral, égalité comprise.
   */
  it('la boîte visuelle NE ROGNE RIEN au repos — les deux régimes, à l’égalité près', async () => {
    // RÉGIME 1 · LE PLANCHER GAGNE. Ligne 12 pt → contenu 23 + 3 + 12 = 38 pt ; la boîte vaut
    // 50 pt, soit 12 pt de MARGE au-dessus du contenu : les ciseaux ne rencontrent rien.
    const standard = await mount();
    await feedProbes(standard, { width: 30, height: LINE_AT_100 });
    standard.setProgress(0);
    await standard.refresh();
    expect(visualHeight(standard.renderer, 'argent')).toBe(50);
    expect(visualHeight(standard.renderer, 'argent') as number).toBeGreaterThan(
      23 + 3 + LINE_AT_100,
    );

    // RÉGIME 2 · LA MESURE GAGNE. Ligne 30 pt → contenu 23 + 3 + 30 = 56 pt, AU-DESSUS du
    // plancher : la boîte doit valoir 56 EXACTEMENT — 50 couperait 6 pt de texte, davantage
    // mentirait sur ce qu'elle mesure. C'est ce régime, et lui seul, qui prouve que la mesure
    // est branchée : sans lui, une barre qui rendrait toujours 50 passerait.
    const large = await mount();
    await feedProbes(large, { width: 30, height: 30 });
    large.setProgress(0);
    await large.refresh();
    expect(visualHeight(large.renderer, 'argent')).toBe(56);
    expect(styleOf(byTestID(large.renderer, 'bar-tab-argent'))['height']).toBe(56);
    expect(styleOf(byTestID(large.renderer, 'bar-pill'))['height']).toBe(66);
  });

  it('à ~200 %, le PALIER passe en icônes seules quand un MOT ne tient plus', async () => {
    const harness = await mount();
    hoisted.fontScale.value = 2;
    await harness.refresh();
    /*
     * TÉMOIN D'ABORD. À la MÊME échelle, un label qui tient sur deux lignes fait GRANDIR la
     * barre : contenu 23 + 3 + 2×24 = 74, pilule 84. Sans ce premier temps, le second (« la
     * pilule vaut 60 ») serait vrai même si la mesure n'était jamais branchée — 60 est le
     * PLANCHER, et c'est exactement pour cela que le mutant survivait ici.
     */
    await feedProbesSplit(
      harness,
      { width: 100, height: LINE_AT_200 },
      { width: 40, height: LINE_AT_200 },
    );
    harness.setProgress(0);
    await harness.refresh();
    expect(styleOf(byTestID(harness.renderer, 'bar-pill'))['height']).toBe(84);

    /*
     * PUIS le mot le plus long dépasse la largeur d'onglet — 200 pt contre 71,2. Deux lignes ne
     * sauveraient rien : un mot ne se coupe pas. Rang trois, le label est RETIRÉ, jamais tronqué.
     * (La taille système monte encore d'un cran : le composant JETTE alors ses mesures et
     * remonte la sonde. C'est ce qui permet ici de re-mesurer une barre déjà mesurée.)
     */
    hoisted.fontScale.value = 3;
    await harness.refresh();
    await feedProbes(harness, { width: 200, height: 36 });
    expect(nodes(harness.renderer).filter((node) => node.type === 'Animated.Text')).toHaveLength(0);
    harness.setProgress(0);
    await harness.refresh();
    // Plus de label : le contenu retombe au seul glyphe (23 pt) et les PLANCHERS reprennent la
    // main — visuel 50, pilule 60. La barre REDESCEND donc de 84 à 60, ce qu'une barre sourde à
    // la mesure ne pourrait pas faire : elle n'aurait jamais quitté 60.
    expect(visualHeight(harness.renderer, 'argent')).toBe(50);
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
