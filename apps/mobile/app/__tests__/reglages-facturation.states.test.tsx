/**
 * RÉGLAGES FACTURATION — RENDU MULTI-ÉTATS (vague hors-lots, audit 03/08) :
 * · LE bug le plus lourd de la vague : un échec de MUTATION des préférences ne remplace PLUS
 *   l'écran entier par un ErrorRetry plein écran — données en cache rendues, ErrorSheet 2 faces ;
 * · blocking vs stale : bloquant SEULEMENT si une source est SANS données ; le spinner de
 *   retry couvre désormais aussi la source prefs (billingPrefs.isRefetching) ;
 * · AA : bandeau bloquant (titre + CTA) et valeurs « À compléter » en warningInk (5,25:1),
 *   paymentTermsRequired idem, aide TVA en successInk, notes slate300→slate500 ;
 * · PATCH du régime TVA raté → ErrorSheet (code + corrélation), plus jamais Alert.alert ;
 * · swatches PDF : labels VoiceOver i18n (« Marine »...) + anneau d'épaisseur CONSTANTE ;
 * · Eyebrow kit pour le titre des mentions ; gouttière spacing.gutter (20).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { neutrals, semantic, spacing } from '@bob/tokens';
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
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles, absoluteFill: {} },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  findNodeHandle: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: nav.push, back: nav.back, canGoBack: () => true }),
}));
vi.mock('../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 150,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));
vi.mock('../../src/components/billing/iban-edit-sheet', () => ({ IbanEditSheet: () => null }));
vi.mock('../../src/components/billing/legal-identity-edit-sheet', () => ({
  LegalIdentityEditSheet: () => null,
}));

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/data/hooks', () => ({
  useCompanyMe: () => sources.value['company'],
  useInvoices: () => sources.value['invoices'],
  useUpdateCompanyProfile: () => sources.value['updateProfile'],
  useCompanyBillingSettings: () => sources.value['billingQuery'],
  useUpdateCompanyBillingSettings: () => sources.value['billingMutation'],
}));

const { default: ReglagesFacturation } = await import('../reglages-facturation');

/** Fiche complète (assertCanIssue OK) — même fixture que company.test.ts du core. */
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
  iban: 'FR7630006000011234567890189',
  bic: 'AGRIFRPP',
  decennale: { insurer: 'AXA', policyNo: 'P-123' },
};
const PREFS = {
  revision: 4,
  showRibOnInvoices: true,
  showInsuranceOnInvoices: true,
  defaultQuoteValidityDays: 30,
  defaultDepositPercent: 30,
  defaultInvoicePaymentTermsDays: 30,
  pdfAccentColor: 'navy',
  relanceAutoEnabled: true,
  relancePolicy: null,
};
const INVOICE = {
  id: 'i1',
  number: 'F-2026-0118',
  customerId: 'c9',
  kind: 'final',
  status: 'issued',
  totals: { ht: 100_000, tva: 20_000, ttc: 120_000, netToPay: 120_000 },
  paid: 0,
  dueAt: null,
  parentQuoteId: null,
  mentions: ['TVA sur les encaissements.'],
};

function q(over: Partial<Record<string, unknown>> = {}) {
  return { data: undefined, isLoading: false, isError: false, isRefetching: false, refetch: vi.fn(), ...over };
}
function mutationDouble(over: Partial<Record<string, unknown>> = {}) {
  return { mutate: vi.fn(), isPending: false, isError: false, reset: vi.fn(), ...over };
}

function configure(over: Partial<Record<string, unknown>> = {}): void {
  sources.value = {
    company: q({ data: COMPANY }),
    invoices: q({ data: [INVOICE] }),
    updateProfile: mutationDouble(),
    billingQuery: q({ data: PREFS, isSuccess: true }),
    billingMutation: mutationDouble(),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(ReglagesFacturation)));
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

