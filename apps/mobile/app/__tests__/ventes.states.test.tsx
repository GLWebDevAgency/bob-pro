/**
 * VENTES — RENDU MULTI-ÉTATS (critères de preuve Lot 3, plan DA 01/08 + verdict PR #61).
 *
 * Ce que ce fichier verrouille :
 *  · EXTINCTION : les badges de liste passent par la table FIGÉE du Lot 0
 *    (StatusBadge 11/700) et les chips liées parlent le ton NEUTRE de navigation —
 *    l'indigo (semantic.ai #4338CA / aiBg #F1EBFA) a quitté les sélections utilisateur ;
 *  · « L'INDIGO RENDU À BOB » verrouillé sur SES TROIS NŒUDS, SCOPÉ (verdict P1) :
 *    chip liée + chip de nature (nominal) et bouton filtres actifs (fixture filtre ACTIF
 *    par deep link — la branche hasActiveFilterChips est rendue et prouvée en theme.ink) ;
 *  · CIBLES TACTILES du plan : chips ≥ 28 pt + hitSlop 8 → 44, au nœud ;
 *  · PARITÉ VOCALE dans LES DEUX SENS : l'affordance ventes.filterKind pilote le state
 *    (la section Factures disparaît) ET le SegmentedControl le REFLÈTE (selected) ;
 *  · A11Y du kindFilter : pendant le chargement, chaque onglet est disabled + ANNONCÉ
 *    disabled (plus d'enveloppe pointerEvents muette) — la garde onChange tient en double ;
 *  · ISO-INFORMATION : aucun eyebrow « Ventes » ajouté par la migration BackHeader ;
 *  · ÉCART DE CASSE DÉCLARÉ : badge du brouillon = « Brouillon » i18n (fin du .toUpperCase()) ;
 *  · LE CATCH MANQUANT (correction d'état sous freeze) : un échec réseau de
 *    deletePersistedDraft ouvre l'ErrorSheet — plus JAMAIS un échec muet ;
 *  · états : chargement (skeletons), erreur (ErrorRetry), vide (invitation), nominal.
 * Préférences motion/transparence NON RÉSOLUES pendant tout le fichier (fail-closed kit).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
// Params de route CONFIGURABLES : le deep link vocal (« les devis de Mairie de Sèvres »)
// est LE chemin réel qui allume hasActiveFilterChips — la branche « filtre actif » se
// prouve par lui (verdict PR #61, P1 : elle n'était jamais rendue par la suite).
const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock('expo-router', () => ({
  useRouter: () => nav,
  useLocalSearchParams: () => routeParams.value,
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

// Chaque Ventes publie sa surface agent à chaque rendu et porte des effets différés (dont le
// debounce de recherche). Un renderer laissé monté peut donc republier une ancienne surface sous
// contention CI et faire exécuter une commande vocale sur un autre écran que celui asserté.
// Le registre rend l'isolation exhaustive, y compris pour les tests qui appellent render() deux fois.
const mountedRenderers = new Set<ReactTestRenderer>();

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
  routeParams.value = {};
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
  mountedRenderers.add(renderer);
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

// ── Leçon transverse du verdict (PR #61) : les assertions de COULEUR se scopent AU NŒUD —
//    un toContain('<hex>') d'arbre entier ne prouve rien, le même hex vit ailleurs. ──
type StyleEntry = Record<string, unknown> | null | undefined | false | readonly StyleEntry[];
/** Aplati un style RN (objet ou tableaux imbriqués) — la DERNIÈRE valeur gagne, comme RN. */
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

interface NodeLike {
  props: Record<string, unknown> & { style?: unknown; accessibilityLabel?: string; accessibilityRole?: string };
  parent: NodeLike | null;
  children: unknown[];
}
/** Le Text d'un StatusBadge (label exact) ET son conteneur (radius 6 du kit) — scopé au nœud. */
function statusBadgeOf(renderer: ReactTestRenderer, label: string): { text: NodeLike; frame: NodeLike } {
  const text = (renderer.root.findAllByType('Text' as never) as unknown as NodeLike[]).find((n) => {
    const children = (n.props as { children?: unknown }).children;
    if (children !== label) return false;
    const parentStyle = flattenStyle((n.parent?.props.style ?? null) as StyleEntry);
    return parentStyle['borderRadius'] === 6; // BADGE_RADIUS — discrimine des textes homonymes
  });
  expect(text, `StatusBadge « ${label} » introuvable`).toBeDefined();
  return { text: text!, frame: text!.parent! };
}
/** Les onglets du SegmentedControl (rôle tab) indexés par libellé. */
function segmentTabs(renderer: ReactTestRenderer): Map<string, NodeLike> {
  const tabs = (renderer.root.findAllByType('Pressable' as never) as unknown as NodeLike[]).filter(
    (n) => n.props.accessibilityRole === 'tab',
  );
  return new Map(tabs.map((n) => [String(n.props.accessibilityLabel), n]));
}

