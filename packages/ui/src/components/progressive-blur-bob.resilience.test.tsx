/**
 * ProgressiveBlurBob — UN PORT QUI JETTE N'EMPORTE PAS L'ÉCRAN.
 *
 * Le port vient de l'APPLICATION : `packages/ui` ne contrôle pas ce code. S'il lève, React
 * démonte l'arbre et l'écran entier disparaît — sur un écran où l'artisan encaisse une
 * facture. Ce fichier a d'abord verrouillé DEUX chemins. Il y en a TROIS : une revue
 * adversariale a fait DISPARAÎTRE l'écran en rejouant le troisième, et son déclencheur n'a
 * rien d'exotique. Les voici, nommés, chacun avec son mécanisme :
 *
 *   (a) LA FABRIQUE JETTE — l'appel à `renderBlurLayer` lève pendant la construction ;
 *       un `try`/`catch` autour de l'appel l'attrape ;
 *   (b) L'ÉLÉMENT RENDU JETTE — la fabrique rend un élément VALIDE qui lève pendant SON rendu
 *       ou dans un effet de MONTAGE ; un `try`/`catch` de l'appelant n'attrape RIEN, il faut
 *       une frontière d'erreur ;
 *   (c) LE NETTOYAGE JETTE AU DÉMONTAGE DE LA PILE — l'élément lève dans le CLEANUP de son
 *       effet, pendant la transition NORMALE N → 0 (Reduce Transparency, verrou après
 *       manquement, `layers` → 0). Une frontière rendue CONDITIONNELLEMENT est démontée AVEC
 *       ses enfants et ne peut rien attraper : elle doit être montée INCONDITIONNELLEMENT.
 *
 * S'y ajoute le code d'application que le kit a lui-même invité : le rappel `onPlan`.
 *
 * Chaque cas vérifie les QUATRE mêmes choses : l'écran survit, la surface teintée reste
 * lisible, aucun échantillon de flou ne subsiste, et la dégradation est DÉFINITIVE — un port
 * qui a manqué n'est plus rappelé, sinon on remplace un écran mort par une boucle d'erreurs
 * et un port intermittent fait clignoter l'écran.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  Component,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { surfaceVeil } from '@bob/tokens';
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

/** Le repli que l'APPLICATION sert quand SA propre frontière d'écran attrape. */
const ScreenFallback = 'EcranDegrade' as unknown as () => null;

/**
 * LA MATIÈRE REMISE, appliquée TELLE QUELLE — la forme exacte de l'adaptateur documenté, et
 * depuis la revue la forme EXIGÉE : un élément qui réécrit `intensity`, `tint` ou `style`, ou
 * qui porte des enfants, ferme la pile sur `material-tampered` avant même d'être rendu. Les
 * ports de ce fichier doivent donc être conformes SUR LA MATIÈRE pour que leur défaillance
 * teste bien ce qu'elle prétend tester : jeter, rendre `null`, ou lever au démontage.
 */
