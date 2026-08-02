/**
 * CARNET CLIENTS — RENDU MULTI-ÉTATS (Lot 4) + FIL ROUGE « couleur de l'argent »,
 * NIVEAU RANGÉE : la teinte du montant vient de standingAccentRole (ClientRow v2 kit,
 * danger = dangerVivid #E5544B — LE même token que le héros de fiche et le liseré du
 * geste). États : chargement (skeletons), erreur bloquante (voix de Bob + retry),
 * carnet vide (invitation), nominal (rangée complète, a11y composée, statusWord).
 * Préférence motion NON RÉSOLUE partout (fail-closed du kit).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
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
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: vi.fn(), stop: vi.fn() }),
    loop: () => ({ start: vi.fn(), stop: vi.fn() }),
    sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, quad: {}, cubic: {} },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

const hoisted = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: hoisted.push }) }));
vi.mock('../../../src/agent', () => ({ usePublishAgentContext: vi.fn() }));
vi.mock('../../../src/components/customer-form', () => ({ CustomerForm: () => null }));
vi.mock('../../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 140,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));
vi.mock('../../../src/components/bob-tabs-scroll-view', async () => {
  const react = await import('react');
  return {
    TabsScrollView: ({ children }: { children?: unknown }) =>
      react.createElement('TabsScrollView', null, children as never),
  };
});

const sources = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  blocking: { value: false },
}));
vi.mock('../../../src/data/hooks', () => ({
  useCustomers: () => sources.value['customers'],
  useInvoices: () => sources.value['invoices'],
  useQuotes: () => sources.value['quotes'],
  useCreateCustomer: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('../../../src/data/query-state', () => ({
  combineQueryStates: () => ({ refetchAll: vi.fn() }),
}));
vi.mock('../../../src/data/authoritative-query-state', () => ({
  hasBlockingAuthoritativeDataError: () => sources.blocking.value,
}));

const { default: Clients } = await import('../clients');

interface QueryDouble {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
}
function q(over: Partial<QueryDouble> = {}): QueryDouble {
  return { data: undefined, isLoading: false, isError: false, isRefetching: false, refetch: vi.fn(), ...over };
}

const LATE_CUSTOMER = { id: 'c1', name: 'SARL Martin', type: 'b2b', outstandingCents: 240000 };
const LATE_INVOICE = {
  id: 'i1',
  customerId: 'c1',
  kind: 'final',
  status: 'issued',
  number: 'F-2026-001',
  parentQuoteId: null,
  totals: { ht: 200000, tva: 40000, ttc: 240000, netToPay: 240000 },
  dueAt: '2026-01-01', // échue depuis longtemps → standing en_retard
  paid: 0,
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  sources.blocking.value = false;
  sources.value = {
    customers: q({ data: [LATE_CUSTOMER] }),
    invoices: q({ data: [LATE_INVOICE] }),
    quotes: q({ data: [] }),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Clients)));
  });
  return renderer;
}

const TEST_JSON = Symbol.for('react.test.json');
const treeOf = (renderer: ReactTestRenderer): string =>
  JSON.stringify(renderer.toJSON(), (_key, value: unknown) => {
    if (value === null || typeof value !== 'object') return value;
    const tagged = value as { $$typeof?: symbol };
    if (tagged.$$typeof !== undefined && tagged.$$typeof !== TEST_JSON) return '[react-element]';
    return value;
  });

beforeEach(() => {
  configure();
});

describe('FIL ROUGE, niveau rangée — le standing teinte le montant (ClientRow v2)', () => {
  it('client en retard ⇒ montant « 2 400 € » en dangerVivid #E5544B + statusWord « en retard » (11.5)', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('SARL Martin');
    expect(rendered).toContain('en retard'); // clients.statusLate (pote)
    // LE token du fil rouge : dangerVivid — identique au héros de fiche et au liseré du geste.
    expect(rendered).toContain('"color":"#E5544B"');
    expect(rendered).toContain('"fontSize":11.5'); // statusWord AA (plus jamais slate300/11)
  });

  it('la rangée compose son label accessible : nom, contexte, montant + mot de statut', async () => {
    const renderer = await render();
    const row = renderer.root
      .findAllByType('Pressable' as never)
      .find((node) => {
        const label = (node.props as { accessibilityLabel?: string }).accessibilityLabel;
        return label !== undefined && label.startsWith('SARL Martin,');
      });
    expect(row).toBeDefined();
    const label = (row!.props as { accessibilityLabel: string }).accessibilityLabel;
    expect(label).toContain('en retard');
  });
});

describe('États du carnet — chargement / erreur / vide', () => {
  it('chargement (sources non servies) ⇒ skeletons, aucune rangée', async () => {
    configure({ customers: q({ isLoading: true }), invoices: q(), quotes: q() });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityElementsHidden":true');
    expect(rendered).not.toContain('SARL Martin');
  });

  it('erreur BLOQUANTE ⇒ voix de Bob (clients.dataError) + « Réessayer », jamais un carnet vide', async () => {
    sources.value = {
      customers: q({ isError: true }),
      invoices: q(),
      quotes: q(),
    };
    sources.blocking.value = true;
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('SARL Martin');
  });

  it('0 client (carnet réellement vide) ⇒ invitation à créer, pas une erreur', async () => {
    configure({ customers: q({ data: [] }), invoices: q({ data: [] }), quotes: q({ data: [] }) });
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('Réessayer');
    expect(rendered).not.toContain('SARL Martin');
  });
});
