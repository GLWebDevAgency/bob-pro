/**
 * VENTES — RENDU MULTI-ÉTATS (critères de preuve Lot 3, plan DA 01/08).
 *
 * Ce que ce fichier verrouille :
 *  · EXTINCTION : les badges de liste passent par la table FIGÉE du Lot 0
 *    (StatusBadge 11/700) et les chips liées parlent le ton NEUTRE de navigation —
 *    l'indigo (semantic.ai #4338CA / aiBg #F1EBFA) a quitté les sélections utilisateur ;
 *  · PARITÉ VOCALE : l'affordance ventes.filterKind pilote LE MÊME state que le
 *    SegmentedControl — « que les devis » fait disparaître la section Factures ;
 *  · LE CATCH MANQUANT (correction d'état sous freeze) : un échec réseau de
 *    deletePersistedDraft ouvre l'ErrorSheet — plus JAMAIS un échec muet ;
 *  · états : chargement (skeletons), erreur (ErrorRetry), vide (invitation), nominal.
 * Préférences motion/transparence NON RÉSOLUES pendant tout le fichier (fail-closed kit).
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
  ActivityIndicator: 'ActivityIndicator',
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: vi.fn(), stop: vi.fn() }),
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
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Feather: 'Feather' }));

const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => nav,
  useLocalSearchParams: () => ({}),
}));

// La surface vocale publiée est CAPTURÉE : la parité se prouve en pilotant l'affordance.
const agent = vi.hoisted(() => ({ surface: null as null | { affordances: readonly { id: string; match: (u: string) => (() => { say: string }) | null }[] } }));
vi.mock('../../src/agent', () => ({
  usePublishAgentContext: (_ctx: unknown, _layout: unknown, surface: never) => {
    agent.surface = surface;
  },
}));

vi.mock('../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 140,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));

// Confirmation contrôlable (la ConfirmSheet réelle est hors sujet ici).
const confirmDouble = vi.hoisted(() => ({ result: true, calls: 0 }));
vi.mock('../../src/components/ConfirmSheet', () => ({
  useConfirm: () => () => {
    confirmDouble.calls += 1;
    return Promise.resolve(confirmDouble.result);
  },
}));

// Brouillon persistant contrôlable (slot PostgreSQL simulé).
const draft = vi.hoisted(() => ({
  value: {
    persistence: { ready: false },
    pendingResume: null as null | { customer: { name: string } | null },
    state: { saved: null },
    discard: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('../../src/quote-draft', () => ({
  hasMeaningfulQuoteDraft: () => false,
  useQuoteDraft: () => draft.value,
}));

vi.mock('../../src/documents-voice-search', () => ({
  useSalesDocumentVoiceAffordance: () => ({ id: 'ventes.periodSearch', match: () => null }),
}));

// La modale de filtres avancés est hors sujet (elle a ses propres composants) — doublure.
vi.mock('../../src/components/DocumentSearchFiltersModal', () => ({
  DocumentSearchFiltersModal: () => null,
  EMPTY_ADVANCED_FILTERS: { customerId: null, customerName: null, number: '', label: '', dateRange: null, status: null },
}));
vi.mock('../../src/components/DocumentSearchAutocomplete', () => ({
  DocumentSearchAutocomplete: () => null,
  useRecentSalesSearches: () => ({ recent: [], push: vi.fn() }),
}));

// DocumentActions : doublure de RENDU (les badges/logique restent les VRAIS exports purs).
vi.mock('../../src/components/DocumentActions', async () => {
  const badges = await vi.importActual<typeof import('../../src/components/invoice-badge.logic')>(
    '../../src/components/invoice-badge.logic',
  );
  return {
    ...badges,
    QuoteActions: () => null,
    InvoiceActions: () => null,
    hasQuoteActions: () => false,
    hasInvoiceActions: () => false,
  };
});

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/data/hooks', () => ({
  appErrorMessage: (e: unknown) => `msg:${(e as Error).message}`,
  useCustomers: () => sources.value['customers'],
  useQuotes: () => sources.value['quotes'],
  useInvoices: () => sources.value['invoices'],
  useSalesDocumentSearch: () => sources.value['serverSearch'],
  useSalesDocumentSuggestions: () => ({ data: undefined, isLoading: false }),
}));

const { default: Ventes } = await import('../ventes');

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

const CUSTOMER = { id: 'c1', name: 'Mairie de Sèvres', type: 'b2g' };
const SIGNED_QUOTE = {
  id: 'q1',
  number: 'D-2026-004',
  customerId: 'c1',
  status: 'signed',
  validUntil: null,
  depositPct: null,
  lines: [{ label: 'Chauffe-eau thermodynamique' }],
  totals: { ttc: 138600, netToPay: 138600 },
};
const LINKED_INVOICE = {
  id: 'i1',
  number: 'F-2026-012',
  customerId: 'c1',
  kind: 'deposit',
  status: 'issued',
  parentQuoteId: 'q1',
  issuedAt: null,
  dueAt: null,
  paid: 0,
  creditNoteSource: null,
  emailDeliveredAt: undefined,
  transmission: undefined,
  lines: [{ label: 'Acompte chauffe-eau' }],
  totals: { ttc: 138600, netToPay: 41580 },
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  agent.surface = null;
  draft.value = {
    persistence: { ready: false },
    pendingResume: null,
    state: { saved: null },
    discard: vi.fn(() => Promise.resolve()),
  };
  confirmDouble.result = true;
  confirmDouble.calls = 0;
  sources.value = {
    customers: q({ data: [CUSTOMER] }),
    quotes: q({ data: [SIGNED_QUOTE] }),
    invoices: q({ data: [LINKED_INVOICE] }),
    serverSearch: { ...q(), isRefetching: false },
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Ventes)));
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

describe('Nominal — extinction legacy : la table figée et le ton neutre des chips liées', () => {
  it('badges par la table (Signé 11/700), chip liée NEUTRE (#E0E6EE), zéro indigo de sélection', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('D-2026-004');
    expect(rendered).toContain('Signé'); // QUOTE_BADGE.signed → StatusBadge
    expect(rendered).toContain('"fontSize":11'); // BADGE_FONT_SIZE du kit
    // Chip liée « F-2026-012 · 415,80 € » : ton neutre de navigation, plus jamais aiBg.
    expect(rendered).toContain('F-2026-012');
    expect(rendered).toContain('"borderColor":"#E0E6EE"');
    // Le SegmentedControl kit remplace les pilules indigo (tablist annoncé).
    expect(rendered).toContain('"accessibilityLabel":"Filtrer : tout, devis ou factures"');
    // L'indigo de SÉLECTION a disparu : aiBg ne subsiste que sur l'entrée « + Facture »
    // (CTA hors périmètre du plan) — jamais sur le filtre actif ni les chips liées.
    const chip = (await render()).root
      .findAllByType('Pressable' as never)
      .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === 'Facture F-2026-012');
    expect(chip).toBeDefined();
    expect(JSON.stringify((chip!.props as { style: unknown }).style)).not.toContain('#F1EBFA');
  });

  it('la liste montre le netToPay de la pièce (règle acompte) — 415,80 €, jamais 1 386 €', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('415,80');
  });
});

describe('Parité vocale — ventes.filterKind pilote le MÊME state que le SegmentedControl', () => {
  it('« que les devis » → la SECTION Factures disparaît (l’option du contrôle reste), say non vide', async () => {
    const renderer = await render();
    const sectionHeaders = (): string[] =>
      renderer.root
        .findAllByType('Text' as never)
        .filter((n) => (n.props as { accessibilityRole?: string }).accessibilityRole === 'header')
        .map((n) => String((n.props as { children: unknown }).children));
    expect(sectionHeaders()).toContain('Factures');
    const affordance = agent.surface?.affordances.find((a) => a.id === 'ventes.filterKind');
    expect(affordance).toBeDefined();
    const thunk = affordance!.match('affiche que les devis');
    expect(thunk).not.toBeNull();
    let say = '';
    await act(async () => {
      say = (thunk!() as { say: string }).say;
    });
    expect(say.length).toBeGreaterThan(0);
    // kindFilter === 'quotes' : la section Factures n'est plus rendue — MÊME state que le
    // SegmentedControl (dont l'option « Factures » reste sélectionnable, parité stricte).
    expect(sectionHeaders()).not.toContain('Factures');
    expect(sectionHeaders()).toContain('Devis');
  });
});

describe('Le catch manquant de deletePersistedDraft — plus JAMAIS un échec muet', () => {
  it('discard rejette ⇒ ErrorSheet « La suppression n’est pas passée » + message discriminé', async () => {
    draft.value = {
      persistence: { ready: true },
      pendingResume: { customer: { name: 'Chantier Bernard' } },
      state: { saved: null },
      discard: vi.fn(() => Promise.reject(new Error('réseau coupé'))),
    };
    const renderer = await render();
    const trash = renderer.root
      .findAllByType('Pressable' as never)
      .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === 'Supprimer le brouillon');
    expect(trash).toBeDefined();
    await act(async () => {
      (trash!.props as { onPress: () => void }).onPress();
    });
    expect(confirmDouble.calls).toBe(1);
    expect(draft.value.discard).toHaveBeenCalledTimes(1);
    const rendered = treeOf(renderer);
    expect(rendered).toContain('La suppression n’est pas passée');
    expect(rendered).toContain('msg:réseau coupé');
    // Le verrou busy est RELÂCHÉ après l'échec (finally) : la corbeille se réarme.
    const trashAfter = renderer.root
      .findAllByType('Pressable' as never)
      .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === 'Supprimer le brouillon');
    expect((trashAfter!.props as { accessibilityState: { disabled: boolean } }).accessibilityState.disabled).toBe(false);
  });

  it('annulation dans la ConfirmSheet ⇒ AUCUN appel discard (plancher inchangé)', async () => {
    confirmDouble.result = false;
    draft.value = {
      persistence: { ready: true },
      pendingResume: { customer: { name: 'Chantier Bernard' } },
      state: { saved: null },
      discard: vi.fn(() => Promise.resolve()),
    };
    const renderer = await render();
    const trash = renderer.root
      .findAllByType('Pressable' as never)
      .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === 'Supprimer le brouillon');
    await act(async () => {
      (trash!.props as { onPress: () => void }).onPress();
    });
    expect(draft.value.discard).not.toHaveBeenCalled();
  });
});

describe('États — chargement / erreur / vide (une source absente n’est jamais une collection vide)', () => {
  it('chargement ⇒ skeletons, aucune carte', async () => {
    configure({ quotes: q({ isLoading: true }), invoices: q(), customers: q() });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityElementsHidden":true');
    expect(rendered).not.toContain('D-2026-004');
  });

  it('échec réseau ⇒ ErrorRetry (Réessayer), jamais une liste vide silencieuse', async () => {
    configure({ quotes: q({ isError: true }), invoices: q(), customers: q() });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('D-2026-004');
  });

  it('0 pièce (vrai premier pas) ⇒ invitation « Ton premier devis », pas une erreur', async () => {
    configure({ quotes: q({ data: [] }), invoices: q({ data: [] }), customers: q({ data: [] }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Ton premier devis');
    expect(rendered).not.toContain('Réessayer');
  });
});
