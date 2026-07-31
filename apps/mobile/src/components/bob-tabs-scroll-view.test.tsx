/**
 * LA COUTURE DE BRANCHEMENT, VÉRIFIÉE — parce qu'un comportement non monté n'est pas livré.
 *
 * CE FICHIER PROUVE TROIS CHOSES QU'AUCUN AUTRE NE PEUT PROUVER :
 *  · que le pilote de repli est RÉELLEMENT attaché à la vue défilante sous le flag, et
 *    RÉELLEMENT absent hors flag — condition de validité de la comparaison `PERF-13` ;
 *  · que le retap sur l'onglet actif remonte la vue FOCUSÉE, et elle seule ;
 *  · que hors flag, l'arbre rendu est celui d'avant : un `ScrollView` nu, sans `onScroll`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hoisted = vi.hoisted(() => ({
  flag: { value: '1' as string | undefined },
  scrolls: [] as unknown[],
}));

vi.mock('react-native', () => ({
  ScrollView: 'ScrollView',
  View: 'View',
}));

vi.mock('react-native-reanimated', () => ({
  default: { ScrollView: 'Animated.ScrollView' },
  ScrollView: 'Animated.ScrollView',
  useSharedValue: (initial: unknown) => ({ value: initial }),
  // Le doublon rend l'objet de handlers tel quel : le test peut donc constater qu'il a bien été
  // POSÉ sur la vue, et lequel — pas seulement qu'un `onScroll` quelconque existe.
  useAnimatedScrollHandler: (handlers: unknown) => {
    hoisted.scrolls.push(handlers);
    return handlers;
  },
  withSpring: (target: number) => target,
}));

vi.mock('@bob/ui', () => ({
  MINIMIZE_DEAD_ZONE: 3,
  MINIMIZE_TOP_GUARD: 24,
  TAB_BAR_MINIMIZE_SPRING: { duration: 380, dampingRatio: 1 },
}));

vi.mock('./bob-tab-bar-flag', () => ({
  isMobileTabsExperimentEnabled: () => hoisted.flag.value === '1',
}));

const { TabScrollTopProvider, TabSceneFocus, TabsScrollView, useTabScrollTop } = await import(
  './bob-tabs-scroll-view'
);

interface Node {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly Node[] | null;
}

function flatten(node: unknown): readonly Node[] {
  if (node === null || node === undefined) return [];
  if (Array.isArray(node)) return node.flatMap((child) => flatten(child));
  if (typeof node !== 'object') return [];
  const single = node as Node;
  return [single, ...flatten(single.children ?? null)];
}

beforeEach(() => {
  hoisted.flag.value = '1';
  hoisted.scrolls.length = 0;
});

async function render(element: ReturnType<typeof createElement>): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(element);
  });
  return renderer as ReactTestRenderer;
}

describe('1 · le repli au scroll est RÉELLEMENT branché — et seulement sous le flag', () => {
  it('flag ON : la vue est animée et porte le gestionnaire du pilote', async () => {
    const renderer = await render(
      createElement(TabsScrollView, { testID: 'scroll' }, createElement('Content')),
    );
    const view = flatten(renderer.toJSON()).find((node) => node.props['testID'] === 'scroll');
    expect(view?.type).toBe('Animated.ScrollView');
    // Le gestionnaire posé est EXACTEMENT celui que `useMinimizeOnScroll` a fabriqué.
    expect(hoisted.scrolls).toHaveLength(1);
    expect(view?.props['onScroll']).toBe(hoisted.scrolls[0]);
    expect(view?.props['scrollEventThrottle']).toBe(16);
  });

  it('flag OFF : `ScrollView` NU, aucun `onScroll` — le bras OFF de PERF-13 ne paie rien', async () => {
    hoisted.flag.value = undefined;
    const props = {
      testID: 'scroll',
      contentContainerStyle: { paddingBottom: 120 },
      scrollIndicatorInsets: { bottom: 96 },
      keyboardShouldPersistTaps: 'handled' as const,
    };
    const renderer = await render(createElement(TabsScrollView, props, createElement('Content')));
    const view = flatten(renderer.toJSON()).find((node) => node.props['testID'] === 'scroll');
    expect(view?.type).toBe('ScrollView');
    expect(view?.props['onScroll']).toBeUndefined();
    expect(view?.props['scrollEventThrottle']).toBeUndefined();
    /*
     * Les props de l'écran arrivent INCHANGÉES, et la couture n'en ajoute qu'UNE : la `ref`,
     * dont elle a besoin pour s'enregistrer comme cible du retour en haut. On l'énumère plutôt
     * que de l'ignorer — « à l'identique » avec une exception non dite serait une demi-vérité.
     */
    expect(view?.props).toEqual({ ...props, ref: expect.any(Function) });
  });

  it('les props de l’écran traversent la couture sans être touchées', async () => {
    const renderer = await render(
      createElement(
        TabsScrollView,
        {
          testID: 'scroll',
          contentContainerStyle: { paddingBottom: 120 },
          keyboardShouldPersistTaps: 'handled',
        },
        createElement('Content'),
      ),
    );
    const view = flatten(renderer.toJSON()).find((node) => node.props['testID'] === 'scroll');
    expect(view?.props['contentContainerStyle']).toEqual({ paddingBottom: 120 });
    expect(view?.props['keyboardShouldPersistTaps']).toBe('handled');
  });
});

describe('retap sur l’onglet actif — retour en haut, ce que la référence ne fait pas', () => {
  /** Un écran d'onglet : le focus descend par le contexte, comme `screenLayout` le fait. */
  function Screen({
    focused,
    testID,
  }: {
    readonly focused: boolean;
    readonly testID: string;
  }): ReturnType<typeof createElement> {
    return createElement(TabSceneFocus, { focused }, createElement(TabsScrollView, { testID }));
  }

  it('remonte la vue FOCUSÉE, et seulement elle', async () => {
    const calls: Record<string, { y: number }[]> = { focused: [], blurred: [] };
    let scrollToTop: (() => void) | undefined;
    function Probe(): null {
      scrollToTop = useTabScrollTop();
      return null;
    }
    /*
     * `react-test-renderer` rend `null` pour les `ref` d'hôtes tant qu'aucun `createNodeMock`
     * n'est fourni : sans lui, la vue s'enregistrerait avec `null` et le test serait vert pour
     * la mauvaise raison. Le mock rend la seule méthode que la couture appelle.
     */
    await act(async () => {
      create(
        createElement(
          TabScrollTopProvider,
          null,
          createElement(Probe),
          // Deux écrans MONTÉS en même temps : c'est le cas réel d'un navigateur d'onglets, et
          // c'est celui où un registre sans focus remonterait le mauvais écran.
          createElement(Screen, { focused: false, testID: 'blurred' }),
          createElement(Screen, { focused: true, testID: 'focused' }),
        ),
        {
          createNodeMock: (element) => {
            const id = String((element.props as { testID?: string }).testID);
            return { scrollTo: (options: { y: number }) => calls[id]?.push(options) };
          },
        },
      );
    });
    await act(async () => {
      scrollToTop?.();
    });
    expect(calls['focused']).toEqual([{ y: 0, animated: true }]);
    expect(calls['blurred']).toEqual([]);
  });

  it('ne jette pas hors provider — un écran rendu seul reste utilisable', async () => {
    let scrollToTop: (() => void) | undefined;
    function Probe(): null {
      scrollToTop = useTabScrollTop();
      return null;
    }
    await render(createElement(Probe));
    expect(() => scrollToTop?.()).not.toThrow();
  });
});
