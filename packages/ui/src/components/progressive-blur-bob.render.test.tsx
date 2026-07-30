/**
 * ProgressiveBlurBob — CONFORMITÉ AU CONTRAT, au rendu.
 *
 * Ce que la logique pure ne peut pas prouver : l'ORDRE DE PEINTURE, la NEUTRALITÉ GÉOMÉTRIQUE
 * du clip, la présence du voile dans les DEUX modes, le fail-CLOSED au PREMIER rendu, et le
 * fait que `@bob/ui` ne dépend de rien de nouveau.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactElement } from 'react';
import { patterns } from '@bob/tokens';
import { ThemeProvider } from '../theme';
import { ProgressiveBlurBob, type ProgressiveBlurBobViewProps } from './progressive-blur-bob';
import { defineBlurPort } from './progressive-blur-bob.port';
import { blurLayerStyle } from './progressive-blur-bob.logic';
import type { BlurLayerSpec } from './progressive-blur-bob.types';

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
  Animated: { View: 'Animated.View', Value: class {}, timing: () => ({ start: () => undefined }) },
  View: 'View',
  Text: 'Text',
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

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

function root(renderer: ReactTestRenderer): RenderedNode {
  return renderer.toJSON() as unknown as RenderedNode;
}

function all(renderer: ReactTestRenderer): readonly RenderedNode[] {
  return flatten(root(renderer));
}

type Props = Partial<ProgressiveBlurBobViewProps>;

function tree(props: Props): ReactElement {
  return (
    <ThemeProvider>
      <ProgressiveBlurBob anchor="bottom" height={HEIGHT} testID="falloff" {...props} />
    </ThemeProvider>
  );
}

/** Monte SANS laisser la préférence asynchrone se résoudre : c'est le PREMIER rendu. */
function mountRaw(props: Props): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(tree(props));
  });
  return renderer;
}

/** Monte puis laisse la préférence se résoudre — l'état nominal d'un écran vivant. */
async function mount(props: Props): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(tree(props));
  });
  return renderer;
}

/** Port HONNÊTE : scellé, rend UNE couche, applique `spec.style` tel quel. */
function honestPort(onSpec?: (spec: BlurLayerSpec) => void) {
  return defineBlurPort((spec) => {
    onSpec?.(spec);
    return <BlurProbe key={spec.index} {...{ style: spec.style }} />;
  });
}

const OPEN: Props = { renderCapability: 'capable', surfaceUnder: 'static' };

beforeEach(() => {
  isReduceMotionEnabled.mockResolvedValue(false);
  isReduceTransparencyEnabled.mockResolvedValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ORDRE DE PEINTURE — l’ordre de DÉCLARATION est le seul arbitre', () => {
  it('rend les bandes D’ABORD, le voile teinté EN DERNIER (donc au-dessus)', async () => {
    const renderer = await mount({ ...OPEN, layers: 3, renderBlurLayer: honestPort() });
    const children = root(renderer).children ?? [];

    expect(children).toHaveLength(4); // 3 bandes + 1 voile
    const last = children[children.length - 1];
    expect(last?.type).toBe('LinearGradient');
    expect((last?.props['colors'] as unknown[]).length).toBe(3);
    for (const band of children.slice(0, 3)) expect(band?.type).toBe('View');
  });

  it('dans chaque bande : l’échantillon d’abord, NOTRE lavis par-dessus', async () => {
    const renderer = await mount({ ...OPEN, layers: 2, renderBlurLayer: honestPort() });
    for (const band of (root(renderer).children ?? []).slice(0, 2)) {
      const inner = band.children ?? [];
      expect(inner[0]?.type).toBe('BlurSample');
      expect(inner[1]?.type).toBe('LinearGradient');
      expect((inner[1]?.props['colors'] as unknown[]).length).toBe(2); // le lavis : 2 stops
    }
  });

  it('AUCUN nœud de la retombée ne porte zIndex, elevation ou une ombre', async () => {
    const renderer = await mount({ ...OPEN, layers: 4, renderBlurLayer: honestPort() });
    for (const node of all(renderer)) {
      const style = node.props['style'];
      const styles = (Array.isArray(style) ? style : [style]).filter(Boolean) as Record<string, unknown>[];
      for (const entry of styles) {
        for (const key of ['zIndex', 'elevation', 'shadowColor', 'shadowRadius', 'shadowOpacity']) {
          expect(entry[key], `${node.type} porte ${key}`).toBeUndefined();
        }
      }
    }
  });
});

