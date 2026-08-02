/**
 * ACCUEIL — RENDU MULTI-ÉTATS (critères de preuve Lot 1 + incident fondateur 02/08).
 *
 * L'Accueil surface la trésorerie (héros solde + tuile fin de mois) : quand le solde attend
 * une CONFIRMATION (périmé/jamais confirmé — /bank-balance ET /cashflow en 503 qualification),
 * l'écran doit lier son état au MÊME geste que l'écran Argent — navigation vers Argent avec
 * la feuille de confirmation DÉJÀ ouverte (?confirmBalance=1) — et ne montrer AUCUNE erreur
 * générique. Un VRAI incident garde l'ErrorNotice 2 faces (+ retry), inchangé.
 *
 * Préférences motion/transparence NON RÉSOLUES pendant tout le fichier (fail-closed du kit).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement, type ReactNode } from 'react';
import { ThemeProvider } from '@bob/ui';

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
  return { FakeAnimatedValue, animatedLoop: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
    setAccessibilityFocus: vi.fn(),
  },
  Alert: { alert: vi.fn() },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    Text: 'Animated.Text',
    createAnimatedComponent: (component: unknown) => component,
    loop: animatedLoop,
    sequence: vi.fn(() => ({})),
    timing: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, in: (f: unknown) => f, ease: {}, cubic: {} },
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Dimensions: { get: () => ({ width: 390, height: 844 }) },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: {
    create: <T,>(styles: T): T => styles,
    absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  },
  Text: 'Text',
  View: 'View',
  findNodeHandle: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle',
  Defs: 'Defs',
  Path: 'Path',
  RadialGradient: 'RadialGradient',
  Rect: 'Rect',
  Stop: 'Stop',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', Ionicons: 'Ionicons' }));
vi.mock('@bob/ai', () => ({ challengeFor: () => ({ level: 'none' }) }));

const hoisted = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: hoisted.push }) }));

interface QueryDouble {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isRefetching: boolean;
  refetch: () => void;
}
function q(over: Partial<QueryDouble> = {}): QueryDouble {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: undefined,
    isRefetching: false,
    refetch: vi.fn(),
    ...over,
  };
}

const STALE_503 = { kind: 'unavailable', service: 'bank-balance-stale' } as const;

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../../../src/data/hooks', () => ({
  appErrorMessage: (e: unknown) => String(e),
  useCashflow: () => sources.value['cashflow'],
  useCompanyMe: () => sources.value['companyMe'],
  useInvoices: () => sources.value['invoices'],
  useLatestBankBalance: () => sources.value['bankBalance'],
  useMaintenanceContracts: () => sources.value['contracts'],
  useNotificationsFeed: () => sources.value['notifications'],
  usePrepareContractAnnualInvoice: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useTodayPriorities: () => sources.value['today'],
}));
vi.mock('../../../src/data/identity', () => ({
  useIdentity: () => ({
    companyName: 'Fly Services',
    initials: 'JM',
    firstName: 'Jamel',
    fullName: 'Jamel M.',
  }),
}));
vi.mock('../../../src/components/ConfirmSheet', () => ({
  useConfirm: () => vi.fn(async () => false),
}));
vi.mock('../../../src/quote-draft', () => ({
  useQuoteDraft: () => ({
    persistence: { ready: true },
    pendingResume: null,
    state: { saved: null, customer: null },
    discard: vi.fn(),
  }),
  hasMeaningfulQuoteDraft: () => false,
}));
vi.mock('../../../src/components/profile-menu-sheet', () => ({ ProfileMenuSheet: () => null }));
vi.mock('../../../src/components/CollectInvoiceButton', () => ({ CollectInvoiceButton: () => null }));
vi.mock('../../../src/components/ShareQuoteLinkButton', () => ({ ShareQuoteLinkButton: () => null }));
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
    TabsScrollView: ({ children }: { children?: ReactNode }) =>
      react.createElement('TabsScrollView', null, children),
  };
});
vi.mock('../../../src/engagement/ValueDigestCard', () => ({ LatestValueDigestCard: () => null }));
vi.mock('../../../src/monetization/TrialReportCard', () => ({ LatestTrialReportCard: () => null }));
vi.mock('../../../src/agent', () => ({ usePublishAgentContext: vi.fn() }));
vi.mock('../../../src/fiscal/use-fiscal-profile-flow', () => ({
  useFiscalProfileFlow: () => ({
    hasPending: false,
    openFlow: vi.fn(),
    sheets: null,
    voiceAffordances: [],
    profile: {},
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../../src/documents-voice-search', () => ({
  useSalesDocumentVoiceAffordance: () => ({ id: 'sales-doc-search', match: () => null }),
}));
vi.mock('../../../src/components/icons', () => ({
  CalendarIcon: 'CalendarIcon',
  ChevronRightIcon: 'ChevronRightIcon',
  ClockIcon: 'ClockIcon',
  CurrencyIcon: 'CurrencyIcon',
  DepositIcon: 'DepositIcon',
  ShieldIcon: 'ShieldIcon',
  TrendUpIcon: 'TrendUpIcon',
}));

const { default: Aujourdhui } = await import('../index');

function todayDouble(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    priorities: [],
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
    ...over,
  };
}
function notificationsDouble(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    isLoading: false,
    isError: false,
    isRefetching: false,
    unreadCount: 0,
    refetchFeed: vi.fn(),
    refetch: vi.fn(),
    ...over,
  };
}

function configure(overrides: Partial<Record<string, unknown>> = {}): void {
  sources.value = {
    cashflow: q(),
    companyMe: q({ data: { id: 'co1', name: 'Fly Services' } }),
    invoices: q({ data: [] }),
    bankBalance: q(),
    contracts: q({ data: [] }),
    notifications: notificationsDouble(),
    today: todayDouble(),
    ...overrides,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Aujourdhui)));
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
  hoisted.push.mockClear();
  animatedLoop.mockClear();
  configure();
});

describe('SOLDE EN ATTENTE DE CONFIRMATION — le même geste que l’écran Argent', () => {
  it('bank-balance ET cashflow en 503 stale ⇒ AUCUNE erreur générique, hint « confirme ton solde », tuiles liées au geste', async () => {
    configure({
      bankBalance: q({ isError: true, error: STALE_503 }),
      cashflow: q({ isError: true, error: STALE_503 }),
    });
    const rendered = treeOf(await render());
    // Pas de panne fabriquée : ni ErrorNotice d'écran, ni hint « indisponible ».
    expect(rendered).not.toContain('Je n’arrive pas à joindre le serveur'); // today.dataError (pote)
    expect(rendered).not.toContain('Je n’arrive pas à relire ton solde');
    // Le héros porte le GESTE attendu, à la voix de Bob.
    expect(rendered).toContain('Confirme ton solde dans Argent — je ne vais rien inventer.');
    // « En un coup d'œil » devient ACTIONNABLE : CTA vers la confirmation, pas un cul-de-sac.
    expect(rendered).toContain('Confirmer mon solde'); // today.confirmBalanceCta (pote)
  });

  it('le tap du héros navigue vers Argent AVEC la feuille de confirmation ouverte (?confirmBalance=1)', async () => {
    configure({
      bankBalance: q({ isError: true, error: STALE_503 }),
      cashflow: q({ isError: true, error: STALE_503 }),
    });
    const renderer = await render();
    const hero = renderer.root
      .findAllByType('Pressable' as never)
      .find(
        (node) =>
          (node.props as { accessibilityLabel?: string }).accessibilityLabel ===
          'Confirme ton solde dans Argent — je ne vais rien inventer.',
      );
    expect(hero).toBeDefined();
    await act(async () => {
      (hero!.props as { onPress: () => void }).onPress();
    });
    expect(hoisted.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/argent',
      params: { confirmBalance: '1' },
    });
  });

  it('VRAIE panne du solde (500 non typé) ⇒ ErrorNotice 2 faces + retry — l’état d’erreur d’avant', async () => {
    configure({
      bankBalance: q({ isError: true, error: new TypeError('fetch failed') }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Je n’arrive pas à joindre le serveur'); // today.dataError (pote)
    expect(rendered).toContain('Réessayer');
    expect(rendered).toContain('BOB-API-500'); // le code du registre fermé, face support
    expect(rendered).toContain('Je n’arrive pas à relire ton solde'); // hint indisponible, PAS « confirme »
    expect(rendered).not.toContain('Confirmer mon solde');
  });
});

describe('Les autres états du briefing — nominal / chargement', () => {
  it('NOMINAL : la FloatingBalanceCard porte le solde réel, zéro erreur, zéro CTA de confirmation', async () => {
    configure({
      bankBalance: q({ data: { amountCents: 500000, position: null } }),
      cashflow: q({ data: { available: 123400, vatDue: 0 } }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain(`5${' '}000`); // 500 000 centimes → « 5 000 € » (espace fine)
    expect(rendered).toContain('Solde bancaire observé');
    expect(rendered).not.toContain('Je n’arrive pas à joindre le serveur');
    expect(rendered).not.toContain('Confirmer mon solde');
  });

  it('PREMIER CHARGEMENT : skeletons priorités + KPI, aucun pulse (préférence motion inconnue = fail-closed)', async () => {
    configure({
      bankBalance: q({ isLoading: true }),
      cashflow: q({ isLoading: true }),
      invoices: q({ isLoading: true }),
      today: todayDouble({ isLoading: true }),
    });
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('Je n’arrive pas à joindre le serveur');
    expect(rendered).toContain('Solde bancaire observé'); // le label du placeholder héros
    expect(animatedLoop).not.toHaveBeenCalled();
  });
});
