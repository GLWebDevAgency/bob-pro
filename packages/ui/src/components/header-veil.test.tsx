/**
 * HeaderVeil — variantes du voile de header (Lot 0). Preuves :
 *  (a) préréglages PURS figés (anchor top partout, canvas pour innerScreenHeader/stickyBackRow,
 *      marine pour appHeaderNavy, hauteur = débord du contrat 44) ;
 *  (b) FAIL-CLOSED hérité et NON réouvert : préférence de transparence NON RÉSOLUE ⇒ voile
 *      plat opaque (plan `tinted` / `preference-unresolved`) MÊME avec un port scellé et des
 *      couches demandées — patron du test hostile de ProgressiveBlurBob ;
 *  (c) le voile rendu porte les stops du ton de la variante (canvas ≡ recette tab bar).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement, type ReactElement } from 'react';
import { patterns, surfaceVeil } from '@bob/tokens';
import { ThemeProvider } from '../theme';
import { HeaderVeil } from './header-veil';
import { DEFAULT_HEADER_VEIL_HEIGHT, headerVeilPreset } from './header-veil.logic';
import type { ProgressiveBlurPlan } from './progressive-blur-bob.logic';
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
  View: 'View',
  Text: 'Text',
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

beforeEach(() => {
  isReduceMotionEnabled.mockReset();
  isReduceMotionEnabled.mockResolvedValue(false);
  isReduceTransparencyEnabled.mockReset();
});

describe('headerVeilPreset — préréglages purs', () => {
  it('fige les 3 variantes : anchor top, canvas/canvas/marine, hauteur = débord du contrat (44)', () => {
    expect(DEFAULT_HEADER_VEIL_HEIGHT).toBe(44); // patterns.edgeFalloff.bleed
    expect(DEFAULT_HEADER_VEIL_HEIGHT).toBe(patterns.edgeFalloff.bleed);
    expect(headerVeilPreset('innerScreenHeader')).toEqual({ anchor: 'top', tone: 'canvas', height: 44 });
    expect(headerVeilPreset('stickyBackRow')).toEqual({ anchor: 'top', tone: 'canvas', height: 44 });
    expect(headerVeilPreset('appHeaderNavy')).toEqual({ anchor: 'top', tone: 'marine', height: 44 });
  });
});

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

function nodes(renderer: ReactTestRenderer): readonly RenderedNode[] {
  return flatten(renderer.toJSON() as unknown as RenderedNode);
}

describe('HeaderVeil — fail-closed hérité du mécanisme', () => {
  it('préférence de transparence NON RÉSOLUE ⇒ voile plat opaque, AUCUNE bande de flou, même port ouvert', async () => {
    // La lecture ne se résout JAMAIS pendant le test : préférence 'unknown'.
    isReduceTransparencyEnabled.mockReturnValue(new Promise<boolean>(() => {}));
    const plans: ProgressiveBlurPlan[] = [];
    const port = vi.fn((spec: BlurLayerSpec): ReactElement | null =>
      createElement('SystemGlass' as never, {
        intensity: spec.intensity,
        tint: spec.tint,
        style: spec.style,
      }),
    );

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ThemeProvider>
          <HeaderVeil
            variant="innerScreenHeader"
            layers={3}
            renderBlurLayer={port}
            renderCapability="capable"
            surfaceUnder="static"
            devShellHeight={800}
            onPlan={(plan) => plans.push(plan)}
            testID="veil"
          />
        </ThemeProvider>,
      );
    });

    // Témoin : le plan a bien été émis, et il est FERMÉ pour la bonne raison.
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.at(-1)).toMatchObject({ mode: 'tinted', reason: 'preference-unresolved' });
    // Aucune bande de flou montée : le port n'est jamais appelé.
    expect(port).not.toHaveBeenCalled();
    expect(nodes(renderer).some((node) => node.type === 'SystemGlass')).toBe(false);
    // Le voile teinté est rendu, aux stops CANVAS (la recette de fondu déjà livrée).
    const veil = nodes(renderer).find((node) => node.type === 'LinearGradient');
    expect(veil).toBeDefined();
    expect(veil?.props['colors']).toEqual([...surfaceVeil.light.canvas.stops]);
  });

  it('variante appHeaderNavy : le voile porte les stops de la famille MARINE, ancré en haut', async () => {
    isReduceTransparencyEnabled.mockReturnValue(new Promise<boolean>(() => {}));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ThemeProvider>
          <HeaderVeil variant="appHeaderNavy" testID="veil" />
        </ThemeProvider>,
      );
    });
    const veil = nodes(renderer).find((node) => node.type === 'LinearGradient');
    expect(veil?.props['colors']).toEqual([...surfaceVeil.light.marine.stops]);
    // Enveloppe ancrée au bord HAUT (chrome haut), hauteur par défaut du contrat.
    const envelope = nodes(renderer).find((node) => node.props['testID'] === 'veil');
    expect(envelope?.props['style']).toMatchObject([{ top: 0, height: 44 }, undefined]);
  });

  it('la prop height SURCHARGE la hauteur du préréglage — témoin du mutant `height ?? preset.height` → `preset.height` (finding Lot 0)', async () => {
    isReduceTransparencyEnabled.mockReturnValue(new Promise<boolean>(() => {}));
    // 46 = la hauteur de montée RÉELLE du Lot 1 (pied navy d'AppHeaderNavy,
    // patterns.floatingBalanceCard.headerPaddingBottom) — PAS le 44 du préréglage.
    expect(headerVeilPreset('appHeaderNavy').height).toBe(44);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ThemeProvider>
          <HeaderVeil variant="appHeaderNavy" height={46} testID="veil" />
        </ThemeProvider>,
      );
    });
    const envelope = nodes(renderer).find((node) => node.props['testID'] === 'veil');
    expect(envelope?.props['style']).toMatchObject([{ top: 0, height: 46 }, undefined]);
  });
});
