/**
 * ProgressiveBlurBob — UN PORT QUI JETTE N'EMPORTE PAS L'ÉCRAN.
 *
 * Le port vient de l'APPLICATION : `packages/ui` ne contrôle pas ce code. S'il lève, React
 * démonte l'arbre et l'écran entier disparaît — sur un écran où l'artisan encaisse une
 * facture. Ce fichier verrouille les DEUX chemins, qu'un seul mécanisme ne couvre pas :
 *
 *   (a) LA FABRIQUE JETTE — l'appel à `renderBlurLayer` lève pendant la construction ;
 *       un `try`/`catch` autour de l'appel l'attrape ;
 *   (b) L'ÉLÉMENT RENDU JETTE — la fabrique rend un élément VALIDE qui lève pendant SON rendu
 *       ou dans un effet ; un `try`/`catch` de l'appelant n'attrape RIEN, il faut une
 *       frontière d'erreur.
 *
 * Chaque cas vérifie les QUATRE mêmes choses : l'écran survit, la surface teintée reste
 * lisible, aucun échantillon de flou ne subsiste, et la dégradation est DÉFINITIVE — un port
 * qui a manqué n'est plus rappelé, sinon on remplace un écran mort par une boucle d'erreurs
 * et un port intermittent fait clignoter l'écran.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useEffect, useState, type ReactElement } from 'react';
import { ThemeProvider } from '../theme';
import { ProgressiveBlurBob, type ProgressiveBlurBobViewProps } from './progressive-blur-bob';
import { defineBlurPort } from './progressive-blur-bob.port';
import { BLUR_PORT_FAILURE_WARNINGS } from './progressive-blur-bob.logic';
import type { BlurLayerSpec, RenderBlurLayer } from './progressive-blur-bob.types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { isReduceMotionEnabled, isReduceTransparencyEnabled, transparencyListeners } = vi.hoisted(
  () => ({
    isReduceMotionEnabled: vi.fn<() => Promise<boolean>>(),
    isReduceTransparencyEnabled: vi.fn<() => Promise<boolean>>(),
    transparencyListeners: new Set<(value: boolean) => void>(),
  }),
);

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => isReduceMotionEnabled(),
    isReduceTransparencyEnabled: () => isReduceTransparencyEnabled(),
    addEventListener: (event: string, handler: (value: boolean) => void) => {
      if (event === 'reduceTransparencyChanged') transparencyListeners.add(handler);
      return { remove: () => transparencyListeners.delete(handler) };
    },
  },
  View: 'View',
  Text: 'Text',
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

/** Échantillon de flou factice : une balise hôte. Les compter, c'est compter les GPU samples. */
const BlurProbe = 'BlurSample' as unknown as () => null;

const HEIGHT = 136;

interface RenderedNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly RenderedNode[] | null;
}

function flatten(node: RenderedNode | RenderedNode[] | null): readonly RenderedNode[] {
  if (node === null) return [];
  if (Array.isArray(node)) return node.flatMap((child) => flatten(child));
  return [node, ...flatten((node.children ?? null) as RenderedNode[] | null)];
}

function nodesOf(renderer: ReactTestRenderer, type: string): readonly RenderedNode[] {
  return flatten(renderer.toJSON() as unknown as RenderedNode | null).filter(
    (node) => node.type === type,
  );
}

/** Le voile teinté : le `LinearGradient` à TROIS stops. C'est lui qui rend le repli lisible. */
function veilNodes(renderer: ReactTestRenderer): readonly RenderedNode[] {
  return nodesOf(renderer, 'LinearGradient').filter(
    (node) => (node.props['colors'] as unknown[] | undefined)?.length === 3,
  );
}

/**
 * LES QUATRE VÉRIFICATIONS, à faire dans TOUS les cas d'échec : l'écran est encore là, il
 * montre la surface teintée, il ne reste aucun échantillon, et rien n'a disparu du rendu.
 */
function expectScreenSurvivedWithOpaqueFallback(renderer: ReactTestRenderer): void {
  expect(renderer.toJSON(), "l'écran a disparu — un effet décoratif a emporté l'arbre").not.toBeNull();
  expect(veilNodes(renderer), 'le voile teinté a disparu : trou visuel').toHaveLength(1);
  expect(nodesOf(renderer, 'BlurSample'), 'des échantillons de flou survivent au manquement').toHaveLength(0);
}

type Props = Partial<ProgressiveBlurBobViewProps>;

/** Monte, puis laisse la préférence système asynchrone se résoudre (sinon : rang fail-closed). */
async function mount(props: Props): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ThemeProvider>
        <ProgressiveBlurBob
          anchor="bottom"
          height={HEIGHT}
          renderCapability="capable"
          surfaceUnder="static"
          {...props}
        />
      </ThemeProvider>,
    );
  });
  return renderer;
}

