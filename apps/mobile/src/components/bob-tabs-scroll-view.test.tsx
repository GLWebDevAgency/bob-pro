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

  /** Les cinq destinations réelles, dans l'ordre où le navigateur les monte. */
  const TABS = ['index', 'clients', 'argent', 'documents', 'assistant'] as const;

  /**
   * LE PIÈGE D'ORDRE, ET POURQUOI CE TEST EST ÉCRIT AINSI.
   *
   * Le registre n'a qu'UNE case : le DERNIER qui s'enregistre gagne. La rédaction précédente
   * montait deux écrans, `blurred` PUIS `focused` — c'est-à-dire le bon en dernier. La garde
   * `!focused` retirée, les deux s'enregistraient, le focusé écrasait l'autre… et la bonne vue
   * remontait quand même. Le test restait VERT alors que la garde n'existait plus.
   *
   * Ici l'écran focusé est monté au MILIEU des cinq : deux écrans flous s'enregistrent APRÈS
   * lui. Sans la garde, c'est `assistant` — le dernier monté — qui remonterait, et l'utilisateur
   * verrait l'écran d'à côté sauter en haut pendant que le sien ne bouge pas.
   */
  async function mountFive(focusedTab: string): Promise<{
    calls: Record<string, { y: number }[]>;
    scrollToTop: () => void;
    focus: (next: string) => Promise<void>;
  }> {
    const calls: Record<string, { y: number }[]> = Object.fromEntries(
      TABS.map((name) => [name, [] as { y: number }[]]),
    );
    let scrollToTop: (() => void) | undefined;
    function Probe(): null {
      scrollToTop = useTabScrollTop();
      return null;
    }
    const tree = (current: string): ReturnType<typeof createElement> =>
      createElement(
        TabScrollTopProvider,
        null,
        createElement(Probe),
        // CINQ écrans montés EN MÊME TEMPS : c'est l'arbre réel d'un navigateur d'onglets.
        ...TABS.map((name) =>
          createElement(Screen, { key: name, focused: name === current, testID: name }),
        ),
      );
    let renderer: ReactTestRenderer | undefined;
    /*
     * `react-test-renderer` rend `null` pour les `ref` d'hôtes tant qu'aucun `createNodeMock`
     * n'est fourni : sans lui, la vue s'enregistrerait avec `null` et le test serait vert pour
     * la mauvaise raison. Le mock rend la seule méthode que la couture appelle.
     */
    await act(async () => {
      renderer = create(tree(focusedTab), {
        createNodeMock: (element) => {
          const id = String((element.props as { testID?: string }).testID);
          return { scrollTo: (options: { y: number }) => calls[id]?.push(options) };
        },
      });
    });
    return {
      calls,
      scrollToTop: () => scrollToTop?.(),
      focus: async (next: string) => {
        await act(async () => {
          (renderer as ReactTestRenderer).update(tree(next));
        });
      },
    };
  }

  it('remonte la vue FOCUSÉE, et seulement elle', async () => {
    // `argent` est le TROISIÈME des cinq : deux écrans flous se montent après lui.
    const app = await mountFive('argent');
    await act(async () => {
      app.scrollToTop();
    });
    expect(app.calls['argent']).toEqual([{ y: 0, animated: true }]);
    for (const name of TABS.filter((tab) => tab !== 'argent')) {
      expect(app.calls[name], `${name} ne doit pas bouger`).toEqual([]);
    }
  });

  it('SUIT le focus quand il change — l’ancien écran rend la main, le nouveau la prend', async () => {
    const app = await mountFive('argent');
    await app.focus('clients');
    await act(async () => {
      app.scrollToTop();
    });
    // Ce que ce second test attrape et que le premier ne peut pas : un enregistrement qui ne se
    // REFAIT pas quand le focus bouge (garde correcte, mais `focused` absent des dépendances de
    // l'effet) laisserait `argent` inscrit pour toujours.
    expect(app.calls['clients']).toEqual([{ y: 0, animated: true }]);
    expect(app.calls['argent']).toEqual([]);
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