beforeEach(() => {
  configure();
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of mountedRenderers) renderer.unmount();
  });
  mountedRenderers.clear();
  agent.surface = null;
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

  it('chip liée (PressableScale) SCOPÉE AU NŒUD : bord line, encre slate500, cible 28 + hitSlop 8 = 44', async () => {
    const renderer = await render();
    const chip = (renderer.root.findAllByType('Pressable' as never) as unknown as NodeLike[]).find(
      (n) => n.props.accessibilityLabel === 'Facture F-2026-012',
    );
    expect(chip).toBeDefined();
    const style = flattenStyle(chip!.props.style as StyleEntry);
    // NEUTRE de navigation, au nœud : jamais l'indigo de Bob (#4338CA / #F1EBFA).
    expect(style['borderColor']).toBe('#E0E6EE');
    expect(style['backgroundColor']).toBeUndefined();
    // Cible tactile du plan (« chips liées ≥ 28 pt + hitSlop → 44 ») — témoin anti-régression.
    expect(style['minHeight']).toBe(28);
    expect(style['minWidth']).toBe(28);
    expect(chip!.props['hitSlop']).toBe(8);
    expect(28 + 2 * 8).toBeGreaterThanOrEqual(44);
    // L'encre de la chip : slate500 — sur CE nœud, pas ailleurs dans l'arbre.
    const chipText = (chip!.children as NodeLike[]).find(
      (c) => typeof c === 'object' && c !== null && 'props' in c,
    );
    expect(flattenStyle(chipText!.props.style as StyleEntry)['color']).toBe('#5B6B7B');
  });

  it('chip de NATURE (« Acompte ») SCOPÉE AU NŒUD : bord line, sans fond, encre slate500 — jamais semantic.ai', async () => {
    const renderer = await render();
    const text = (renderer.root.findAllByType('Text' as never) as unknown as NodeLike[]).find(
      (n) => (n.props as { children?: unknown }).children === 'Acompte',
    );
    expect(text, 'chip de nature « Acompte » introuvable').toBeDefined();
    const textStyle = flattenStyle(text!.props.style as StyleEntry);
    expect(textStyle['color']).toBe('#5B6B7B'); // slate500 — l'indigo est rendu à Bob
    expect(textStyle['color']).not.toBe('#4338CA');
    const frame = flattenStyle((text!.parent?.props.style ?? null) as StyleEntry);
    expect(frame['borderColor']).toBe('#E0E6EE'); // colors.line
    expect(frame['backgroundColor']).toBeUndefined(); // jamais aiBg #F1EBFA
    expect(frame['minHeight']).toBe(28); // cible du plan, même témoin que les chips liées
  });

  it('la liste montre le netToPay de la pièce (règle acompte) — 415,80 €, jamais 1 386 €', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('415,80');
  });

  it('ISO-INFORMATION (verdict PR #61) : aucun eyebrow « Ventes » — l’en-tête n’ajoute aucun texte', async () => {
    const renderer = await render();
    const texts = (renderer.root.findAllByType('Text' as never) as unknown as NodeLike[]).map((n) =>
      String((n.props as { children?: unknown }).children),
    );
    // L'en-tête d'origine : retour « Accueil » + titre « Devis & Factures » — rien au-dessus.
    expect(texts).toContain('Accueil');
    expect(texts).toContain('Devis & Factures');
    expect(texts).not.toContain('Ventes');
  });
});

describe('Filtre ACTIF (deep link vocal) — la branche hasActiveFilterChips rendue et SCOPÉE (verdict PR #61, P1)', () => {
  it('bouton filtres actifs = theme.ink AU NŒUD (bord + icône) — jamais semantic.ai ; le FilterChip client rend en ink', async () => {
    // Chemin réel : deep link « les documents de Mairie de Sèvres » → customerId en route param.
    routeParams.value = { customerId: 'c1' };
    sources.value['serverSearch'] = q({ data: { hits: [{ id: 'q1' }, { id: 'i1' }] } });
    const renderer = await render();
    // La branche « filtre actif » est bien EXERCÉE : le FilterChip kit du client est là.
    const chipText = (renderer.root.findAllByType('Text' as never) as unknown as NodeLike[]).find(
      (n) => (n.props as { children?: unknown }).children === 'Client : Mairie de Sèvres',
    );
    expect(chipText, 'FilterChip « Client : … » introuvable — branche filtre actif non rendue').toBeDefined();
    // SCOPÉ AU NŒUD du chip : sélection utilisateur = theme.ink (bord #0C2340, fond teinté 9 %).
    const chipFrame = flattenStyle((chipText!.parent?.props.style ?? null) as StyleEntry);
    expect(chipFrame['borderColor']).toBe('#0C2340');
    expect(chipFrame['backgroundColor']).toBe('#E9EBEE');
    expect(chipFrame['borderColor']).not.toBe('#4338CA');
    expect(chipFrame['backgroundColor']).not.toBe('#F1EBFA');
    // SCOPÉ AU NŒUD du bouton filtres : bord theme.ink, icône theme.ink — l'indigo est à Bob.
    const btn = (renderer.root.findAllByType('Pressable' as never) as unknown as NodeLike[]).find(
      (n) => n.props.accessibilityLabel === 'Recherche avancée',
    );
    expect(btn).toBeDefined();
    const btnStyle = flattenStyle(
      (btn!.props.style as (s: { pressed: boolean }) => StyleEntry)({ pressed: false }),
    );
    expect(btnStyle['borderColor']).toBe('#0C2340'); // theme.ink (marine) — PAS #4338CA
    expect(btnStyle['borderColor']).not.toBe('#4338CA');
    const icon = (renderer.root.findAllByType('Ionicons' as never) as unknown as NodeLike[]).find(
      (n) => (n.props as { name?: string }).name === 'options-outline',
    );
    expect(icon).toBeDefined();
    expect(icon!.props['color']).toBe('#0C2340');
    expect(icon!.props['color']).not.toBe('#4338CA');
  });

  it('au repos (aucun filtre) : le MÊME nœud bouton retombe sur colors.line — la teinte est bien pilotée par l’état', async () => {
    const renderer = await render();
    const btn = (renderer.root.findAllByType('Pressable' as never) as unknown as NodeLike[]).find(
      (n) => n.props.accessibilityLabel === 'Recherche avancée',
    );
    const btnStyle = flattenStyle(
      (btn!.props.style as (s: { pressed: boolean }) => StyleEntry)({ pressed: false }),
    );
    expect(btnStyle['borderColor']).toBe('#E0E6EE');
  });
});