function material(spec: BlurLayerSpec): Record<string, unknown> {
  return { style: spec.style, intensity: spec.intensity, tint: spec.tint };
}

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
          devShellHeight={800}
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
          devShellHeight={800}
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
    function Exploding(_props: Record<string, unknown>): ReactElement {
      throw new Error('BlurView natif indisponible');
    }
    const renderBlurLayer = defineBlurPort((spec) => <Exploding {...material(spec)} />);

    const renderer = await mount({ layers: 3, renderBlurLayer });

    expectScreenSurvivedWithOpaqueFallback(renderer);
    expect(warnings()).toContain(BLUR_PORT_FAILURE_WARNINGS['element-threw']);
  });

  it('au DEUXIÈME rendu : le flou marche, puis lève, et l’écran survit quand même', async () => {
    let renders = 0;
    function ExplodingOnSecond(props: Record<string, unknown>): ReactElement {
      renders += 1;
      if (renders > 1) throw new Error('surface GPU perdue');
      return <BlurProbe {...props} />;
    }
    const renderBlurLayer = defineBlurPort((spec) => (
      <ExplodingOnSecond key={spec.index} {...material(spec)} />
    ));

    const renderer = await mount({ layers: 1, renderBlurLayer });
    expect(nodesOf(renderer, 'BlurSample'), 'le premier rendu devait bien flouter').toHaveLength(1);

    await update(renderer, { layers: 1, renderBlurLayer, tone: 'marine' });

    expectScreenSurvivedWithOpaqueFallback(renderer);
    expect(warnings()).toContain(BLUR_PORT_FAILURE_WARNINGS['element-threw']);
  });

  it('dans un EFFET : le try/catch de l’appelant n’attrape rien, la frontière si', async () => {
    function ExplodingEffect(props: Record<string, unknown>): ReactElement {
      useEffect(() => {
        throw new Error('abonnement natif refusé');
      }, []);
      return <BlurProbe {...props} />;
    }
    const renderBlurLayer = defineBlurPort((spec) => (
      <ExplodingEffect key={spec.index} {...material(spec)} />
    ));

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
      return <BlurProbe key={spec.index} {...material(spec)} />;
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
      return calls % 2 === 0 ? null : <BlurProbe key={spec.index} {...material(spec)} />;
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
      return <BlurProbe key={`${spec.index}-${String(mounted)}`} {...material(spec)} />;
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
      return <BlurProbe key={spec.index} {...material(spec)} />;
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

describe('(c) LE NETTOYAGE JETTE AU DÉMONTAGE — la frontière doit SURVIVRE à ses enfants', () => {
  /**
   * LE TROISIÈME CHEMIN, celui que ce fichier n'énumérait pas. Un élément du port lève dans le
   * NETTOYAGE de son effet, pendant que la pile est démontée. Ni le `try`/`catch` de l'appelant
   * (l'appel est fini depuis longtemps) ni une frontière CONDITIONNELLE ne le couvrent : rendue
   * `plan.mode === 'blurred' ? <Frontière/> : null`, elle est supprimée EN MÊME TEMPS que ses
   * enfants, et une frontière supprimée n'attrape pas l'erreur de ses propres enfants supprimés.
   * React ne trouvait alors aucune frontière et détruisait la racine.
   *
   * Mesure de la revue, sur le code d'alors : `{erreurEchappee: 'AggregateError', arbre: 'NULL'}`,
   * pile React `commitHookEffectListUnmount → commitPassiveUnmountEffectsInsideOfDeletedTree_begin`.
   * Vérifié de nouveau au moment d'écrire ce correctif : remettre la frontière conditionnelle
   * fait revenir exactement cette erreur et exactement cet arbre nul.
   */
  function explodingCleanupPort(armed: () => boolean): RenderBlurLayer {
    function Boom(props: Record<string, unknown>): ReactElement {
      useEffect(
        () => () => {
          if (armed()) throw new Error('démontage natif refusé');
        },
        [],
      );
      return <BlurProbe {...props} />;
    }
    return defineBlurPort((spec) => <Boom key={spec.index} {...material(spec)} />);
  }

  it.each([
    [
      'bascule Reduce Transparency (N → 0)',
      async (renderer: ReactTestRenderer, port: RenderBlurLayer): Promise<void> => {
        void port;
        await act(async () => {
          for (const listener of transparencyListeners) listener(true);
        });
      },
    ],
    [
      'demande de l’appelant ramenée à zéro (N → 0)',
      async (renderer: ReactTestRenderer, port: RenderBlurLayer): Promise<void> => {
        await update(renderer, { layers: 0, renderBlurLayer: port });
      },
    ],
    [
      'port retiré des props (N → 0)',
      async (renderer: ReactTestRenderer, port: RenderBlurLayer): Promise<void> => {
        void port;
        await update(renderer, { layers: 3 });
      },
    ],
  ])('%s : l’écran survit et sert le repli opaque', async (_label, degrade) => {
    let armed = false;
    const renderBlurLayer = explodingCleanupPort(() => armed);
    const renderer = await mount({ layers: 3, renderBlurLayer });
    expect(nodesOf(renderer, 'BlurSample')).toHaveLength(3);

    armed = true;
    let escaped: unknown = null;
    try {
      await degrade(renderer, renderBlurLayer);
    } catch (caught) {
      escaped = caught;
    }

    expect(escaped, 'une erreur de nettoyage a échappé à toute frontière').toBeNull();
    expectScreenSurvivedWithOpaqueFallback(renderer);
  });

  it('même chose quand c’est le VERROU qui démonte la pile (manquement d’une autre bande)', async () => {
    let armed = false;
    function Boom(props: Record<string, unknown>): ReactElement {
      useEffect(
        () => () => {
          if (armed) throw new Error('démontage natif refusé');
        },
        [],
      );
      return <BlurProbe {...props} />;
    }
    // La bande 2 rendra `null` au second rendu : pile PARTIELLE → verrou → démontage de tout.
    let breaks = false;
    const renderBlurLayer = defineBlurPort((spec) =>
      breaks && spec.index === 2 ? null : <Boom key={spec.index} {...material(spec)} />,
    );
    const renderer = await mount({ layers: 3, renderBlurLayer });
    expect(nodesOf(renderer, 'BlurSample')).toHaveLength(3);

    armed = true;
    breaks = true;
    let escaped: unknown = null;
    try {
      await update(renderer, { layers: 3, renderBlurLayer, tone: 'marine' });
    } catch (caught) {
      escaped = caught;
    }
    expect(escaped).toBeNull();
    expectScreenSurvivedWithOpaqueFallback(renderer);
  });

  /**
   * LA LIMITE, DÉCLARÉE PLUTÔT QUE TUE. Si c'est la RETOMBÉE ELLE-MÊME qui est démontée —
   * l'écran quitte —, aucune frontière INTERNE ne peut aider : par construction elle part avec
   * ses enfants. Ce n'est pas un défaut qu'on cache, c'est une frontière de responsabilité, et
   * elle se tient au niveau de l'ÉCRAN. Ce test montre que la recommandation FONCTIONNE : une
   * frontière d'écran attrape, l'application garde la main et sert son propre repli.
   */
  it('quand la RETOMBÉE elle-même est démontée, c’est une frontière d’ÉCRAN qui doit tenir', async () => {
    let armed = false;
    const renderBlurLayer = explodingCleanupPort(() => armed);

    class ScreenBoundary extends Component<{ readonly children: ReactNode }, { failed: boolean }> {
      override state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
      }
      override render(): ReactNode {
        return this.state.failed ? <ScreenFallback /> : this.props.children;
      }
    }

    const screen = (withFalloff: boolean): ReactElement => (
      <ScreenBoundary>
        <ThemeProvider>
          {withFalloff ? (
            <ProgressiveBlurBob
              anchor="bottom"
              height={HEIGHT}
              renderCapability="capable"
              surfaceUnder="static"
              devShellHeight={800}
              layers={3}
              renderBlurLayer={renderBlurLayer}
            />
          ) : null}
        </ThemeProvider>
      </ScreenBoundary>
    );

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(screen(true));
    });
    expect(nodesOf(renderer, 'BlurSample')).toHaveLength(3);

    armed = true;
    let escaped: unknown = null;
    try {
      await act(async () => {
        renderer.update(screen(false));
      });
    } catch (caught) {
      escaped = caught;
    }

    // L'application garde la main : la racine vit, et c'est ELLE qui décide du repli.
    expect(escaped, 'une frontière d’écran doit attraper le démontage de la retombée').toBeNull();
    expect(renderer.toJSON()).not.toBeNull();
  });
});