async function update(renderer: ReactTestRenderer, props: Props): Promise<void> {
  await act(async () => {
    renderer.update(
      <ThemeProvider>
        <ProgressiveBlurBob
          anchor="bottom"
          height={HEIGHT}
          renderCapability="capable"
          surfaceUnder="static"
          {...props}
        />
      </ThemeProvider>,
    );
  });
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  transparencyListeners.clear();
  isReduceMotionEnabled.mockResolvedValue(false);
  isReduceTransparencyEnabled.mockResolvedValue(false);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // React journalise lui-même toute erreur attrapée par une frontière : on le tait ici, le
  // point du test étant que l'ÉCRAN survit, pas que React se taise.
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  vi.clearAllMocks();
});

function warnings(): readonly string[] {
  return warn.mock.calls.map((call) => String(call[0]));
}

describe('(a) LA FABRIQUE JETTE — try/catch autour de l’APPEL', () => {
  it("l'écran survit, la surface teintée reste lisible, et le port n'est plus rappelé", async () => {
    const factory = vi.fn((_spec: BlurLayerSpec): ReactElement | null => {
      throw new Error('pont natif absent');
    });
    const renderBlurLayer = defineBlurPort(factory as unknown as RenderBlurLayer);

    const renderer = await mount({ layers: 3, renderBlurLayer });

    expectScreenSurvivedWithOpaqueFallback(renderer);
    expect(warnings()).toContain(BLUR_PORT_FAILURE_WARNINGS['factory-threw']);

    // DÉFINITIF : on re-rend plusieurs fois, le port n'est jamais rappelé.
    const callsAtLatch = factory.mock.calls.length;
    await update(renderer, { layers: 3, renderBlurLayer });
    await update(renderer, { layers: 3, renderBlurLayer });
    expect(factory.mock.calls.length, 'le port a été rappelé après son manquement').toBe(callsAtLatch);
    expectScreenSurvivedWithOpaqueFallback(renderer);
  });
});

describe('(b) L’ÉLÉMENT RENDU JETTE — frontière d’erreur', () => {
  it('au PREMIER rendu : l’écran survit et sert le repli opaque', async () => {
    function Exploding(): ReactElement {
      throw new Error('BlurView natif indisponible');
    }
    const renderBlurLayer = defineBlurPort(() => <Exploding />);

    const renderer = await mount({ layers: 3, renderBlurLayer });

    expectScreenSurvivedWithOpaqueFallback(renderer);
    expect(warnings()).toContain(BLUR_PORT_FAILURE_WARNINGS['element-threw']);
  });

  it('au DEUXIÈME rendu : le flou marche, puis lève, et l’écran survit quand même', async () => {
    let renders = 0;
    function ExplodingOnSecond(): ReactElement {
      renders += 1;
      if (renders > 1) throw new Error('surface GPU perdue');
      return <BlurProbe />;
    }
    const renderBlurLayer = defineBlurPort((spec) => <ExplodingOnSecond key={spec.index} />);

    const renderer = await mount({ layers: 1, renderBlurLayer });
    expect(nodesOf(renderer, 'BlurSample'), 'le premier rendu devait bien flouter').toHaveLength(1);

    await update(renderer, { layers: 1, renderBlurLayer, tone: 'marine' });

    expectScreenSurvivedWithOpaqueFallback(renderer);
    expect(warnings()).toContain(BLUR_PORT_FAILURE_WARNINGS['element-threw']);
  });

  it('dans un EFFET : le try/catch de l’appelant n’attrape rien, la frontière si', async () => {
    function ExplodingEffect(): ReactElement {
      useEffect(() => {
        throw new Error('abonnement natif refusé');
      }, []);
      return <BlurProbe />;
    }
    const renderBlurLayer = defineBlurPort((spec) => <ExplodingEffect key={spec.index} />);

    const renderer = await mount({ layers: 2, renderBlurLayer });

    expectScreenSurvivedWithOpaqueFallback(renderer);
    expect(warnings()).toContain(BLUR_PORT_FAILURE_WARNINGS['element-threw']);
  });
});

