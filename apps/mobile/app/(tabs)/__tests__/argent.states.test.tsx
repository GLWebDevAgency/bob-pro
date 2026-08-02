/**
 * ARGENT — RENDU MULTI-ÉTATS (critères de preuve Lot 1 + incident fondateur 02/08).
 *
 * LE SCÉNARIO DU FONDATEUR, REJOUÉ EN LITTÉRAUX : solde confirmé expiré (24 h,
 * BANK_BALANCE_FRESHNESS_POLICY_V1) ⇒ l'API répond 503
 * {kind:'unavailable', service:'bank-balance-stale'} sur /bank-balance ET sur /cashflow.
 * AVANT ce lot : les six queries cashflow, non reconnues comme « entrée bancaire attendue »,
 * rendaient l'erreur BLOQUANTE — plein écran « argent.dataError », la confirmation invisible.
 * EXIGENCE : l'écran présente LA CONFIRMATION comme état PRINCIPAL (héros remplacé,
 * pédagogie au point de décision), AUCUN bandeau d'erreur générique ; une erreur
 * NON-qualification garde l'état d'erreur d'avant, inchangé.
 *
 * Les préférences motion/transparence restent NON RÉSOLUES pendant tout le fichier :
 * fail-closed hérité du kit (aucun pulse, aucun fondu, voile plat) — les états se prouvent
 * dans la fenêtre d'ignorance, la plus stricte.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement, type ReactNode } from 'react';
import { ThemeProvider } from '@bob/ui';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Doublons RN / expo — préférences JAMAIS résolues (fail-closed intégral) ────────────────
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
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    Text: 'Animated.Text',
    createAnimatedComponent: (component: unknown) => component,
    loop: animatedLoop,
    sequence: vi.fn(() => ({})),
    timing: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  },
  Easing: {
    inOut: (f: unknown) => f,
    out: (f: unknown) => f,
    in: (f: unknown) => f,
    ease: {},
    cubic: {},
  },
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  Platform: {
    OS: 'ios',
    select: (options: Record<string, unknown>) => options['ios'] ?? options['default'],
  },
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

// ── Doublons d'app : routeur, feuilles, coutures — les DONNÉES restent réelles ────────────
const hoisted = vi.hoisted(() => ({
  push: vi.fn(),
  publishAgentContext: vi.fn(),
  setParams: vi.fn((params: Record<string, string | undefined>) => {
    if (params['confirmBalance'] === undefined) {
      hoisted.searchParams.value = {};
    }
  }),
  searchParams: { value: {} as Record<string, string | undefined> },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: hoisted.push, setParams: hoisted.setParams }),
  useLocalSearchParams: () => hoisted.searchParams.value,
}));

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

/** Le refus EXACT de la nuit du fondateur — servi par /bank-balance ET par /cashflow. */
const STALE_503 = { kind: 'unavailable', service: 'bank-balance-stale' } as const;

const sources = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock('../../../src/data/hooks', () => ({
  useAccountingEntries: () => sources.value['entries'],
  useCashflow: () => sources.value['cashflow'],
  useCompanyMe: () => sources.value['companyMe'],
  useCustomers: () => sources.value['customers'],
  useExpenses: () => sources.value['expenses'],
  useFiscalCalendar: () => sources.value['fiscal'],
  useInvoices: () => sources.value['invoices'],
  useLatestBankBalance: () => sources.value['bankBalance'],
  usePayments: () => sources.value['payments'],
}));
vi.mock('../../../src/data/tips', () => ({
  useFirstTimeTip: () => ({ visible: false, dismiss: vi.fn() }),
}));
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
vi.mock('../../../src/fiscal/use-owner-pay-guidance', () => ({
  useOwnerPayGuidance: () => ({ guidance: undefined, isLoading: false, isError: false }),
}));
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
vi.mock('../../../src/components/BankBalanceSheet', () => ({
  BankBalanceSheet: 'BankBalanceSheet',
}));
vi.mock('../../../src/components/RetenueSuiviCard', () => ({
  RetenueSuiviCard: () => null,
}));
vi.mock('../../../src/agent', () => ({
  usePublishAgentContext: hoisted.publishAgentContext,
}));

const { default: Argent } = await import('../argent');

