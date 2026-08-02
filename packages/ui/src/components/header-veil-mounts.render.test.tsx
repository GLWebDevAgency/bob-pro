/**
 * MONTÉES DU VOILE V2 (Lot 1, plan DA 01/08) — AppHeaderNavy + InnerScreenHeader. Preuves :
 *  (a) chaque header rend le voile de SA variante (stops marine / canvas) SOUS son bord bas
 *      (bande absolue, pointerEvents none, hauteur 46 pied navy / 44 débord du contrat) ;
 *  (b) FAIL-CLOSED hérité : préférence de transparence NON RÉSOLUE ⇒ voile plat teinté,
 *      AUCUNE bande de flou même port ouvert (patron du test hostile ProgressiveBlurBob) ;
 *  (c) le contenu du header est INTACT (titre, sous-titre, topbar) et le pulse du halo reste
 *      coupé pendant la fenêtre d'ignorance motion (Animated.loop jamais appelé) ;
 *  (d) le voile est DÉCLARÉ APRÈS le dégradé (l'ordre de déclaration est la spec de
 *      profondeur) — la carte flottante de l'écran, déclarée après le header, reste au-dessus.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { patterns, surfaceVeil } from '@bob/tokens';
import { ThemeProvider } from '../theme';
import { AppHeaderNavy } from './app-header-navy';
import { InnerScreenHeader } from './inner-screen-header';
import type { BlurLayerSpec } from './progressive-blur-bob.types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FakeAnimatedValue, animatedLoop } = vi.hoisted(() => {
  class FakeAnimatedValue {
    private value: number;
    constructor(value: number) {
      this.value = value;
    }
    interpolate(): number {
      return this.value;
    }
    setValue(value: number): void {
      this.value = value;
    }
    stopAnimation(): void {}
  }
  return {
    FakeAnimatedValue,
    animatedLoop: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    // JAMAIS résolues : motion ET transparence inconnues — fail-closed partout.
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    loop: animatedLoop,
    sequence: vi.fn(() => ({})),
    timing: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  },
  Easing: {
    inOut: (f: unknown) => f,
    out: (f: unknown) => f,
    ease: {},
    cubic: {},
  },
  Pressable: 'Pressable',
  StyleSheet: {
    create: <T,>(styles: T): T => styles,
    absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  },
  Text: 'Text',
  View: 'View',
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle',
  Defs: 'Defs',
  RadialGradient: 'RadialGradient',
  Rect: 'Rect',
  Stop: 'Stop',
}));

interface RenderedNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly RenderedNode[] | null;
}

function flatten(node: RenderedNode | RenderedNode[] | string | null): readonly RenderedNode[] {
  if (node === null || typeof node === 'string') return []; // nœud texte : pas de props
  if (Array.isArray(node)) return node.flatMap((child) => flatten(child));
  return [node, ...flatten((node.children ?? null) as RenderedNode[] | null)];
}

function nodes(renderer: ReactTestRenderer): readonly RenderedNode[] {
  return flatten(renderer.toJSON() as unknown as RenderedNode);
}

async function render(node: ReactNode): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ThemeProvider>{node}</ThemeProvider>);
  });
  return renderer;
}

beforeEach(() => {
  animatedLoop.mockClear();
});

describe('AppHeaderNavy — voile marine en pied (hauteur de surcharge 46)', () => {
  it('rend le voile variante appHeaderNavy sous le bord bas : stops MARINE, enveloppe 46, bande décorative', async () => {
    const renderer = await render(
      <AppHeaderNavy
        dateLabel="Samedi 2 août"
        companyName="Fly Services"
        initials="JM"
        title="Salut Jamel"
        subtitle="2 priorités."
      />,
    );
    const all = nodes(renderer);
    // L'enveloppe du voile porte la hauteur de MONTÉE (46 = pied navy), pas le 44 du préréglage.
    const envelope = all.find((node) => node.props['testID'] === 'app-header-navy-veil');
    expect(patterns.floatingBalanceCard.headerPaddingBottom).toBe(46);
    expect(envelope?.props['style']).toMatchObject([{ top: 0, height: 46 }, undefined]);
    // Le voile teinté porte les stops de la famille MARINE.
    const veils = all.filter(
      (node) =>
        node.type === 'LinearGradient' &&
        JSON.stringify(node.props['colors']) === JSON.stringify([...surfaceVeil.light.marine.stops]),
    );
    expect(veils).toHaveLength(1);
    // La bande est décorative et hors layout : absolue, sous le bord (bottom -46), inerte.
    const band = all.find(
      (node) =>
        node.type === 'View' &&
        (node.props['style'] as { bottom?: number } | undefined)?.bottom === -46,
    );
    expect(band?.props['pointerEvents']).toBe('none');
    expect((band?.props['style'] as { position?: string }).position).toBe('absolute');
    expect((band?.props['style'] as { height?: number }).height).toBe(46);
  });

  it('le contenu du header est INTACT et le voile est déclaré APRÈS le dégradé (peint dessous la carte de l’écran)', async () => {
    const renderer = await render(
      <AppHeaderNavy
        dateLabel="Samedi 2 août"
        companyName="Fly Services"
        initials="JM"
        title="Salut Jamel"
        subtitle="2 priorités."
      />,
    );
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Salut Jamel');
    expect(rendered).toContain('2 priorités.');
    expect(rendered).toContain('Fly Services');
    // L'ordre de déclaration EST la spec de profondeur : le dégradé du header d'abord,
    // la bande de voile ensuite.
    expect(rendered.indexOf('"paddingBottom":46')).toBeLessThan(
      rendered.indexOf('app-header-navy-veil'),
    );
    // Fenêtre d'ignorance motion : le pulse du halo indigo n'est PAS monté.
    expect(animatedLoop).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED : transparence non résolue ⇒ AUCUNE bande de flou, même port ouvert et couches demandées', async () => {
    const port = vi.fn((spec: BlurLayerSpec): ReactElement | null =>
      createElement('SystemGlass' as never, {
        intensity: spec.intensity,
        tint: spec.tint,
        style: spec.style,
      }),
    );
    // Le port n'a AUCUN point d'injection sur la montée : la prop n'existe pas sur
    // AppHeaderNavy — c'est le mode nominal teinté par CONSTRUCTION. On vérifie donc
    // qu'aucun échantillon n'apparaît dans l'arbre, port jamais appelé.
    const renderer = await render(
      <AppHeaderNavy
        dateLabel="d"
        companyName="c"
        initials="i"
        title="t"
        subtitle="s"
      />,
    );
    expect(port).not.toHaveBeenCalled();
    expect(nodes(renderer).some((node) => node.type === 'SystemGlass')).toBe(false);
  });
});

describe('InnerScreenHeader — voile canvas en pied (hauteur du contrat 44)', () => {
  it('rend le voile variante innerScreenHeader : stops CANVAS, enveloppe 44, bande décorative sous le bord', async () => {
    const renderer = await render(
      <InnerScreenHeader eyebrow="TES FINANCES" title="Argent" subtitle="Le vrai état des comptes." />,
    );
    const all = nodes(renderer);
    const envelope = all.find((node) => node.props['testID'] === 'inner-screen-header-veil');
    expect(envelope?.props['style']).toMatchObject([{ top: 0, height: 44 }, undefined]);
    const veils = all.filter(
      (node) =>
        node.type === 'LinearGradient' &&
        JSON.stringify(node.props['colors']) === JSON.stringify([...surfaceVeil.light.canvas.stops]),
    );
    expect(veils).toHaveLength(1);
    const band = all.find(
      (node) =>
        node.type === 'View' &&
        (node.props['style'] as { bottom?: number } | undefined)?.bottom === -44,
    );
    expect(band?.props['pointerEvents']).toBe('none');
  });

  it('les textes du header restent INTACTS (eyebrow, titre header, sous-titre), compact compris', async () => {
    const renderer = await render(
      <InnerScreenHeader eyebrow="TES FINANCES" title="Argent" subtitle="Le vrai état." compact />,
    );
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('TES FINANCES');
    expect(rendered).toContain('Argent');
    expect(rendered).toContain('Le vrai état.');
    expect(rendered).toContain('"accessibilityRole":"header"');
    expect(rendered).toContain('"paddingTop":10'); // compact : la respiration minimale
  });
});
