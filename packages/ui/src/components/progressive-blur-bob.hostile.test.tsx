/**
 * ProgressiveBlurBob — REVUE ADVERSARIALE. On n'écrit pas ici un port poli : on écrit celui
 * qu'on redoute. Il est SCELLÉ — il a donc franchi la porte —, il jure honorer notre matière,
 * il peint le verre du système avec SA teinte, il tente de sortir de sa bande de −9999 à
 * +9999, il essaie de réécrire ce qu'on lui remet, et il rend n'importe quoi.
 *
 * CE QUE LE KIT DOIT TENIR, quoi qu'il fasse :
 * · « Je NE VEUX PAS une UI transparente à la iOS » — aucun verre système ne devient visible :
 *   il reste CONFINÉ dans sa bande et RECOUVERT de notre lavis, puis de notre voile ;
 * · la matière transmise est GELÉE, et le kit ne relit jamais ce qu'il a transmis ;
 * · aucun nœud rendu par `@bob/ui` ne porte une couleur qui ne vienne pas de nos tokens ;
 * · l'écran ne disparaît jamais.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { surfaceVeil } from '@bob/tokens';
import { ThemeProvider } from '../theme';
import { ProgressiveBlurBob, type ProgressiveBlurBobViewProps } from './progressive-blur-bob';
import { defineBlurPort, isSealedBlurPort, resolveBlurPort } from './progressive-blur-bob.port';
import { BLUR_PORT_FAILURE_WARNINGS, resolveBlurMaterial } from './progressive-blur-bob.logic';
import type { BlurLayerSpec, RenderBlurLayer } from './progressive-blur-bob.types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { isReduceMotionEnabled, isReduceTransparencyEnabled } = vi.hoisted(() => ({
  isReduceMotionEnabled: vi.fn<() => Promise<boolean>>(),
  isReduceTransparencyEnabled: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => isReduceMotionEnabled(),
    isReduceTransparencyEnabled: () => isReduceTransparencyEnabled(),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  View: 'View',
  Text: 'Text',
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

/** Le verre du système, avec SA teinte : ce que la doctrine refuse. */
const SystemGlass = 'SystemGlass' as unknown as () => null;
const HOSTILE_TINT = '#FF00FF';
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

function root(renderer: ReactTestRenderer): RenderedNode {
  return renderer.toJSON() as unknown as RenderedNode;
}

function all(renderer: ReactTestRenderer): readonly RenderedNode[] {
  return flatten(root(renderer));
}

/**
 * Tous les nœuds PRIMITIFS de l'arbre — chaînes et nombres. React les rend en TEXTE, et la
 * retombée n'en porte jamais : « décorative, non interactive, jamais de texte ni d'information ».
 */
function primitiveChildren(renderer: ReactTestRenderer): readonly unknown[] {
  const walk = (node: unknown): readonly unknown[] => {
    if (node === null || node === undefined) return [];
    if (typeof node !== 'object') return [node];
    if (Array.isArray(node)) return node.flatMap(walk);
    return ((node as RenderedNode).children ?? []).flatMap(walk);
  };
  return walk(root(renderer));
}

type Props = Partial<ProgressiveBlurBobViewProps>;
const OPEN: Props = { renderCapability: 'capable', surfaceUnder: 'static' };

async function mount(props: Props): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ThemeProvider>
        <ProgressiveBlurBob anchor="bottom" height={HEIGHT} {...OPEN} {...props} />
      </ThemeProvider>,
    );
  });
  return renderer;
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  isReduceMotionEnabled.mockResolvedValue(false);
  isReduceTransparencyEnabled.mockResolvedValue(false);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  vi.clearAllMocks();
});

describe('LE VERRE SYSTÈME RESTE CONFINÉ ET RECOUVERT', () => {
  /** Scellé, donc admis. Peint le verre du système et tente de déborder de partout. */
  const invader = defineBlurPort((spec: BlurLayerSpec) => (
    <SystemGlass
      key={spec.index}
      {...{
        tint: HOSTILE_TINT,
        style: { position: 'absolute', top: -9999, left: -9999, right: -9999, height: 99999 },
      }}
    />
  ));

  it('son verre vit DANS une bande clippée, jamais en enfant direct de l’enveloppe', async () => {
    const renderer = await mount({ layers: 3, renderBlurLayer: invader });
    const bands = (root(renderer).children ?? []).slice(0, 3);

    // Aucun nœud du port n'est un enfant direct de l'enveloppe : il est toujours DANS une bande.
    for (const child of root(renderer).children ?? []) {
      expect(child.type === 'SystemGlass').toBe(false);
    }
    for (const band of bands) {
      expect((band.props['style'] as Record<string, unknown>)['overflow']).toBe('hidden');
      expect((band.children ?? [])[0]?.type).toBe('SystemGlass');
    }
  });

  it('NOTRE lavis est composé APRÈS son verre, dans sa propre bande', async () => {
    const renderer = await mount({ layers: 3, renderBlurLayer: invader });
    const material = resolveBlurMaterial('canvas', 'light');

    for (const band of (root(renderer).children ?? []).slice(0, 3)) {
      const inner = band.children ?? [];
      const glassAt = inner.findIndex((node) => node.type === 'SystemGlass');
      const washAt = inner.findIndex((node) => node.type === 'LinearGradient');
      expect(glassAt).toBeGreaterThanOrEqual(0);
      // Déclaré APRÈS ⇒ peint AU-DESSUS. C'est la seule autorité, et elle joue pour nous.
      expect(washAt).toBeGreaterThan(glassAt);
      expect(inner[washAt]?.props['colors']).toEqual([material.tintTransparent, material.tintSolid]);
    }
  });

  it('et NOTRE voile est peint par-dessus TOUT — dernier déclaré de l’enveloppe', async () => {
    const renderer = await mount({ layers: 3, renderBlurLayer: invader });
    const children = root(renderer).children ?? [];
    const last = children[children.length - 1];
    expect(last?.type).toBe('LinearGradient');
    expect(last?.props['colors']).toEqual(surfaceVeil.light.canvas.stops);
  });

  it('AUCUNE couleur rendue par @bob/ui ne vient du port — toutes sortent de surfaceVeil', async () => {
    const renderer = await mount({ layers: 4, renderBlurLayer: invader });
    const ours = new Set<string>([
      ...surfaceVeil.light.canvas.stops,
      resolveBlurMaterial('canvas', 'light').tintTransparent,
      resolveBlurMaterial('canvas', 'light').tintSolid,
    ]);

    for (const node of all(renderer).filter((n) => n.type === 'LinearGradient')) {
      for (const color of node.props['colors'] as string[]) {
        expect(ours.has(color), `couleur étrangère rendue par le kit : ${color}`).toBe(true);
        expect(color).not.toBe(HOSTILE_TINT);
      }
    }
  });
});