describe('Parité vocale — ventes.filterKind pilote le MÊME state que le SegmentedControl', () => {
  it('« que les devis » → la SECTION Factures disparaît ET le SegmentedControl REFLÈTE le state (selected), say non vide', async () => {
    const renderer = await render();
    const sectionHeaders = (): string[] =>
      renderer.root
        .findAllByType('Text' as never)
        .filter((n) => (n.props as { accessibilityRole?: string }).accessibilityRole === 'header')
        .map((n) => String((n.props as { children: unknown }).children));
    expect(sectionHeaders()).toContain('Factures');
    // Avant la voix : « Tout » est l'onglet sélectionné.
    expect(segmentTabs(renderer).get('Tout')!.props['accessibilityState']).toMatchObject({ selected: true });
    expect(segmentTabs(renderer).get('Devis')!.props['accessibilityState']).toMatchObject({ selected: false });
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
    // …ET le contrôle REFLÈTE le state piloté à la voix (value={kindFilter}, verdict PR #61 :
    // sans ce témoin, Bob dirait « je n'affiche que les devis » avec « Tout » surligné).
    expect(segmentTabs(renderer).get('Devis')!.props['accessibilityState']).toMatchObject({ selected: true });
    expect(segmentTabs(renderer).get('Tout')!.props['accessibilityState']).toMatchObject({ selected: false });
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

  it('ÉCART DE CASSE DÉCLARÉ (verdict PR #61) : le badge du brouillon rend « Brouillon » i18n tel quel — plus jamais « BROUILLON »', async () => {
    draft.value = {
      persistence: { ready: true },
      pendingResume: { customer: { name: 'Chantier Bernard' } },
      state: { saved: null },
      discard: vi.fn(() => Promise.resolve()),
    };
    const renderer = await render();
    // Témoin du NOUVEAU rendu (le .toUpperCase() du site legacy a disparu, StatusBadge ne
    // transforme pas la casse) : le libellé du badge est la clé i18n telle quelle.
    const { text } = statusBadgeOf(renderer, 'Brouillon');
    expect(flattenStyle(text.props.style as StyleEntry)['fontSize']).toBe(11); // le cran badge du kit
    expect(treeOf(renderer)).not.toContain('BROUILLON');
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

  it('chargement ⇒ le kindFilter est inerte ET ANNONCÉ désactivé (verdict PR #61, P2 a11y) — la garde tient', async () => {
    configure({ quotes: q({ isLoading: true }), invoices: q(), customers: q() });
    const renderer = await render();
    const tabs = segmentTabs(renderer);
    expect(tabs.size).toBe(3);
    for (const tab of tabs.values()) {
      // VoiceOver n'annonce plus trois onglets actionnables qui ne répondent pas :
      // disabled porté PAR SEGMENT (kit), plus d'enveloppe pointerEvents='none' muette.
      expect(tab.props['disabled']).toBe(true);
      expect(tab.props['accessibilityState']).toMatchObject({ disabled: true });
    }
    // Double verrou : même si un press passait (lecteur d'écran), la garde onChange tient —
    // la sélection ne bouge pas.
    await act(async () => {
      (tabs.get('Devis')!.props['onPress'] as () => void)();
    });
    expect(segmentTabs(renderer).get('Tout')!.props['accessibilityState']).toMatchObject({ selected: true });
    expect(segmentTabs(renderer).get('Devis')!.props['accessibilityState']).toMatchObject({ selected: false });
  });

  it('données servies ⇒ les onglets ne sont PLUS annoncés désactivés (state selected seul)', async () => {
    const renderer = await render();
    for (const tab of segmentTabs(renderer).values()) {
      expect(tab.props['disabled']).toBeUndefined();
      expect(Object.keys(tab.props['accessibilityState'] as object)).toEqual(['selected']);
    }
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
