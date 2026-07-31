/**
 * COMPORTEMENT 5 — LE SLOT QUI S'EFFACE, vérifié sur l'ANIMATION RÉELLEMENT LANCÉE.
 *
 * Le doublon de `withTiming` enregistre chaque appel : on ne relit pas le code, on constate ce
 * qui a été demandé au moteur d'animation — durée, courbe, et surtout le fait qu'il n'y ait
 * AUCUN appel quand il ne doit pas y en avoir.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { motionSemantic } from '@bob/tokens';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hoisted = vi.hoisted(() => ({
  timings: [] as { target: number; duration: number; easing: unknown }[],
  isReduceMotionEnabled: vi.fn<() => Promise<boolean>>(),
}));

/**
 * Le doublon de `react-native` doit couvrir tout le barrel `@bob/ui`, pas seulement ce que ce
 * composant-ci consomme : importer `@bob/ui` charge le barrel ENTIER, et un membre manquant fait
 * échouer la collecte avant le premier test.
 */
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => hoisted.isReduceMotionEnabled(),
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

vi.mock('react-native-reanimated', async () => {
  const react = await import('react');
  const animated = { View: 'Animated.View', Text: 'Animated.Text' };
  return {
    default: animated,
    ...animated,
    Easing: { bezier: (...args: number[]) => `bezier(${args.join(',')})` },
    interpolate: (
      input: number,
      inputRange: readonly number[],
      outputRange: readonly number[],
    ): number => {
      const [i0 = 0, i1 = 1] = inputRange;
      const [o0 = 0, o1 = 0] = outputRange;
      const t = Math.min(Math.max((input - i0) / (i1 - i0), 0), 1);
      return o0 + (o1 - o0) * t;
    },
    useAnimatedStyle: (updater: () => unknown) => updater(),
    useSharedValue: (initial: unknown) => react.useRef({ value: initial }).current,
    withTiming: (target: number, config: { duration: number; easing: unknown }) => {
      hoisted.timings.push({ target, duration: config.duration, easing: config.easing });
      return target;
    },
  };
});

const { BobTabSlotFade } = await import('./bob-tab-slot');

async function mount(focused: boolean): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      createElement(
        BobTabSlotFade,
        { focused, testID: 'slot' },
        createElement('Screen', null),
      ),
    );
  });
  return renderer as ReactTestRenderer;
}

async function update(renderer: ReactTestRenderer, focused: boolean): Promise<void> {
  await act(async () => {
    renderer.update(
      createElement(
        BobTabSlotFade,
        { focused, testID: 'slot' },
        createElement('Screen', null),
      ),
    );
  });
}

beforeEach(() => {
  hoisted.timings.length = 0;
  hoisted.isReduceMotionEnabled.mockResolvedValue(false);
});

describe('5 · fade-through — l’entrant fond, le sortant disparaît', () => {
  it('n’anime PAS le tout premier écran au lancement', async () => {
    await mount(true);
    expect(hoisted.timings).toEqual([]);
  });

  it('anime l’écran entrant en 280 ms avec la courbe `easing.enter` du kit', async () => {
    const renderer = await mount(false);
    await update(renderer, true);
    expect(hoisted.timings).toHaveLength(1);
    expect(hoisted.timings[0]?.duration).toBe(motionSemantic.replace);
    expect(hoisted.timings[0]?.duration).toBe(280);
    // `easing.enter` = `cubic-bezier(0, 0, 0, 1)` — la courbe du kit, pas une bézier inventée.
    expect(hoisted.timings[0]?.easing).toBe('bezier(0,0,0,1)');
    expect(hoisted.timings[0]?.target).toBe(1);
  });

  it('ne recopie PAS le 220 ms de la référence', async () => {
    const renderer = await mount(false);
    await update(renderer, true);
    expect(hoisted.timings[0]?.duration).not.toBe(220);
  });

  it('n’anime JAMAIS l’écran sortant — il est masqué, pas fondu', async () => {
    const renderer = await mount(true);
    await update(renderer, false);
    expect(hoisted.timings).toEqual([]);
  });

  it('n’anime RIEN sous Reduce Motion — l’écran est posé dans son état final', async () => {
    hoisted.isReduceMotionEnabled.mockResolvedValue(true);
    const renderer = await mount(false);
    await update(renderer, true);
    expect(hoisted.timings).toEqual([]);
    // Une passe de plus : la valeur partagée est posée DANS l'effet, donc après le rendu qui
    // vient de se produire. Cette passe-ci relit l'état final — et elle prouve au passage que
    // rien n'est ré-animé quand on re-rend avec le même focus.
    await update(renderer, true);
    expect(hoisted.timings).toEqual([]);
    const root = renderer.toJSON() as unknown as { props: { style: unknown[] } };
    const style = Object.assign({}, ...root.props.style) as Record<string, unknown>;
    expect(style['opacity']).toBe(1);
    expect(style['transform']).toEqual([{ scale: 1 }]);
  });

  it('n’anime RIEN tant que la préférence est INCONNUE — fail-closed au premier rendu', async () => {
    hoisted.isReduceMotionEnabled.mockReturnValue(new Promise(() => undefined));
    const renderer = await mount(false);
    await update(renderer, true);
    expect(hoisted.timings).toEqual([]);
  });

  /**
   * « MASQUÉ » DOIT ÊTRE VRAI, PAS SEULEMENT ÉCRIT. Le commentaire du composant affirmait que
   * l'écran sortant était « masqué instantanément (`display: none` côté conteneur) » : aucun
   * conteneur du dépôt ne pose `display: none`, et une vue à opacité 0 reste PARFAITEMENT
   * tactile. Un doigt qui tombait dessus touchait l'écran d'à côté. La coupure est maintenant
   * faite ici, et elle est prouvée.
   */
  it('l’écran SORTANT ne reçoit plus aucune touche — l’opacité 0 ne suffit pas', async () => {
    const renderer = await mount(true);
    const focusedRoot = renderer.toJSON() as unknown as { props: Record<string, unknown> };
    expect(focusedRoot.props['pointerEvents']).toBe('auto');

    await update(renderer, false);
    const blurredRoot = renderer.toJSON() as unknown as {
      props: Record<string, unknown>;
      // Le style est lu pour montrer que l'opacité, elle, ne suffirait pas.
    };
    expect(blurredRoot.props['pointerEvents']).toBe('none');
  });

  it('applique la micro-échelle 0,985 → 1 : jamais une entrée depuis rien', async () => {
    const renderer = await mount(false);
    const root = renderer.toJSON() as unknown as { props: { style: unknown[] } };
    const style = Object.assign({}, ...root.props.style) as Record<string, unknown>;
    // Écran non focusé : progression 0, donc l'échelle est à son minimum — et ce minimum est
    // 0,985, pas 0. Un écran qui entre depuis une échelle nulle donnerait un « pop » de zoom.
    expect(style['opacity']).toBe(0);
    expect(style['transform']).toEqual([{ scale: 0.985 }]);
  });
});
