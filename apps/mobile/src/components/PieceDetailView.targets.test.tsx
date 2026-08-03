/**
 * PieceDetailView — CIBLES TACTILES (critère de preuve du plan Lot 3, verdict PR #61 P2) :
 * « croix PieceDetailView 44 » était vraie dans le code mais verrouillée par AUCUN test —
 * le mutant 44→38 survivait. Assertions SCOPÉES AU NŒUD (leçon transverse du verdict) sur
 * la VRAIE vue (buildPieceView réel, aucune doublure de la vue elle-même).
 * Les chips liées ≥ 28 + hitSlop 8 ont leur témoin côté écran (ventes.states.test).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { buildPieceView } from '@bob/core';
import { ThemeProvider } from '@bob/ui';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FakeAnimatedValue } = vi.hoisted(() => {
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
  return { FakeAnimatedValue };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  ActivityIndicator: 'ActivityIndicator',
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }) }),
    loop: () => ({ start: vi.fn(), stop: vi.fn() }),
    sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, quad: {}, cubic: {} },
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o['ios'] ?? o['default'] },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-gesture-handler', () => ({ Swipeable: 'Swipeable' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Feather: 'Feather' }));
vi.mock('../data/identity', () => ({
  useIdentity: () => ({ companyName: 'EURL Meghassene', legalForm: 'EURL' }),
}));
vi.mock('./use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 140,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));

const { PieceDetailView } = await import('./PieceDetailView');

/** Vue RÉELLE (use case pur @bob/core) — devis signé b2b, une ligne, aucun lien. */
const VIEW = buildPieceView({
  source: 'quote',
  quote: {
    id: 'q1',
    status: 'signed',
    number: 'D-2026-014',
    depositPct: null,
    totals: { ht: 100000, vatByRate: { '20': 20000 }, vat: 20000, ttc: 120000, netToPay: 120000 },
    lines: [{ id: 'l1', label: 'Pose PAC', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 }],
    signed: true,
    customerId: 'c1',
  },
  customer: { id: 'c1', name: 'SARL Martin Rénovation', type: 'b2b', siren: '821503646' },
});

type StyleEntry = Record<string, unknown> | null | undefined | false | readonly StyleEntry[];
function flattenStyle(style: StyleEntry): Record<string, unknown> {
  if (style === null || style === undefined || style === false) return {};
  if (Array.isArray(style)) {
    return (style as readonly StyleEntry[]).reduce<Record<string, unknown>>(
      (acc, entry) => ({ ...acc, ...flattenStyle(entry) }),
      {},
    );
  }
  return { ...(style as Record<string, unknown>) };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(ThemeProvider, null, createElement(PieceDetailView, { view: VIEW, onClose: () => {} })),
    );
  });
  return renderer;
}

describe('Croix « Fermer » — cible tactile 44, scopée au nœud', () => {
  it('width 44 × height 44 (gants du chantier) — le mutant 44→38 rougit ICI', async () => {
    const renderer = await render();
    const close = renderer.root
      .findAllByType('Pressable' as never)
      .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === 'Fermer');
    expect(close, 'croix « Fermer » introuvable').toBeDefined();
    const style = flattenStyle((close!.props as { style: StyleEntry }).style);
    expect(style['width']).toBe(44);
    expect(style['height']).toBe(44);
    // Le plancher du plan est STRICT : 44, pas « au moins ~38 qui passe à peu près ».
    expect(style['width']).not.toBe(38);
    expect(style['height']).not.toBe(38);
  });
});