describe('LE RAPPEL `onPlan` — une prop AJOUTÉE par le kit, donc du code d’application', () => {
  /**
   * L'IRONIE DU LOT, et le premier défaut qu'a trouvé la revue : `onPlan` n'est pas dans le
   * contrat, c'est le kit qui l'a ajoutée (« diagnostic »). Elle porte donc exactement le code
   * d'application dont ce fichier jure qu'il ne fera jamais tomber un écran — et elle était
   * appelée NUE dans un effet passif. En React 19, une erreur non rattrapée dans un effet
   * passif DÉMONTE LA RACINE ENTIÈRE. Mesure de la revue :
   * `{erreurEchappee: 'télémétrie cassée', arbre: 'NULL'}`.
   */
  it('un `onPlan` qui lève n’emporte pas l’écran, et la retombée continue de servir', async () => {
    const renderer = await mount({ layers: 0 });
    expect(renderer.toJSON()).not.toBeNull();

    let escaped: unknown = null;
    try {
      await update(renderer, {
        layers: 2,
        onPlan: () => {
          throw new Error('télémétrie cassée');
        },
      });
    } catch (caught) {
      escaped = caught;
    }

    expect(escaped, 'une télémétrie cassée a emporté l’écran').toBeNull();
    expectScreenSurvivedWithOpaqueFallback(renderer);
    expect(warnings().join('\n'), 'l’échec doit être NOMMÉ au développeur').toMatch(/onPlan a LEVÉ/);
  });

  it('le plan SUIVANT est bien émis : on n’ampute que l’émission fautive', async () => {
    const seen: number[] = [];
    let hostile = true;
    const onPlan = (plan: { readonly granted: number }): void => {
      if (hostile) throw new Error('télémétrie cassée');
      seen.push(plan.granted);
    };

    // Première émission : elle lève, et elle est perdue — c'est tout ce qu'on lui prend.
    const renderer = await mount({ layers: 2, onPlan });
    expect(seen).toEqual([]);

    // Le plan change ensuite : le rappel est de nouveau appelé, sans rancune ni verrou.
    hostile = false;
    await update(renderer, { layers: 5, onPlan });

    expect(seen, 'le rappel n’a jamais été rappelé après son échec').toEqual([5]);
    expect(renderer.toJSON()).not.toBeNull();
  });

  it('le message d’échec est STATIQUE : ni le plan, ni l’erreur ne s’y interpolent', async () => {
    const renderer = await mount({
      layers: 2,
      onPlan: () => {
        throw new Error('SECRET-DE-L-APPLICATION');
      },
    });
    expect(renderer.toJSON()).not.toBeNull();
    expect(warnings().join('\n')).not.toMatch(/SECRET-DE-L-APPLICATION/);
    expect(warnings().join('\n')).not.toMatch(/\[object|undefined/);
  });
});

describe('TOUT OU RIEN À LA PREMIÈRE FRAME — la pile partielle n’est jamais COMMITÉE', () => {
  /**
   * LA RÈGLE TOUT OU RIEN N'ÉTAIT PAS TENUE AU BON MOMENT. `BlurLayerSlot` annonçait son issue
   * depuis un effet PASSIF — React les programme APRÈS avoir rendu la main —, donc une pile
   * PARTIELLE (un élément à un index, `null` à un autre) restait dans l'arbre COMMITÉ le temps
   * d'un aller-retour du planificateur. Le repli finissait par arriver, et tous les tests
   * étaient verts : ils ne regardaient QUE l'état final.
   *
   * PREMIER CORRECTIF ESSAYÉ, ET INSUFFISANT — dit ici parce que c'est instructif : passer
   * l'annonce dans un effet de MISE EN PAGE. Mesuré sur ce dépôt, un observateur voyait encore
   * 5 échantillons sur 6. Un effet, même de mise en page, court APRÈS le commit : la pile
   * partielle existe déjà quand il parle. La garantie « React vide ces mises à jour avant la
   * peinture » dépend du renderer hôte — elle n'était donc pas prouvable ici, et une garantie
   * qu'on ne peut pas prouver ne se déclare pas.
   *
   * CE QUI TIENT VRAIMENT : la bande qui découvre le mélange ABANDONNE PENDANT LE RENDU. React
   * déroule le sous-arbre jusqu'à `BlurStackBoundary` AVANT tout commit — la pile partielle
   * n'est jamais construite côté hôte, donc jamais peinte, et il n'y a aucune révision
   * intermédiaire à coalescer par qui que ce soit.
   *
   * L'ARBRE COMMITÉ EST OBSERVÉ PAR DES EFFETS DE MISE EN PAGE, montés sur les échantillons
   * eux-mêmes : ils comptent ce que l'hôte a réellement reçu, commit par commit.
   */
  it('aucun commit ne porte une pile partielle : on passe de N à 0, sans étape', async () => {
    let live = 0;
    const commits: number[] = [];

    function CountedSample(props: Record<string, unknown>): ReactElement {
      // Effet de MISE EN PAGE : `live` suit l'arbre COMMITÉ, au plus près de l'hôte.
      useLayoutEffect(() => {
        live += 1;
        return () => {
          live -= 1;
        };
      }, []);
      return <BlurProbe {...props} />;
    }

    /** Déclaré APRÈS la retombée : ses effets courent donc APRÈS ceux de toutes les bandes. */
    function CommitWitness(): null {
      useLayoutEffect(() => {
        commits.push(live);
      });
      useEffect(() => {
        commits.push(live);
      });
      return null;
    }

    let missing = -1;
    const renderBlurLayer = defineBlurPort((spec) =>
      spec.index === missing ? null : <CountedSample key={spec.index} {...material(spec)} />,
    );

    const screen = (): ReactElement => (
      <ThemeProvider>
        <ProgressiveBlurBob
          anchor="bottom"
          height={HEIGHT}
          renderCapability="capable"
          surfaceUnder="static"
          devShellHeight={800}
          layers={6}
          renderBlurLayer={renderBlurLayer}
        />
        <CommitWitness />
      </ThemeProvider>
    );

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(screen());
    });
    expect(nodesOf(renderer, 'BlurSample'), 'le montage nominal devait flouter').toHaveLength(6);

    // Le pont natif perd la couche 3 au rendu suivant : c'est là que la pile devient partielle.
    missing = 3;
    await act(async () => {
      renderer.update(screen());
    });

    expect(commits.length, 'aucun commit observé : le témoin ne prouve rien').toBeGreaterThan(1);
    for (const count of commits) {
      expect(
        [0, 6],
        `un commit a porté une pile PARTIELLE de ${String(count)} échantillons sur 6`,
      ).toContain(count);
    }
    expectScreenSurvivedWithOpaqueFallback(renderer);
    expect(warnings()).toContain(BLUR_PORT_FAILURE_WARNINGS['partial-stack']);
  });

  it('le manquement est nommé JUSTE, même découvert par abandon de rendu', async () => {
    // Bande 0 servie, bande 2 qui LÈVE : le mélange est découvert à la bande 2, et c'est bien
    // « la fabrique a levé » qu'on doit lire — pas un rang générique de frontière d'erreur.
    const renderBlurLayer = defineBlurPort((spec) => {
      if (spec.index === 2) throw new Error('pont natif absent');
      return <BlurProbe key={spec.index} {...material(spec)} />;
    });
    const renderer = await mount({ layers: 4, renderBlurLayer });
    expectScreenSurvivedWithOpaqueFallback(renderer);
    expect(warnings()).toContain(BLUR_PORT_FAILURE_WARNINGS['factory-threw']);
  });

  it('une pile ENTIÈREMENT manquante ne passe par aucun abandon — c’est le rang normal', async () => {
    // `null` partout : l'arbre commité ne porte aucun échantillon, donc il est DÉJÀ celui du
    // repli. Rien à abandonner, et surtout : aucune faute à signaler au développeur.
    const renderBlurLayer = defineBlurPort(() => null);
    const renderer = await mount({ layers: 5, renderBlurLayer });
    expectScreenSurvivedWithOpaqueFallback(renderer);
    for (const message of Object.values(BLUR_PORT_FAILURE_WARNINGS)) {
      expect(warnings(), 'un rang normal du contrat a été signalé comme une faute').not.toContain(message);
    }
  });
});