describe('DÉGRADATION DÉFINITIVE — ni boucle d’erreurs, ni clignotement', () => {
  it('un port INTERMITTENT (une fois sur deux) est coupé au premier manquement, pour de bon', async () => {
    let calls = 0;
    const factory = vi.fn((spec: BlurLayerSpec): ReactElement | null => {
      calls += 1;
      if (calls % 2 === 0) throw new Error('intermittent');
      return <BlurProbe key={spec.index} />;
    });
    const renderBlurLayer = defineBlurPort(factory as unknown as RenderBlurLayer);

    // 2 couches : la couche 0 réussit, la couche 1 lève → manquement dès le premier montage.
    const renderer = await mount({ layers: 2, renderBlurLayer });
    expectScreenSurvivedWithOpaqueFallback(renderer);

    const callsAtLatch = factory.mock.calls.length;
    for (let i = 0; i < 5; i += 1) {
      await update(renderer, { layers: 2, renderBlurLayer });
      // AUCUN clignotement : à chaque re-rendu, exactement le même repli lisible.
      expectScreenSurvivedWithOpaqueFallback(renderer);
    }
    expect(factory.mock.calls.length, 'le port intermittent a été rappelé').toBe(callsAtLatch);
  });

  it('un port qui rend NULL une fois sur deux ne produit jamais de pile partielle', async () => {
    let calls = 0;
    const factory = vi.fn((spec: BlurLayerSpec): ReactElement | null => {
      calls += 1;
      return calls % 2 === 0 ? null : <BlurProbe key={spec.index} />;
    });
    const renderBlurLayer = defineBlurPort(factory as unknown as RenderBlurLayer);

    const renderer = await mount({ layers: 4, renderBlurLayer });

    // TOUT OU RIEN : une pile partielle produirait une courbe qui n'est ni celle du mode
    // flouté ni celle du repli. On sert le repli entier.
    expectScreenSurvivedWithOpaqueFallback(renderer);
    expect(warnings()).toContain(BLUR_PORT_FAILURE_WARNINGS['partial-stack']);

    const callsAtLatch = factory.mock.calls.length;
    await update(renderer, { layers: 4, renderBlurLayer });
    expect(factory.mock.calls.length).toBe(callsAtLatch);
  });

  it("`null` à l'index 0 bascule au repli SANS avertir : c'est le rang normal du contrat", async () => {
    const factory = vi.fn((): ReactElement | null => null);
    const renderBlurLayer = defineBlurPort(factory as unknown as RenderBlurLayer);

    const renderer = await mount({ layers: 3, renderBlurLayer });

    expectScreenSurvivedWithOpaqueFallback(renderer);
    for (const message of Object.values(BLUR_PORT_FAILURE_WARNINGS)) {
      expect(warnings(), 'un rang normal du contrat ne doit pas être signalé comme une faute').not.toContain(message);
    }
    const callsAtLatch = factory.mock.calls.length;
    await update(renderer, { layers: 3, renderBlurLayer });
    expect(factory.mock.calls.length, 'le port est rappelé après un null à l’index 0').toBe(callsAtLatch);
  });
});

describe('PORT À HOOKS — les hooks du port appartiennent à SA bande', () => {
  it('survit à la bascule N → 0 → N provoquée par une préférence d’accessibilité', async () => {
    const renderBlurLayer = defineBlurPort((spec) => {
      // Un pont de flou natif utilise des hooks : mesure, capacité, cycle de vie.
      const [mounted, setMounted] = useState(false);
      useEffect(() => setMounted(true), []);
      return <BlurProbe key={`${spec.index}-${String(mounted)}`} />;
    });

    const renderer = await mount({ layers: 3, renderBlurLayer });
    expect(nodesOf(renderer, 'BlurSample')).toHaveLength(3);

    // N → 0 : Reduce Transparency activé en direct pendant que l'écran est monté.
    await act(async () => {
      for (const listener of transparencyListeners) listener(true);
    });
    expectScreenSurvivedWithOpaqueFallback(renderer);

    // 0 → N : la préférence est relâchée. Aucune erreur de règles des hooks.
    await act(async () => {
      for (const listener of transparencyListeners) listener(false);
    });
    expect(renderer.toJSON()).not.toBeNull();
    expect(nodesOf(renderer, 'BlurSample')).toHaveLength(3);
    expect(
      error.mock.calls.map((call) => String(call[0])).join('\n'),
      'React a signalé une violation des règles des hooks',
    ).not.toMatch(/hooks/i);
  });

  it('un port à hooks qui JETTE pendant une bascule d’accessibilité n’emporte pas l’écran', async () => {
    let armed = false;
    const renderBlurLayer = defineBlurPort((spec) => {
      const [, setTick] = useState(0);
      useEffect(() => setTick((value) => value + 1), []);
      if (armed) throw new Error('pont natif fermé pendant la bascule');
      return <BlurProbe key={spec.index} />;
    });

    const renderer = await mount({ layers: 3, renderBlurLayer });
    expect(nodesOf(renderer, 'BlurSample')).toHaveLength(3);

    armed = true;
    await act(async () => {
      for (const listener of transparencyListeners) listener(false);
    });
    await update(renderer, { layers: 3, renderBlurLayer, tone: 'ai' });

    expectScreenSurvivedWithOpaqueFallback(renderer);
  });
});