describe('LA MATIÈRE TRANSMISE EST GELÉE', () => {
  it('un port qui tente de la réécrire échoue — et n’emporte pas l’écran pour autant', async () => {
    const thief = defineBlurPort((spec) => {
      // Tentative d'imposer sa teinte en écrivant dans ce qu'on lui remet.
      (spec as unknown as { tint: string }).tint = 'dark';
      return null;
    });

    const renderer = await mount({ layers: 3, renderBlurLayer: thief });

    // En module ESM (mode strict), écrire dans un objet gelé LÈVE : le kit l'attrape.
    expect(renderer.toJSON()).not.toBeNull();
    expect(all(renderer).filter((node) => node.type === 'SystemGlass')).toHaveLength(0);
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      BLUR_PORT_FAILURE_WARNINGS['factory-threw'],
    );
  });

  it('le style résolu est gelé lui aussi : la géométrie ne se renégocie pas', async () => {
    const specs: BlurLayerSpec[] = [];
    await mount({
      layers: 2,
      renderBlurLayer: defineBlurPort((spec) => {
        specs.push(spec);
        return null;
      }),
    });
    for (const spec of specs) {
      expect(Object.isFrozen(spec)).toBe(true);
      expect(Object.isFrozen(spec.style)).toBe(true);
    }
  });
});

describe('LE SCEAU — infalsifiable de l’extérieur', () => {
  it('un objet bricolé qui se prétend scellé n’entre pas', () => {
    const forged = Object.assign((_spec: BlurLayerSpec) => null, {
      seal: Symbol('@bob/ui:renderBlurLayer'),
      [Symbol.for('@bob/ui:renderBlurLayer')]: true,
    });
    expect(isSealedBlurPort(forged)).toBe(false);
    expect(resolveBlurPort(forged as unknown as RenderBlurLayer).status).toBe('unsealed');
  });

  it('rejette tout ce qui n’est pas une fonction, sans jamais lever', () => {
    for (const value of [undefined, null, 0, '', {}, [], true]) {
      expect(resolveBlurPort(value as unknown as RenderBlurLayer).status).toBe('absent');
    }
  });

  it('sceller est idempotent et ne mute jamais la fonction reçue', () => {
    const raw = (_spec: BlurLayerSpec) => null;
    const once = defineBlurPort(raw);
    const twice = defineBlurPort(once);
    expect(isSealedBlurPort(raw)).toBe(false); // la fonction d'origine reste intacte
    expect(isSealedBlurPort(once)).toBe(true);
    expect(isSealedBlurPort(twice)).toBe(true);
  });
});

describe('LA RETOMBÉE NE PORTE JAMAIS DE TEXTE', () => {
  it('un port qui rend une CHAÎNE est refusé — pas de texte dans la zone décorative', async () => {
    const talker = defineBlurPort(
      (() => 'un texte que personne ne doit lire ici') as unknown as RenderBlurLayer,
    );

    const renderer = await mount({ layers: 2, renderBlurLayer: talker });

    const json = JSON.stringify(renderer.toJSON());
    expect(json).not.toMatch(/un texte que personne/);
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      BLUR_PORT_FAILURE_WARNINGS['invalid-element'],
    );
    expect(renderer.toJSON()).not.toBeNull();
  });

  it('un port qui rend un NOMBRE est refusé de la même façon', async () => {
    const counter = defineBlurPort((() => 42) as unknown as RenderBlurLayer);
    const renderer = await mount({ layers: 2, renderBlurLayer: counter });

    // La preuve n'est pas l'absence de la chaîne « 42 » — `rgba(239,242,247,0)` la contient —
    // mais l'absence de tout NŒUD PRIMITIF : un nombre rendu par React est un nœud de texte.
    expect(primitiveChildren(renderer)).toEqual([]);
    expect(renderer.toJSON()).not.toBeNull();
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      BLUR_PORT_FAILURE_WARNINGS['invalid-element'],
    );
  });

  it('un port honnête ne produit lui non plus aucun nœud de texte', async () => {
    const honest = defineBlurPort((spec) => <SystemGlass key={spec.index} />);
    expect(primitiveChildren(await mount({ layers: 3, renderBlurLayer: honest }))).toEqual([]);
  });
});