describe('LE PLAN REMIS À L’APPLICATION EST GELÉ', () => {
  /**
   * `onPlan` reçoit le plan, et `progressiveBlurWarnings` le relit ensuite pour en interpoler
   * les nombres dans ses messages. Un plan MUTABLE laisserait donc un rappel réécrire ce que le
   * kit journalise juste après — c'est la seule façon qui restait de faire entrer une donnée
   * étrangère dans un message du kit. Le plan est gelé, son tableau de couches aussi.
   */
  it('un rappel qui tente de le réécrire échoue, et ne pollue aucun message', async () => {
    let frozen: readonly [boolean, boolean] = [false, false];
    const renderer = await mount({
      layers: 4,
      renderCapability: 'unknown', // fait parler `progressiveBlurWarnings`
      onPlan: (plan) => {
        frozen = [Object.isFrozen(plan), Object.isFrozen(plan.layers)];
        (plan as { requested: unknown }).requested = 'DONNEE-ETRANGERE';
      },
    });

    expect(frozen, 'le plan ou son tableau de couches n’est pas gelé').toEqual([true, true]);
    expect(warnings().join('\n')).not.toMatch(/DONNEE-ETRANGERE/);
    expect(renderer.toJSON()).not.toBeNull();
  });
});

/**
 * LES PROPS HORS CONTRAT DE TYPE — le QUATRIÈME chemin par lequel l'écran tombait, trouvé par
 * une revue adversariale et fermé.
 *
 * Les trois chemins nommés plus haut parlent du PORT. Mais `ProgressiveBlurBob` lit aussi des
 * SCALAIRES fournis par l'application, et il les lit PENDANT SON PROPRE RENDU — au-dessus de
 * `BlurStackBoundary`, donc sans aucune frontière interne. « Le typage ne protège que le code
 * typé » : le kit le dit lui-même pour refuser une chaîne rendue par le port, et cela vaut
 * pour ses props. Mesuré AVANT correctif, `r.toJSON()` valait `null` — l'écran entier :
 *
 *  · `layers` objet à `valueOf` hostile → `input.layers <= granted` déclenchait la conversion ;
 *  · `devShellHeight` idem, via `height > devShellHeight` ;
 *  · `tone` hors énumération → `surfaceVeil[appearance][tone].stops` sur `undefined`.
 *
 * Rien n'est plus CONVERTI (`Number.isFinite` répond sans coercer) et le ton inconnu retombe sur
 * `canvas`, qui est le fond d'app — donc NOTRE teinte, jamais celle du système.
 */
