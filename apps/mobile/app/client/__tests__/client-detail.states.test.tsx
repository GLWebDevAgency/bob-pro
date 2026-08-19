/**
 * FICHE CLIENT — RENDU MULTI-ÉTATS (Lot 4) + PLANCHE « COULEUR DE L'ARGENT » EXÉCUTABLE :
 * pour un client EN RETARD, le MÊME token dangerVivid (#E5544B) teinte
 *  · l'encours du héros (MoneyText moneyHero sur BobSurface marine),
 *  · ET le liseré de la StickyActionBar 'floating' (borderBottom 3) du geste
 *    « Relancer F-2026-001 · 2 400 € » ;
 * c'est exactement la teinte de la rangée du carnet (clients.states) — carnet → fiche →
 * geste, une seule dérivation (standingAccentColor). États : chargement, introuvable,
 * erreur bloquante. Préférence motion NON RÉSOLUE partout (fail-closed).
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
    setAccessibilityFocus: vi.fn(),
    announceForAccessibility: vi.fn(),
  },
  Alert: { alert: vi.fn() },
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
  Linking: { openURL: vi.fn(async () => {}) },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  findNodeHandle: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }));
// ActionDiffView (grammaire partagée de la carte Jarvis) tire les icônes Expo : le vrai paquet
// n'est pas résolvable hors bundler Metro.
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

const hoisted = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), setParams: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => ({
    push: hoisted.push,
    back: hoisted.back,
    replace: hoisted.replace,
    setParams: hoisted.setParams,
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({ id: 'c1' }),
}));
vi.mock('../../../src/agent', () => ({
  usePublishAgentContext: vi.fn(),
  // Aucun run Jarvis dans cette planche : la fiche doit rendre EXACTEMENT comme avant U1-e.
  useJarvisRunFrame: () => ({
    state: { phase: 'absent' },
    coordinator: null,
    refresh: vi.fn(),
  }),
  jarvisFrameTargetsCustomer: () => false,
}));
vi.mock('../../../src/components/customer-form', () => ({ CustomerForm: () => null }));
vi.mock('../../../src/components/CustomerBillingSections', () => ({ CustomerBillingSections: () => null }));
vi.mock('../../../src/components/CustomerContactsCard', () => ({ CustomerContactsCard: () => null }));
vi.mock('../../../src/components/CustomerContractsCard', () => ({ CustomerContractsCard: () => null }));
vi.mock('../../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 150,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));
vi.mock('../../../src/data/documents', () => ({ useDocuments: () => sources.value['documents'] }));
vi.mock('../../../src/data/client', () => ({
  useBobClient: () => ({ documentDownloadUrl: vi.fn(async () => ({ ok: false })) }),
}));
vi.mock('../../../src/lib/navigation-notice', () => ({
  consumeContractDeletedNotice: () => null,
}));

const sources = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  blocking: { value: false },
}));
vi.mock('../../../src/data/hooks', () => ({
  useChantiers: () => sources.value['chantiers'],
  useCreateChantier: () => ({ isPending: false, mutate: vi.fn() }),
  useCustomers: () => sources.value['customers'],
  useProfile: () => sources.value['profile'],
  useQuotes: () => sources.value['quotes'],
  useInvoices: () => sources.value['invoices'],
  useSearchAddress: () => ({ isPending: false, isError: false, isSuccess: false, variables: undefined, reset: vi.fn(), mutate: vi.fn() }),
  useUpdateCustomer: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('../../../src/data/authoritative-query-state', () => ({
  hasBlockingAuthoritativeDataError: () => sources.blocking.value,
}));

const { default: ClientDetail } = await import('../[id]');

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

const LATE_CUSTOMER = {
  id: 'c1',
  name: 'SARL Martin',
  type: 'b2b',
  outstandingCents: 240000,
  siren: null,
  siret: null,
  tvaIntracom: null,
  email: 'compta@martin.fr',
  phone: null,
  avgDelayDays: null,
  contactName: null,
  address: { line1: '', zip: '', city: '' },
  paymentHistoryStatus: 'incomplete',
  paidOnTimeRatio: null,
  settledInvoiceCount: 0,
  paymentTermsLabel: null,
  paymentTerms: null,
  billingChannel: null,
  isInternational: false,
  isSubcontractingBtp: false,
};
const LATE_INVOICE = {
  id: 'i1',
  customerId: 'c1',
  kind: 'final',
  status: 'issued',
  number: 'F-2026-001',
  parentQuoteId: null,
  totals: { ht: 200000, tva: 40000, ttc: 240000, netToPay: 240000 },
  dueAt: '2026-01-01',
  issuedAt: '2025-12-15',
  paid: 0,
  chantierId: null,
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  sources.blocking.value = false;
  sources.value = {
    customers: q({ data: [LATE_CUSTOMER] }),
    invoices: q({ data: [LATE_INVOICE] }),
    quotes: q({ data: [] }),
    chantiers: q({ data: [] }),
    documents: q({ data: [] }),
    profile: q({ data: { trade: 'plombier', modules: [] } }),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(ClientDetail)));
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

/** La pilule du geste : accessibilityLabel EXACT du CTA relance (moteur C10, i18n pote). */
function findStickyPill(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType('Pressable' as never)
    .find(
      (node) =>
        (node.props as { accessibilityLabel?: string }).accessibilityLabel ===
        'Relancer F-2026-001 · 2 400 €',
    );
}