// ── Jeux d'états ────────────────────────────────────────────────────────────────────────────
/** Un client réel (non vide) : le compte n'est PAS neuf — l'invitation ne masque rien. */
const CUSTOMER = { id: 'c1', name: 'Fly Services', type: 'b2b' };
/** Projection minimale RÉELLE consommée par le héros/prévision (payout + available + basis). */
const PROJECTION = {
  payout: 98700,
  available: 123456,
  vatDue: 0,
  basis: { kind: 'legacy' },
};

function configure(overrides: Partial<Record<string, unknown>> = {}): void {
  sources.value = {
    cashflow: q(),
    companyMe: q(),
    customers: q({ data: [CUSTOMER] }),
    entries: q({ data: [] }),
    expenses: q({ data: [] }),
    fiscal: q({ data: [] }),
    invoices: q({ data: [] }),
    bankBalance: q(),
    payments: q({ data: [] }),
    ...overrides,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Argent)));
  });
  return renderer;
}

/** Sérialisation SANS les éléments React passés en props (refreshControl… : structures
 *  circulaires) — les nœuds du rendu (react.test.json) restent, les assertions portent sur
 *  les textes et props scalaires rendus. */
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
  hoisted.publishAgentContext.mockClear();
  hoisted.setParams.mockClear();
  hoisted.searchParams.value = {};
  animatedLoop.mockClear();
  configure();
});

