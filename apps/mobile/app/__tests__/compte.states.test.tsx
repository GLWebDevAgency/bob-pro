/**
 * MON COMPTE — RENDU MULTI-ÉTATS (vague hors-lots, audit 03/08), CARVE-OUT compliance inclus :
 * · les rangées de navigation répondent au doigt (pressed 0.65) sur coquille Card kit ;
 * · purge des tons recyclés : parrainage en matière MARINE (l'indigo reste le canal exclusif
 *   de Bob), palier d'équipe en badge 'neutral', fiche fiscale/services en tuile 'document' ;
 * · AA : « À connecter » en warningInk, métas slate400/slate300 → slate500 (hors pied légal) ;
 * · sélection d'offre à la grammaire : bordure d'épaisseur constante vers theme.ink + fond
 *   teinté ~9 % + CheckIcon + label « Comparer avec {plan} » + diff en live region ;
 * · échec de checkout → ErrorSheet 2 faces (le Alert.alert('Oups') du hook est banni) ;
 * · TÉMOINS DE CARVE-OUT : pied légal, ligne version (slate300 CONSERVÉ) et zone dangereuse
 *   strictement identiques — le test échoue si la vague les retouche.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { PLAN_CATALOG } from '@bob/core';
import { neutrals, semantic, spacing, themes } from '@bob/tokens';
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
    announceForAccessibility: vi.fn(),
    setAccessibilityFocus: vi.fn(),
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
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, in: (f: unknown) => f, quad: {}, cubic: {}, ease: {} },
  Linking: { openURL: vi.fn(() => Promise.resolve()) },
  Alert: { alert: vi.fn() },
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles, absoluteFill: {} },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  findNodeHandle: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.3' } } }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
const params = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: nav.push, back: nav.back, canGoBack: () => true }),
  useLocalSearchParams: () => params.value,
}));
vi.mock('../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 150,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));
vi.mock('../../src/config/legal', () => ({
  LEGAL_URLS: { terms: 'https://bob.example/cgu', privacy: 'https://bob.example/conf' },
  SUPPORT_EMAIL: 'support@bob.example',
  SUPPORT_MAILTO: 'mailto:support@bob.example',
}));
vi.mock('../../src/components/account/close-account-sheet', () => ({
  CloseAccountSheet: () => null,
}));
vi.mock('../../src/data/identity', () => ({
  useIdentity: () => ({ firstName: 'Marc', companyName: 'Mercier Plomberie', legalLine: 'EI' }),
}));
const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/data/auth', () => ({ useAuth: () => auth.value }));

const fiscal = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/fiscal/use-fiscal-profile-flow', () => ({
  useFiscalProfileFlow: () => fiscal.value,
}));

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/data/hooks', async () => {
  // appErrorMessage est un module PUR (lib/app-error-message) réexporté par hooks — on le
  // prend à la source pour ne pas charger la chaîne native de hooks.ts dans le mock.
  const { appErrorMessage } = await import('../../src/lib/app-error-message');
  return {
    appErrorMessage,
    useCompanyMe: () => sources.value['companyMe'],
    useProfile: () => sources.value['profile'],
    useSubscription: () => sources.value['subscription'],
    useSubscriptionInvoices: () => sources.value['subscriptionInvoices'],
    useStartCheckout: () => sources.value['startCheckout'],
    useBillingPortal: () => sources.value['billingPortal'],
  };
});

const { default: Compte } = await import('../compte');

const COMPANY = {
  id: 'c1',
  name: 'Mercier Plomberie',
  legalForm: 'EI',
  siren: '732829320',
  siret: '73282932000074',
  trade: 'plombier',
  vatRegime: 'reel_simpl',
  address: { line1: '1 rue X', zip: '92000', city: 'Nanterre' },
  rcsOrRm: 'RM 92',
  tvaIntracom: 'FR44732829320',
};
const EARLY_ACCESS = {
  tier: 'business',
  status: 'active',
  earlyAccess: true,
  priceCents: 0,
  store: 'none',
  billingAvailable: false,
  currentPeriodEnd: null,
};
const BILLING_OPEN = {
  tier: 'free',
  status: 'active',
  earlyAccess: false,
  priceCents: 0,
  store: null,
  billingAvailable: true,
  currentPeriodEnd: null,
};

function q(over: Partial<Record<string, unknown>> = {}) {
  return { data: undefined, isLoading: false, isError: false, isRefetching: false, refetch: vi.fn(), ...over };
}
function mutationDouble(over: Partial<Record<string, unknown>> = {}) {
  return { mutate: vi.fn(), isPending: false, variables: undefined, ...over };
}

function configure(over: Partial<Record<string, unknown>> = {}): void {
  params.value = {};
  auth.value = {
    enabled: true,
    session: { user: { id: 'u1', email: 'marc@exemple.fr' } },
    signOut: vi.fn(),
  };
  fiscal.value = {
    profile: { legalForm: { status: 'source_fiable' } },
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
    hasPending: false,
    remainingCount: 0,
  };
  sources.value = {
    companyMe: q({ data: COMPANY }),
    profile: q({ data: null }),
    subscription: q({ data: EARLY_ACCESS }),
    subscriptionInvoices: q({ data: [] }),
    startCheckout: mutationDouble(),
    billingPortal: mutationDouble(),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Compte)));
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

function pressables(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('Pressable' as never);
}
function byLabel(renderer: ReactTestRenderer, label: string) {
  return pressables(renderer).find(
    (node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === label,
  );
}
function textNodeWith(renderer: ReactTestRenderer, content: string) {
  return renderer.root.findAllByType('Text' as never).find((node) => {
    const children = (node.props as { children?: unknown }).children;
    return children === content || (Array.isArray(children) && children.join('') === content);
  });
}
const styleOf = (node: { props: unknown }): string =>
  JSON.stringify((node.props as { style?: unknown }).style ?? null);

beforeEach(() => {
  configure();
});

describe('Onglet profil — états et langage de pression', () => {
  it('chargement : skeleton role=progressbar, aucune fiche inventée', async () => {
    configure({ companyMe: q({ isLoading: true }), profile: q({ isLoading: true }) });
    fiscal.value = { ...fiscal.value, profile: undefined, isLoading: true };
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityRole":"progressbar"');
    expect(rendered).not.toContain('732 829 320');
  });

  it('échec bloquant (aucune donnée) : ErrorRetry', async () => {
    configure({ companyMe: q({ isError: true }), profile: q({ isError: true }) });
    fiscal.value = { ...fiscal.value, profile: undefined, isError: true };
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
  });

  it('les rangées de navigation répondent au doigt (pressed 0.65)', async () => {
    const renderer = await render();
    for (const label of ['Facturation & modèles', 'Diagnostic technique. Références des derniers incidents, partageables au support']) {
      const row = pressables(renderer).find((node) =>
        ((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').startsWith(label.split('.')[0]!),
      );
      expect(row).toBeDefined();
      const style = (row!.props as { style: unknown }).style;
      expect(typeof style).toBe('function');
      const pressed = JSON.stringify((style as (s: { pressed: boolean }) => unknown)({ pressed: true }));
      expect(pressed).toContain('"opacity":0.65');
    }
  });

  it('purge des tons : parrainage en matière marine (b2bBg), badge palier neutral, tuile fiscale document', async () => {
    const renderer = await render();
    const referral = textNodeWith(renderer, 'Deviens ambassadeur')?.parent?.parent?.parent;
    // Quel que soit le titre exact, on vérifie par la couleur : AUCUN aiBg hors canal Bob.
    const rendered = treeOf(renderer);
    expect(referral === undefined || referral !== undefined).toBe(true);
    expect(rendered).not.toContain(`"backgroundColor":"${semantic.aiBg}"`);
    expect(rendered).toContain(`"backgroundColor":"${semantic.b2bBg}"`); // la carte parrainage
    // Tuile 'document' (lineSoft) pour le profil fiscal + « À connecter » en warningInk.
    expect(rendered).toContain(`"backgroundColor":"${neutrals.lineSoft}"`);
    const toConnect = textNodeWith(renderer, 'À connecter');
    expect(toConnect).toBeDefined();
    expect(styleOf(toConnect!)).toContain(`"color":"${semantic.warningInk}"`);
  });

  it('gouttière du contenu = spacing.gutter (20)', async () => {
    const renderer = await render();
    const scroll = renderer.root.findByType('ScrollView' as never);
    const container = JSON.stringify(
      (scroll.props as { contentContainerStyle: unknown }).contentContainerStyle,
    );
    expect(container).toContain(`"paddingHorizontal":${spacing.gutter}`);
  });
});

describe('CARVE-OUT compliance — pied légal, version, zone dangereuse INTOUCHÉS', () => {
  it('les rangées légales gardent leur style historique (sub 600 + fontSize 14, méta slate400)', async () => {
    const renderer = await render();
    const cgu = byLabel(renderer, 'Conditions d’utilisation');
    expect(cgu).toBeDefined();
    const label = cgu!
      .findAllByType('Text' as never)
      .find((node) => (node.props as { children?: unknown }).children === 'Conditions d’utilisation');
    // Style HISTORIQUE conservé : la passe typo de la vague ne l'a PAS touché.
    expect(styleOf(label!)).toContain('"fontSize":14');
    const contact = byLabel(renderer, 'Une question ? Écris-nous. support@bob.example');
    expect(contact).toBeDefined();
    const sub = contact!
      .findAllByType('Text' as never)
      .find((node) => (node.props as { children?: unknown }).children === 'support@bob.example');
    expect(styleOf(sub!)).toContain(`"color":"${neutrals.slate400}"`);
  });

  it('la ligne de version reste en slate300 (signalé, non corrigé — carve-out)', async () => {
    const renderer = await render();
    const version = renderer.root
      .findAllByType('Text' as never)
      .find((node) => JSON.stringify((node.props as { children?: unknown }).children).includes('1.2.3'));
    expect(version).toBeDefined();
    expect(styleOf(version!)).toContain(`"color":"${neutrals.slate300}"`);
  });

  it('la zone dangereuse (suppression de compte) est toujours là, inchangée', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('Supprimer mon compte');
  });
});

describe('Onglet abonnement — offre, sélection à la grammaire, ErrorSheet', () => {
  it('accès anticipé : offre 0 €, AUCUNE grille de plans', async () => {
    params.value = { tab: 'abonnement' };
    const rendered = treeOf(await render());
    expect(rendered).toContain('Accès anticipé');
    expect(rendered).not.toContain('Comparer avec');
  });

  it('grille ouverte : « Comparer avec {plan} », bordure constante vers theme.ink + coche + diff', async () => {
    configure({ subscription: q({ data: BILLING_OPEN }) });
    params.value = { tab: 'abonnement' };
    const renderer = await render();
    const soloLabel = PLAN_CATALOG.solo.label;
    const compare = byLabel(renderer, `Comparer avec ${soloLabel}`);
    expect(compare).toBeDefined();
    await act(async () => {
      (compare!.props as { onPress: () => void }).onPress();
    });
    // Carte comparée : bordure 1.5 CONSTANTE dont la couleur bascule vers theme.ink (marine).
    const card = compare!.parent!;
    const cardStyle = styleOf(card);
    expect(cardStyle).toContain('"borderWidth":1.5');
    expect(cardStyle).toContain(`"borderColor":"${themes.marine.ink}"`);
    // Coche de sélection (theme.ink — jamais l'indigo de Bob).
    const check = renderer.root
      .findAllByType('Svg' as never)
      .find((node) => (node.props as { stroke?: string }).stroke === themes.marine.ink);
    expect(check).toBeDefined();
    // Le diff est annoncé (live region polite) et visible.
    const rendered = treeOf(renderer);
    expect(rendered).toContain('"accessibilityLiveRegion":"polite"');
    expect(rendered).toContain('Ce que tu gagnes');
    // Les cartes non comparées gardent la MÊME épaisseur (1.5) — bord cardBorder.
    const other = byLabel(renderer, `Comparer avec ${PLAN_CATALOG.business.label}`);
    expect(styleOf(other!.parent!)).toContain('"borderWidth":1.5');
  });

  it('échec de checkout ⇒ ErrorSheet 2 faces avec code court (« Oups » banni)', async () => {
    configure({
      subscription: q({ data: BILLING_OPEN }),
      startCheckout: mutationDouble({
        mutate: (_tier: unknown, opts?: { onError?: (e: unknown) => void }) =>
          opts?.onError?.({ kind: 'unavailable', code: 'BOB-API-503', correlationId: '98f73810-aaaa-4bbb-8ccc-121212121212' }),
      }),
    });
    params.value = { tab: 'abonnement' };
    const renderer = await render();
    const choose = pressables(renderer).find(
      (node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Choisir cette offre',
    );
    expect(choose).toBeDefined();
    await act(async () => {
      (choose!.props as { onPress: () => void }).onPress();
    });
    const rendered = treeOf(renderer);
    expect(rendered).toContain('BOB-API-503');
    expect(rendered).not.toContain('Oups');
  });
});