beforeEach(() => {
  configure();
});

describe('PLANCHE « couleur de l’argent » — fiche + geste au MÊME token que le carnet', () => {
  it('héros : l’encours 2 400 € en moneyHero (27/800) TEINTÉ dangerVivid #E5544B', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('SARL Martin');
    // Le cran héros du Lot 0 (famille display 27/800) porte l'encours…
    expect(rendered).toContain('"fontSize":27');
    // …dans LE token du standing (le même que la rangée du carnet).
    expect(rendered).toContain('"color":"#E5544B"');
  });

  it('geste : la StickyActionBar floating porte le liseré borderBottom 3 en #E5544B et cite F-2026-001', async () => {
    const renderer = await render();
    const pill = findStickyPill(renderer);
    expect(pill).toBeDefined();
    // Le style de la pilule est une fonction ({pressed}) — on l'évalue pour lire le liseré.
    const styleOf = (pill!.props as { style: (state: { pressed: boolean }) => unknown }).style;
    const resolved = JSON.stringify(styleOf({ pressed: false }));
    // Le liseré accent : trait bas de 3, teinte du standing — le fil rouge jusque dans le geste.
    expect(resolved).toContain('"borderBottomWidth":3');
    expect(resolved).toContain('"borderBottomColor":"#E5544B"');
  });

  it('le geste navigue vers l’assistant avec le prompt relance (parité humain ↔ Bob)', async () => {
    const renderer = await render();
    const pill = findStickyPill(renderer);
    expect(pill).toBeDefined();
    await act(async () => {
      (pill!.props as { onPress: () => void }).onPress();
    });
    expect(hoisted.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/assistant',
      params: { prompt: 'relance' },
    });
  });

  it('le crayon : le bouton d’édition est annoncé « Modifier » (fiche.editCta) — plus de « … » muet', async () => {
    const renderer = await render();
    const edit = renderer.root
      .findAllByType('Pressable' as never)
      .find((node) => {
        const label = (node.props as { accessibilityLabel?: string }).accessibilityLabel;
        return label !== undefined && label.toLowerCase().includes('modifier');
      });
    expect(edit).toBeDefined();
  });
});

describe('États de la fiche — chargement / introuvable / erreur', () => {
  it('chargement ⇒ skeletons annoncés busy, aucun contenu client', async () => {
    configure({ customers: q({ isLoading: true }), invoices: q(), quotes: q() });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"busy":true');
    expect(rendered).not.toContain('SARL Martin');
  });

  it('client introuvable (carnet servi sans lui) ⇒ notFound + retour, jamais un squelette éternel', async () => {
    configure({ customers: q({ data: [] }), invoices: q({ data: [] }), quotes: q({ data: [] }) });
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('SARL Martin');
    expect(rendered).not.toContain('"borderBottomWidth":3'); // aucun geste sticky sans client
  });

  it('erreur BLOQUANTE du carnet ⇒ « Réessayer », aucune CTA sticky', async () => {
    sources.value = {
      customers: q({ isError: true }),
      invoices: q(),
      quotes: q(),
      chantiers: q(),
      documents: q(),
      profile: q(),
    };
    sources.blocking.value = true;
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('"borderBottomColor":"#E5544B"');
  });
});