describe('LE CLIP EST GÉOMÉTRIQUEMENT NEUTRE', () => {
  it('la bande a EXACTEMENT le rectangle de `spec.style` : un port conforme rend les mêmes pixels', async () => {
    const specs: BlurLayerSpec[] = [];
    const renderer = await mount({
      ...OPEN,
      layers: 5,
      renderBlurLayer: honestPort((spec) => specs.push(spec)),
    });

    const bands = (root(renderer).children ?? []).slice(0, 5);
    expect(specs).toHaveLength(5);
    bands.forEach((band, index) => {
      const { overflow, ...geometry } = band.props['style'] as Record<string, unknown>;
      expect(overflow, 'la bande doit clipper').toBe('hidden');
      // Le rectangle de la bande EST celui transmis au port : appliquer `spec.style` dans la
      // bande ou dans l'enveloppe donne le même rectangle. Le clip ne coûte rien à l'honnête.
      expect(geometry).toEqual(specs[index]?.style);
      expect(geometry).toEqual(
        blurLayerStyle('bottom', patterns.edgeFalloff.layerHeightsPercent[index] ?? 0, HEIGHT),
      );
    });
  });

  it('transmet `spec.style` au port TEL QUEL — la géométrie ne se renégocie pas', async () => {
    const specs: BlurLayerSpec[] = [];
    const renderer = await mount({
      ...OPEN,
      layers: 3,
      anchor: 'top',
      renderBlurLayer: honestPort((spec) => specs.push(spec)),
    });
    const samples = all(renderer).filter((node) => node.type === 'BlurSample');
    expect(samples).toHaveLength(3);
    samples.forEach((sample, index) => {
      expect(sample.props['style']).toBe(specs[index]?.style);
      expect(specs[index]?.anchor).toBe('top');
    });
  });
});

describe('LE VOILE TEINTÉ — rendu dans les DEUX modes, identique', () => {
  it('a exactement les mêmes couleurs, positions et axe, avec ou sans flou', async () => {
    const blurred = await mount({ ...OPEN, layers: 3, renderBlurLayer: honestPort() });
    const tinted = await mount({ layers: 3 }); // port absent → repli opaque unique

    const veilOf = (renderer: ReactTestRenderer): Record<string, unknown> => {
      const node = all(renderer)
        .filter((n) => n.type === 'LinearGradient')
        .find((n) => (n.props['colors'] as unknown[]).length === 3);
      return node?.props ?? {};
    };

    expect(veilOf(tinted)['colors']).toEqual(veilOf(blurred)['colors']);
    expect(veilOf(tinted)['locations']).toEqual(veilOf(blurred)['locations']);
    expect(veilOf(tinted)['start']).toEqual(veilOf(blurred)['start']);
    expect(veilOf(tinted)['end']).toEqual(veilOf(blurred)['end']);
    expect(veilOf(tinted)['colors']).toEqual(patterns.bottomTabBar.fade);
  });

  it('le repli n’est jamais un trou : le voile est là même sans aucune couche', async () => {
    const renderer = await mount({ layers: 0 });
    const children = root(renderer).children ?? [];
    expect(children).toHaveLength(1);
    expect(children[0]?.type).toBe('LinearGradient');
  });
});

describe('ACCESSIBILITÉ — fail-CLOSED au premier rendu, et rien à réduire', () => {
  it('AU PREMIER RENDU, préférence encore inconnue : ZÉRO échantillon de flou', () => {
    // La préférence ne revient jamais dans ce test : c'est la fenêtre d'ignorance, tenue ouverte.
    isReduceTransparencyEnabled.mockReturnValue(new Promise<boolean>(() => undefined));
    const renderer = mountRaw({ ...OPEN, layers: 5, renderBlurLayer: honestPort() });

    expect(all(renderer).filter((node) => node.type === 'BlurSample')).toHaveLength(0);
    // …et pourtant l'écran est lisible : le voile teinté est déjà là.
    expect((root(renderer).children ?? [])[0]?.type).toBe('LinearGradient');
  });

  it('Reduce Transparency ACTIF coupe les échantillons et garde la surface lisible', async () => {
    isReduceTransparencyEnabled.mockResolvedValue(true);
    const renderer = await mount({ ...OPEN, layers: 5, renderBlurLayer: honestPort() });
    expect(all(renderer).filter((node) => node.type === 'BlurSample')).toHaveLength(0);
    expect(all(renderer).filter((node) => node.type === 'LinearGradient')).toHaveLength(1);
  });

  it('la retombée est décorative : non interactive et masquée aux lecteurs d’écran', async () => {
    const renderer = await mount({ ...OPEN, layers: 3, renderBlurLayer: honestPort() });
    const envelope = root(renderer);
    expect(envelope.props['pointerEvents']).toBe('none');
    expect(envelope.props['accessibilityElementsHidden']).toBe(true);
    expect(envelope.props['importantForAccessibility']).toBe('no-hide-descendants');
    for (const node of all(renderer)) expect(node.type).not.toBe('Text');
  });

  it('REDUCE MOTION : rien n’est animé, donc l’arbre est IDENTIQUE dans les deux réglages', async () => {
    isReduceMotionEnabled.mockResolvedValue(false);
    const moving = await mount({ ...OPEN, layers: 3, renderBlurLayer: honestPort() });
    isReduceMotionEnabled.mockResolvedValue(true);
    const reduced = await mount({ ...OPEN, layers: 3, renderBlurLayer: honestPort() });

    expect(JSON.stringify(reduced.toJSON())).toBe(JSON.stringify(moving.toJSON()));
    for (const node of all(moving)) expect(node.type).not.toMatch(/^Animated/);
  });
});