describe('SOLDE PÉRIMÉ — le scénario du fondateur, rejoué', () => {
  it('bank-balance 503 stale + LES SIX cashflow 503 stale ⇒ LA CONFIRMATION est l’état principal, AUCUNE erreur générique', async () => {
    configure({
      bankBalance: q({ isError: true, error: STALE_503 }),
      cashflow: q({ isError: true, error: STALE_503 }),
    });
    const rendered = treeOf(await render());
    // L'état PRINCIPAL : le héros est remplacé par la confirmation actionnable, pédagogie
    // au point de décision (« une vieille vérité n'est pas une vérité »).
    expect(rendered).toContain('Ton solde a pris un coup de vieux');
    expect(rendered).toContain('Une vieille vérité n’est pas une vérité');
    expect(rendered).toContain('Confirmer mon solde');
    // AUCUN bandeau d'erreur générique — ni plein écran, ni bannière.
    expect(rendered).not.toContain('Je n’arrive pas à lire tes comptes'); // argent.dataError (pote)
    expect(rendered).not.toContain('Réessayer'); // le CTA d'ErrorRetry n'existe nulle part
    // Le héros placeholder « — » n'est PAS l'état montré (la confirmation a pris le slot).
    expect(rendered).not.toContain('Trésorerie mobilisable');
  });

  it('solde JAMAIS confirmé (404) ⇒ même premier plan, copy « premier solde » (pas « périmé »)', async () => {
    configure({
      bankBalance: q({
        isError: true,
        error: { kind: 'not_found', entity: 'bank_balance_snapshot' },
      }),
      cashflow: q({
        isError: true,
        error: { kind: 'unavailable', service: 'cashflow-banking-source' },
      }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Dis-moi ce qu’il y a vraiment en banque'); // argent.balanceNeededTitle
    expect(rendered).not.toContain('coup de vieux');
    expect(rendered).not.toContain('Je n’arrive pas à lire tes comptes');
  });

  it('?confirmBalance=1 (arrivée depuis l’Accueil) ⇒ la feuille de confirmation est DÉJÀ ouverte', async () => {
    hoisted.searchParams.value = { confirmBalance: '1' };
    configure({
      bankBalance: q({ isError: true, error: STALE_503 }),
      cashflow: q({ isError: true, error: STALE_503 }),
    });
    const renderer = await render();
    const sheet = renderer.root.findByType('BankBalanceSheet' as never);
    expect((sheet.props as { visible: boolean }).visible).toBe(true);
    expect(hoisted.setParams).toHaveBeenCalledWith({ confirmBalance: undefined });
  });

  it('consomme le deep-link puis autorise une seconde ouverture dans le même montage', async () => {
    hoisted.searchParams.value = { confirmBalance: '1' };
    configure({
      bankBalance: q({ isError: true, error: STALE_503 }),
      cashflow: q({ isError: true, error: STALE_503 }),
    });
    const renderer = await render();
    let sheet = renderer.root.findByType('BankBalanceSheet' as never);
    expect((sheet.props as { visible: boolean }).visible).toBe(true);

    await act(async () => {
      (sheet.props as { onClose: () => void }).onClose();
    });
    expect(
      (renderer.root.findByType('BankBalanceSheet' as never).props as { visible: boolean }).visible,
    ).toBe(false);

    // Le routeur a retiré le premier paramètre. Ce rendu intermédiaire réarme l'effet.
    await act(async () => {
      renderer.update(createElement(ThemeProvider, null, createElement(Argent)));
    });
    hoisted.searchParams.value = { confirmBalance: '1' };
    await act(async () => {
      renderer.update(createElement(ThemeProvider, null, createElement(Argent)));
    });

    sheet = renderer.root.findByType('BankBalanceSheet' as never);
    expect((sheet.props as { visible: boolean }).visible).toBe(true);
    expect(hoisted.setParams).toHaveBeenCalledTimes(2);
  });

  it('stale avec anciennes données en cache ⇒ confirmation, aucun ancien montant nominal', async () => {
    configure({
      bankBalance: q({
        data: { amountCents: 8_765_400, position: null },
        isError: true,
        error: STALE_503,
      }),
      cashflow: q({ data: PROJECTION, isError: true, error: STALE_503 }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Ton solde a pris un coup de vieux');
    expect(rendered).not.toContain('987');
    expect(rendered).not.toContain('87 654');
    expect(hoisted.publishAgentContext.mock.lastCall?.[0]).toMatchObject({
      entities: [],
      capabilities: [],
    });
  });

  it('incident cashflow réel avec cache ⇒ récupération fail-closed, aucun ancien montant', async () => {
    configure({
      cashflow: q({
        data: PROJECTION,
        isError: true,
        error: { kind: 'unavailable', service: 'database' },
      }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Je n’arrive pas à lire tes comptes');
    expect(rendered).not.toContain('987');
  });

  it('solde nominal + cashflow-banking-source ⇒ incident incohérent, jamais confirmation', async () => {
    configure({
      bankBalance: q({ data: { amountCents: 42_000, position: null } }),
      cashflow: q({
        isError: true,
        error: { kind: 'unavailable', service: 'cashflow-banking-source' },
      }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Je n’arrive pas à lire tes comptes');
    expect(rendered).not.toContain('Confirmer mon solde');
  });

  it('cashflow stale devance le refetch solde avec cache ⇒ confirmation et ancien solde masqué', async () => {
    configure({
      bankBalance: q({
        data: { amountCents: 8_765_400, position: null },
        isRefetching: true,
      }),
      cashflow: q({ isError: true, error: STALE_503 }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Ton solde a pris un coup de vieux');
    expect(rendered).not.toContain('87 654');
    expect(rendered).not.toContain('Je n’arrive pas à lire tes comptes');
  });

  it('solde nominal + cashflow réussi bankingSource:none ⇒ récupération fail-closed', async () => {
    configure({
      bankBalance: q({ data: { amountCents: 42_000, position: null } }),
      cashflow: q({ data: { ...PROJECTION, payout: 0, available: 0, bankingSource: 'none' } }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Je n’arrive pas à lire tes comptes');
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('420');
    expect(rendered).not.toContain('Confirmer mon solde');
  });

  it('solde 404 + cashflow réussi bankingSource:none ⇒ confirmation, jamais projection zéro', async () => {
    configure({
      bankBalance: q({
        isError: true,
        error: { kind: 'not_found', entity: 'bank_balance_snapshot' },
      }),
      cashflow: q({ data: { ...PROJECTION, payout: 0, available: 0, bankingSource: 'none' } }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Dis-moi ce qu’il y a vraiment en banque');
    expect(rendered).toContain('Confirmer mon solde');
    expect(rendered).not.toContain('Je n’arrive pas à lire tes comptes');
  });

  it('VRAIE panne cashflow (503 database, pas une qualification) ⇒ l’état d’erreur d’AVANT, inchangé — et jamais la confirmation', async () => {
    configure({
      bankBalance: q({ isError: true, error: STALE_503 }),
      cashflow: q({ isError: true, error: { kind: 'unavailable', service: 'database' } }),
    });
    const rendered = treeOf(await render());
    // L'incident réel est BLOQUANT (aucune source cashflow n'a jamais répondu) : page de
    // récupération plein écran, comme avant ce lot.
    expect(rendered).toContain('Je n’arrive pas à lire tes comptes');
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('coup de vieux');
    expect(rendered).not.toContain('Confirmer mon solde');
  });
});

describe('Les autres états de l’écran — welcome / nominal / chargement', () => {
  it('compte NEUF (toutes sources vides, solde jamais confirmé) ⇒ l’invitation, PAS la carte de confirmation', async () => {
    configure({
      customers: q({ data: [] }),
      bankBalance: q({
        isError: true,
        error: { kind: 'not_found', entity: 'bank_balance_snapshot' },
      }),
      cashflow: q({
        isError: true,
        error: { kind: 'unavailable', service: 'cashflow-banking-source' },
      }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Ton argent apparaîtra ici'); // argent.emptyTitle (pote)
    expect(rendered).toContain('Confirmer mon solde'); // le CTA solde DE L'INVITATION
    expect(rendered).not.toContain('coup de vieux'); // jamais deux cartes concurrentes
    // …et le HÉROS de confirmation (copy 404) n'est PAS monté à côté de l'invitation :
    // l'invitation porte déjà le geste, une seule carte le réclame.
    expect(rendered).not.toContain('Dis-moi ce qu’il y a vraiment en banque');
  });

  it('solde DÉJÀ 503 stale pendant que la prévision CHARGE encore ⇒ skeletons — la confirmation n’éjecte jamais le premier chargement', async () => {
    configure({
      bankBalance: q({ isError: true, error: STALE_503 }),
      cashflow: q({ isLoading: true }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Trésorerie mobilisable'); // le placeholder héros tient le slot
    expect(rendered).not.toContain('coup de vieux'); // le héros de confirmation attend la fin du 1er fetch
    expect(rendered).not.toContain('Je n’arrive pas à lire tes comptes');
  });

  it('cashflow déjà servi mais GET solde encore indéterminé ⇒ skeleton, aucun héros nominal', async () => {
    configure({
      bankBalance: q({ isLoading: true }),
      cashflow: q({ data: PROJECTION }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Trésorerie mobilisable');
    expect(rendered).not.toContain('987');
    expect(rendered).not.toContain('Je n’arrive pas à lire tes comptes');
  });

  it('erreur connue pendant qu’une autre source charge ⇒ récupération immédiate, aucun montant', async () => {
    configure({
      bankBalance: q({ data: { amountCents: 42_000, position: null } }),
      cashflow: q({
        data: PROJECTION,
        isError: true,
        error: { kind: 'unavailable', service: 'database' },
      }),
      invoices: q({ isLoading: true }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Je n’arrive pas à lire tes comptes');
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('987');
    expect(rendered).not.toContain('420');
  });

  it('NOMINAL : héros avec donnée réelle + grand-livre + prévision — ni erreur, ni confirmation', async () => {
    configure({
      bankBalance: q({ data: { amountCents: 500_000, position: null } }),
      cashflow: q({ data: PROJECTION }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('987'); // le payout du héros (98 700 → 987 €)
    expect(rendered).toContain('Trésorerie mobilisable'); // argent.heroLabel (pote)
    expect(rendered).not.toContain('coup de vieux');
    expect(rendered).not.toContain('Je n’arrive pas à lire tes comptes');
  });

  it('PREMIER CHARGEMENT : skeletons, jamais un message d’erreur, jamais la confirmation — et AUCUN pulse (préférence inconnue = fail-closed)', async () => {
    configure({
      cashflow: q({ isLoading: true }),
      bankBalance: q({ isLoading: true }),
      invoices: q({ isLoading: true }),
      expenses: q({ isLoading: true }),
      entries: q({ isLoading: true }),
      companyMe: q({ isLoading: true }),
      payments: q({ isLoading: true }),
      customers: q({ isLoading: true }),
      fiscal: q({ isLoading: true }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Trésorerie mobilisable'); // le label du placeholder héros
    expect(rendered).not.toContain('Je n’arrive pas à lire tes comptes');
    expect(rendered).not.toContain('coup de vieux');
    // Fenêtre d'ignorance motion : les skeletons sont STATIQUES (fail-closed hérité du kit).
    expect(animatedLoop).not.toHaveBeenCalled();
  });
});