describe('Blocking vs stale — LE bug de la vague', () => {
  it('un échec de MUTATION des préférences ne détruit PLUS l’écran (données rendues)', async () => {
    configure({ billingMutation: mutationDouble({ isError: true }) });
    const rendered = treeOf(await render());
    // Avant : mutation.isError → failed → ErrorRetry plein écran. Désormais : contenu intact.
    expect(rendered).toContain('Mercier Plomberie');
    expect(rendered).toContain('F-2026-0118');
    expect(rendered).not.toContain('Réessayer');
  });

  it('échec de LECTURE sans aucune donnée ⇒ bloquant (ErrorRetry seul)', async () => {
    configure({ billingQuery: q({ isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('Mercier Plomberie');
  });

  it('échec de refetch AVEC données en cache ⇒ bannière stale + contenu conservé', async () => {
    configure({ company: q({ data: COMPANY, isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer'); // la bannière
    expect(rendered).toContain('Mercier Plomberie'); // ET le contenu
  });

  it('le spinner de retry couvre AUSSI la source prefs (isRefetching)', async () => {
    configure({ billingQuery: q({ isError: true, isRefetching: true }) });
    const renderer = await render();
    // Bouton « Réessayer » en loading ⇒ ActivityIndicator rendu (couvert par prefs seul).
    expect(renderer.root.findAllByType('ActivityIndicator' as never).length).toBeGreaterThan(0);
  });

  it('chargement initial : squelettes, aucun contenu inventé', async () => {
    configure({ billingQuery: q({ isLoading: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityElementsHidden":true');
    expect(rendered).not.toContain('Mercier Plomberie');
  });
});

describe('Grammaire d’erreur — ErrorSheet sur les mutations', () => {
  it('PATCH du régime TVA raté ⇒ ErrorSheet avec code court (plus d’Alert.alert)', async () => {
    configure({
      updateProfile: mutationDouble({
        mutate: (_vars: unknown, opts: { onError: (e: unknown) => void }) =>
          opts.onError({ kind: 'conflict', code: 'BOB-API-409', correlationId: '98f73810-aaaa-4bbb-8ccc-121212121212' }),
      }),
    });
    const renderer = await render();
    // SegmentedControl : bascule vers « Franchise » (l'option non active).
    const franchise = renderer.root
      .findAllByType('Pressable' as never)
      .find((node) =>
        ((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').includes('Franchise'),
      );
    expect(franchise).toBeDefined();
    await act(async () => {
      (franchise!.props as { onPress: () => void }).onPress();
    });
    const rendered = treeOf(renderer);
    expect(rendered).toContain('BOB-API-409');
    expect(rendered).toContain('Je n’ai pas pu enregistrer ce réglage.'); // reglages.saveError (pote)
  });

  it('échec d’écriture d’une préférence ⇒ ErrorSheet via la façade update(patch, onError)', async () => {
    configure({
      billingMutation: mutationDouble({
        mutate: (_vars: unknown, opts?: { onError?: (e: unknown) => void }) =>
          opts?.onError?.({ kind: 'conflict', code: 'BOB-API-409' }),
      }),
    });
    const renderer = await render();
    const swatch = renderer.root
      .findAllByType('Pressable' as never)
      .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Vert');
    expect(swatch).toBeDefined();
    await act(async () => {
      (swatch!.props as { onPress: () => void }).onPress();
    });
    expect(treeOf(renderer)).toContain('BOB-API-409');
  });
});

describe('Encres AA — warningInk là où l’ambre nu échouait', () => {
  it('bandeau bloquant : titre et CTA en warningInk (fond warningBg conservé)', async () => {
    configure({ company: q({ data: { ...COMPANY, rcsOrRm: null } }) });
    const renderer = await render();
    const title = textNodeWith(renderer, 'Il te manque une info pour facturer');
    expect(title).toBeDefined();
    expect(styleOf(title!)).toContain(`"color":"${semantic.warningInk}"`);
    const value = textNodeWith(renderer, 'À compléter');
    expect(value).toBeDefined();
    expect(styleOf(value!)).toContain(`"color":"${semantic.warningInk}"`);
  });

  it('paymentTermsRequired en warningInk quand aucun délai n’est choisi', async () => {
    configure({
      billingQuery: q({ data: { ...PREFS, defaultInvoicePaymentTermsDays: null }, isSuccess: true }),
    });
    const renderer = await render();
    const line = textNodeWith(
      renderer,
      'Choisis ce délai avant d’émettre ta prochaine facture — je ne vais pas en inventer un.',
    );
    expect(line).toBeDefined();
    expect(styleOf(line!)).toContain(`"color":"${semantic.warningInk}"`);
  });

  it('l’aide TVA est en successInk (le vert nu frôlait l’AA) et l’icône est maison', async () => {
    const renderer = await render();
    const helps = renderer.root
      .findAllByType('Text' as never)
      .filter((node) => styleOf(node).includes(`"color":"${semantic.successInk}"`));
    expect(helps.length).toBeGreaterThan(0);
  });
});

describe('Swatches PDF — VoiceOver i18n et anneau constant', () => {
  it('labels i18n « Marine »/« Vert »/« Violet »/« Orange » (plus de clés anglaises)', async () => {
    const renderer = await render();
    for (const label of ['Marine', 'Vert', 'Violet', 'Orange']) {
      const swatch = renderer.root
        .findAllByType('Pressable' as never)
        .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === label);
      expect(swatch).toBeDefined();
    }
  });

  it('anneau d’épaisseur CONSTANTE : 3 px partout, seule la couleur bascule', async () => {
    const renderer = await render();
    const selected = renderer.root
      .findAllByType('Pressable' as never)
      .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Marine');
    const unselected = renderer.root
      .findAllByType('Pressable' as never)
      .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Vert');
    expect(styleOf(selected!)).toContain('"borderWidth":3');
    expect(styleOf(selected!)).toContain(`"borderColor":"${neutrals.ink900}"`);
    expect(styleOf(unselected!)).toContain('"borderWidth":3');
    expect(styleOf(unselected!)).toContain('"borderColor":"transparent"');
  });
});

describe('Canon — Eyebrow kit, gouttière, notes lisibles', () => {
  it('le titre des mentions est un Eyebrow kit (uppercase par style, cran 12/700)', async () => {
    const renderer = await render();
    const eyebrow = textNodeWith(renderer, 'Sur ta dernière facture');
    expect(eyebrow).toBeDefined();
    expect(styleOf(eyebrow!)).toContain('"textTransform":"uppercase"');
  });

  it('gouttière du contenu = spacing.gutter (20) et plus aucune note slate300', async () => {
    const renderer = await render();
    const scroll = renderer.root.findByType('ScrollView' as never);
    const container = JSON.stringify(
      (scroll.props as { contentContainerStyle: unknown }).contentContainerStyle,
    );
    expect(container).toContain(`"paddingHorizontal":${spacing.gutter}`);
    // Les notes de bas de carte ne portent plus l'encre décorative slate300 (2,1:1).
    const notes = renderer.root
      .findAllByType('Text' as never)
      .filter((node) => styleOf(node).includes(`"color":"${neutrals.slate300}"`));
    expect(notes).toHaveLength(0);
  });
});