describe('LE SCEAU — un port non déclaré ne s’installe pas', () => {
  it('une fonction NUE, même parfaitement conforme, est traitée comme ABSENTE', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const naked = (spec: BlurLayerSpec) => <BlurProbe key={spec.index} />;

    const renderer = await mount({ ...OPEN, layers: 3, renderBlurLayer: naked });

    expect(all(renderer).filter((node) => node.type === 'BlurSample')).toHaveLength(0);
    expect(all(renderer).filter((node) => node.type === 'LinearGradient')).toHaveLength(1);
    // L'échec n'est pas silencieux pour le développeur : on lui dit quoi faire.
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/defineBlurPort/);
    warn.mockRestore();
  });

  it('un port SCELLÉ rend bien ses N couches', async () => {
    const renderer = await mount({ ...OPEN, layers: 7, renderBlurLayer: honestPort() });
    expect(all(renderer).filter((node) => node.type === 'BlurSample')).toHaveLength(7);
  });
});

describe('FRONTIÈRE DE PAQUET — `@bob/ui` ne dépend de rien de nouveau', () => {
  const uiRoot = join(__dirname, '..', '..');

  it("`packages/ui/package.json` ne déclare NI expo-blur NI aucune dépendance de flou", () => {
    const manifest = readFileSync(join(uiRoot, 'package.json'), 'utf8');
    expect(manifest).not.toMatch(/expo-blur/);
    expect(manifest).not.toMatch(/expo-glass/);
    const parsed = JSON.parse(manifest) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(Object.keys(parsed.dependencies)).toEqual(['@bob/core', '@bob/i18n', '@bob/tokens']);
    expect(Object.keys(parsed.peerDependencies).sort()).toEqual([
      'expo-linear-gradient',
      'react',
      'react-native',
      'react-native-safe-area-context',
      'react-native-svg',
    ]);
  });

  it('AUCUN fichier de `packages/ui/src` n’importe expo-blur ni ne nomme le BlurTargetView', () => {
    // Le code LIVRÉ, c'est-à-dire tout `src` sauf les tests, qui ne sont jamais publiés.
    const isShipped = (name: string): boolean =>
      (name.endsWith('.ts') || name.endsWith('.tsx')) && !/\.test\.tsx?$/.test(name);
    const walk = (dir: string): readonly string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : isShipped(entry.name)
            ? [join(dir, entry.name)]
            : [],
      );

    // On juge le CODE, pas la prose : la recette d'adoption d'`apps/mobile` est documentée
    // dans les commentaires du port, et c'est sa place. Ce qui est interdit, c'est qu'une
    // seule ligne EXÉCUTABLE de `@bob/ui` lie ce paquet à `expo-blur`.
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const stripStrings = (source: string): string =>
      source
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');

    for (const file of walk(join(uiRoot, 'src'))) {
      const code = stripComments(readFileSync(file, 'utf8'));
      // Aucune LIAISON de module : ni import statique, ni import dynamique, ni require.
      expect(code, `${file} importe expo-blur`).not.toMatch(
        /(?:from|import|require)\s*\(?\s*['"]expo-blur['"]/,
      );
      // La cible de flou appartient à `apps/mobile` : `@bob/ui` ne la monte pas, ne la nomme
      // pas, ne la type pas. Sa `ref` ne franchit jamais la frontière de paquet — le port est
      // une CLOSURE créée dans l'application, qui la capture lexicalement.
      expect(stripStrings(code), `${file} nomme la cible de flou`).not.toMatch(
        /BlurTargetView|blurTarget/,
      );
    }
  });
});