describe('LES PROPS HORS CONTRAT DE TYPE N’EMPORTENT PAS L’ÉCRAN', () => {
  /** Port CONFORME sur la matière — sans lui, la barrière de matière ferme avant le scénario. */
  const honnete = (): RenderBlurLayer =>
    defineBlurPort((spec) => <BlurProbe key={spec.index} {...material(spec)} />);
  const hostileValueOf = {
    valueOf(): number {
      throw new Error('valueOf hostile');
    },
  } as unknown as number;

  it('`layers` dont le `valueOf` lève : refus, pas de chute', async () => {
    const renderer = await mount({ layers: hostileValueOf, renderBlurLayer: honnete() });
    expectScreenSurvivedWithOpaqueFallback(renderer);
  });

  it('`devShellHeight` dont le `valueOf` lève : l’assertion redevient impossible, donc refus', async () => {
    const renderer = await mount({
      layers: 4,
      devShellHeight: hostileValueOf,
      renderBlurLayer: honnete(),
    });
    expectScreenSurvivedWithOpaqueFallback(renderer);
  });

  it('`tone` hors énumération : l’écran tient, et le voile reste NOTRE teinte', async () => {
    const renderer = await mount({
      layers: 4,
      tone: 'verre-systeme' as never,
      renderBlurLayer: honnete(),
    });
    expect(renderer.toJSON()).not.toBeNull();
    expect(veilNodes(renderer)[0]?.props['colors']).toEqual(surfaceVeil.light.canvas.stops);
  });

  it('`onPlan` qui n’est pas une fonction : ignoré, jamais fatal', async () => {
    const renderer = await mount({
      layers: 4,
      onPlan: 'pas une fonction' as never,
      renderBlurLayer: honnete(),
    });
    expect(renderer.toJSON()).not.toBeNull();
    // Le rappel n'est pas appelable : c'est le MÊME rang qu'un rappel qui lève — on avertit,
    // on n'ampute que l'émission, et l'écran ne bouge pas.
    expect(warnings().join('\n')).toMatch(/le rappel onPlan a LEVÉ/);
    expect(nodesOf(renderer, 'BlurSample')).toHaveLength(4);
  });
});
