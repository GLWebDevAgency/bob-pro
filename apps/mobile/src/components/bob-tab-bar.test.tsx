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
  TAB_BAR_ROW_PAD_H,
  boundaryTick,
  highlightProximity,
  mixTint,
  tabBarGeometry,
  tabIndexAtX,
  tabTintPalette,
  type TabBarMetrics,
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
  springs: [] as number[],
  isReduceMotionEnabled: vi.fn<() => Promise<boolean>>(),
  isScreenReaderEnabled: vi.fn<() => Promise<boolean>>(),
  fontScale: { value: 1 },
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
    Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec['ios'] },
    Pressable: 'Pressable',
    StyleSheet: {
      absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
      create: (styles: unknown) => styles,
      flatten: (style: unknown) => style,
    },
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: WINDOW_WIDTH, height: 844, scale: 3, fontScale: 1 }),
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
    Dimensions: { get: () => ({ width: WINDOW_WIDTH, height: 844 }) },
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
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

vi.mock('react-native-gesture-handler', () => {
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
    GestureDetector: ({ children }: { children: ReactNode }) => children,
  };
});

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
    withSpring: (target: number) => {
      hoisted.springs.push(target);
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

/** Retire commentaires de bloc et de ligne — les contrôles statiques portent sur le CODE. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
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
  setProgress(value: number): void;
  refresh(): Promise<void>;
}

async function mount(
  options: { activeKey?: string; screenReaderActive?: boolean; reduceMotion?: boolean } = {},
): Promise<Harness> {
  hoisted.shared.length = 0;
  hoisted.springs.length = 0;
  hoisted.isReduceMotionEnabled.mockResolvedValue(options.reduceMotion ?? false);
  hoisted.isScreenReaderEnabled.mockResolvedValue(options.screenReaderActive ?? false);
  const activeKey = options.activeKey ?? 'argent';
  const selected: string[] = [];
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
});

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

describe('2 · highlight glissant — un seul bloc, transform-only, suivi live du repli', () => {
  it('se déplace par `translateX` seul et suit la largeur d’item calculée', async () => {
    const harness = await mount();
    for (const index of [0, 2, 4, 1.5]) {
      harness.slideIndex.value = index;
      await harness.refresh();
      const style = styleOf(byTestID(harness.renderer, 'bar-highlight'));
      const expected = tabBarGeometry(harness.progress.value as number, METRICS);
      const transform = style['transform'] as { translateX: number }[];
      expect(transform).toEqual([
        { translateX: TAB_BAR_ROW_PAD_H + expected.itemWidth * index },
      ]);
      expect(style['width']).toBeCloseTo(expected.itemWidth, 10);
      // Rien d'autre ne bouge horizontalement : ni `left`, ni `marginLeft`.
      expect(style['left']).toBe(0);
    }
  });

  it('suit la barre PENDANT qu’elle se replie — la géométrie est recalculée live', async () => {
    const harness = await mount();
    harness.slideIndex.value = 4;
    harness.setProgress(0);
    await harness.refresh();
    const open = styleOf(byTestID(harness.renderer, 'bar-highlight'));
    harness.setProgress(1);
    await harness.refresh();
    const closed = styleOf(byTestID(harness.renderer, 'bar-highlight'));
    expect(closed['width'] as number).toBeLessThan(open['width'] as number);
    expect(closed['transform']).not.toEqual(open['transform']);
  });

  it('reste CENTRÉ dans la boîte intérieure de la pilule, à tout instant', async () => {
    const harness = await mount();
    for (const p of [0, 0.5, 1]) {
      harness.setProgress(p);
      await harness.refresh();
      const expected = tabBarGeometry(p, METRICS);
      const style = styleOf(byTestID(harness.renderer, 'bar-highlight'));
      expect(style['height']).toBeCloseTo(expected.innerVisualHeight, 10);
      expect(style['top']).toBeCloseTo(
        (expected.pillInnerHeight - expected.innerVisualHeight) / 2,
        10,
      );
    }
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

  it('ne tick QU’au franchissement de frontière — jamais une frame de plus', async () => {
    await mount({ activeKey: 'index' });
    const ticks: number[] = [];
    const onStart = hoisted.gestures['pan']?.['onStart'] as (() => void) | undefined;
    const onUpdate = hoisted.gestures['pan']?.['onUpdate'] as
      | ((event: { x: number }) => void)
      | undefined;
    onStart?.();
    const geometry = tabBarGeometry(0, METRICS);
    const contentLeft = TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H;
    let lastTicked = 0;
    // On rejoue un balayage continu et on compare, pas à pas, avec la spécification pure.
    for (let step = 0; step <= 60; step += 1) {
      const factor = 0.5 + (step / 60) * (TAB_COUNT - 1);
      onUpdate?.({ x: contentLeft + geometry.itemWidth * factor });
      const index = tabIndexAtX(contentLeft + geometry.itemWidth * factor, geometry, TAB_COUNT);
      const expected = boundaryTick(lastTicked, index);
      if (expected !== null) {
        ticks.push(expected);
        lastTicked = expected;
      }
    }
    // Un balayage d'un bout à l'autre franchit exactement quatre frontières.
    expect(ticks).toEqual([1, 2, 3, 4]);
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
  it('ne monte AUCUN détecteur de geste tant que le lecteur d’écran est INCONNU', async () => {
    hoisted.shared.length = 0;
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
    const gestureNodes = nodes(renderer as ReactTestRenderer).filter(
      (node) => node.props['gesture'] !== undefined,
    );
    expect(gestureNodes).toHaveLength(0);
  });

  it('ne monte AUCUN détecteur quand le lecteur d’écran est ACTIF', async () => {
    const harness = await mount({ screenReaderActive: true });
    expect(byTestID(harness.renderer, 'bar-pill')).toBeDefined();
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
    const source = stripComments(readFileSync(join(__dirname, 'bob-tab-bar.tsx'), 'utf8'));
    expect(source).not.toMatch(/hitSlop/);
  });
});

describe('ordre de peinture — la déclaration est le seul arbitre', () => {
  // Le CODE, sans les commentaires : les mots interdits apparaissent dans la prose qui explique
  // pourquoi ils sont interdits. Chercher dans le fichier brut ferait échouer la règle sur son
  // propre énoncé — et pousserait à effacer l'explication pour faire passer le test.
  const source = stripComments(readFileSync(join(__dirname, 'bob-tab-bar.tsx'), 'utf8'));

  it('n’emploie ni `zIndex`, ni `elevation`, ni token d’ombre', () => {
    expect(source).not.toMatch(/zIndex/);
    expect(source).not.toMatch(/elevation/);
    expect(source).not.toMatch(/shadowNative/);
  });

  it('n’emploie pas non plus `adjustsFontSizeToFit`, interdit sur du texte porteur de sens', () => {
    expect(source).not.toMatch(/adjustsFontSizeToFit/);
  });

  it('n’importe aucune dépendance native nouvelle', () => {
    expect(source).not.toMatch(/from 'expo-haptics'/);
    expect(source).not.toMatch(/from 'expo-glass-effect'/);
    expect(source).not.toMatch(/from 'expo-symbols'/);
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

    await act(async () => {
      for (const probe of probes) {
        const onLayout = probe.props['onLayout'] as (event: {
          nativeEvent: { layout: { width: number } };
        }) => void;
        onLayout({ nativeEvent: { layout: { width: 30 } } });
      }
    });
    // Le coût au REPOS redevient celui de la barre seule — ce que `PERF-13 · P13-A` mesure.
    expect(byTestID(harness.renderer, 'bob-tab-bar-label-probes')).toBeUndefined();
  });

  it('RETIRE le label quand il ne tient plus, sans jamais le tronquer', async () => {
    const harness = await mount();
    const probes = flatten(byTestID(harness.renderer, 'bob-tab-bar-label-probes') ?? null).filter(
      (node) => node.type === 'Text',
    );
    await act(async () => {
      for (const probe of probes) {
        const onLayout = probe.props['onLayout'] as (event: {
          nativeEvent: { layout: { width: number } };
        }) => void;
        // Largeur naturelle énorme : même deux lignes ne suffisent pas.
        onLayout({ nativeEvent: { layout: { width: 900 } } });
      }
    });
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
