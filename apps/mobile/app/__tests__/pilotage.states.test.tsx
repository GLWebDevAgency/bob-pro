/**
 * PILOTAGE — RENDU MULTI-ÉTATS (Lot 5) + PLANCHE « MATIÈRE ARGENT » EXÉCUTABLE :
 * · le héros « Mois en cours » porte la matière monthReady (#F0F7F3→#FBFEFC) avec
 *   l'ENCAISSÉ en MoneyText moneyHero (27/800) teinté success #0E7C5A ;
 * · TrendBars : préférence motion JAMAIS résolUE ⇒ barres STATIQUES à n% dès la première
 *   frame (littéral "width":"100%" de la part du top client), zéro Animated.timing ;
 * · l'alerte de concentration dit « Risque » en toutes lettres (annoncé par VoiceOver),
 *   plus jamais un « ! » muet ;
 * · Text nus → EmptyState (voix de Bob) ; rangée retour kit ≥ 44 pt ;
 * · états : chargement (busy), échec réseau (Réessayer), données réelles.
 * Fixtures RELATIVES à l'horloge réelle (deriveBusinessReview reçoit todayLocal()) —
 * AUCUNE date littérale figée.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { formatEUR } from '@bob/core';
import { ThemeProvider } from '@bob/ui';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FakeAnimatedValue, timingSpy } = vi.hoisted(() => {
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
  return { FakeAnimatedValue, timingSpy: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    isScreenReaderEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
    announceForAccessibility: vi.fn(),
  },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: timingSpy,
    loop: () => ({ start: vi.fn(), stop: vi.fn() }),
    sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, in: (f: unknown) => f, quad: {}, cubic: {}, ease: {} },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles, absoluteFill: {} },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle',
  Defs: 'Defs',
  LinearGradient: 'SvgLinearGradient',
  Path: 'Path',
  RadialGradient: 'RadialGradient',
  Rect: 'Rect',
  Stop: 'Stop',
}));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: nav.push, back: nav.back, canGoBack: () => true }),
}));
vi.mock('../../src/agent', () => ({ usePublishAgentContext: vi.fn() }));
vi.mock('../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 150,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));

const sources = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  entitlement: {
    value: { allowed: true, verified: true, loading: false, decision: null } as unknown,
  },
}));
vi.mock('../../src/monetization/paywall', () => ({
  PaywallCard: () => null,
  useEntitlement: () => sources.entitlement.value,
}));
vi.mock('../../src/data/hooks', () => ({
  useAccountingEntries: () => sources.value['entries'],
  usePayments: () => sources.value['payments'],
  useInvoices: () => sources.value['invoices'],
  useCustomers: () => sources.value['customers'],
  useExpenses: () => sources.value['expenses'],
  useCompany: () => sources.value['company'],
}));

const { default: Pilotage } = await import('../pilotage');

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

// ── Fixtures RELATIVES au présent (deriveBusinessReview lit l'horloge réelle) ──────────
const pad2 = (n: number): string => String(n).padStart(2, '0');
const isoOf = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const NOW = new Date();
const TODAY = isoOf(NOW);
const PREV_MONTH_15 = isoOf(new Date(NOW.getFullYear(), NOW.getMonth() - 1, 15));

/** Écriture de vente : CA 70x au crédit (le facturé de la revue vient des ÉCRITURES). */
const saleEntry = (entryDate: string, revenueCents: number) => ({
  entryDate,
  sourceType: 'invoice',
  lines: [
    { account: '411', debitCents: revenueCents, creditCents: 0 },
    { account: '706', debitCents: 0, creditCents: revenueCents },
  ],
});

function configure(over: Partial<Record<string, unknown>> = {}): void {
  sources.entitlement.value = { allowed: true, verified: true, loading: false, decision: null };
  sources.value = {
    entries: q({ data: [saleEntry(TODAY, 500_000), saleEntry(PREV_MONTH_15, 300_000)] }),
    payments: q({ data: [{ amountCents: 240_000, receivedAt: TODAY }] }),
    invoices: q({
      data: [
        {
          id: 'i1',
          number: 'F-2026-100',
          kind: 'final',
          status: 'paid',
          totals: { ht: 500_000, tva: 100_000, ttc: 600_000, netToPay: 600_000 },
          paid: 600_000,
          dueAt: TODAY,
          customerId: 'c1',
        },
      ],
    }),
    customers: q({ data: [{ id: 'c1', name: 'SARL Martin' }] }),
    expenses: q({
      data: [
        { category: 'materiel', totalTtcCents: 90_000, vatCents: 15_000, documentDate: TODAY, status: 'paid' },
      ],
    }),
    company: q({ data: { vatRegime: 'reel_normal' } }),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Pilotage)));
  });
  return renderer;
}

const treeOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

beforeEach(() => {
  timingSpy.mockClear();
  configure();
});

describe('PLANCHE « matière argent » — le héros Mois en cours', () => {
  it('matière monthReady (#F0F7F3 → #FBFEFC) + encaissé en moneyHero 27/800 teinté success', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('"#F0F7F3"'); // vault.monthReadyTop
    expect(rendered).toContain('"#FBFEFC"'); // vault.monthReadyBottom
    expect(rendered).toContain('"fontSize":27'); // cran moneyHero (Lot 0)
    expect(rendered).toContain('"color":"#0E7C5A"'); // l'encaissé : LA bonne nouvelle, en success
    // Le montant encaissé du mois, au format canonique du core (espace fine insécable).
    expect(rendered).toContain(JSON.stringify(formatEUR(240_000)).slice(1, -1));
  });
});

describe('TrendBars — dataviz honnête, fail-closed', () => {
  it('préférence motion JAMAIS résolue ⇒ barres statiques (part top client à "100%"), zéro timing', async () => {
    const rendered = treeOf(await render());
    // La part du client unique (100 % du CA 12 mois) — barre pleine, dès la première frame.
    expect(rendered).toContain('"width":"100%"');
    expect(timingSpy).not.toHaveBeenCalled();
  });
});

describe('Alerte de concentration — « Risque » en toutes lettres', () => {
  it('badge textuel « Risque » présent (annoncé par VoiceOver), plus de « ! » muet', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('Risque');
    expect(rendered).not.toContain('"children":"!"');
    // Le nom du client dominant est cité dans la phrase pédagogique.
    expect(rendered).toContain('SARL Martin');
  });
});

/** Aplati un style RN (objet ou tableau imbriqué) — le DERNIER gagne, comme au runtime. */
type FlatStyle = Record<string, unknown>;
function flatStyle(style: unknown): FlatStyle {
  if (Array.isArray(style)) {
    return style.reduce<FlatStyle>((acc, entry) => ({ ...acc, ...flatStyle(entry) }), {});
  }
  return style !== null && typeof style === 'object' ? { ...(style as FlatStyle) } : {};
}

describe('HONNÊTETÉ DES NULL TYPÉS — le cœur de la doctrine du derive (verdict Lot 5, P1 n°4)', () => {
  it('DSO null (< 3 mois d’historique) ⇒ le message explicatif, JAMAIS un nombre fabriqué', async () => {
    // Fixtures par défaut : 2 mois d'écritures ⇒ dso.days === null, reason insufficient_history.
    const rendered = treeOf(await render());
    // La branche null est la SEULE réponse à l'absence (tue le mutant N3 : branche neutralisée
    // ⇒ « null jours » String(null) affiché à l'artisan).
    expect(rendered).toContain('Il me faut 3 mois de facturation pour mesurer ça — on y est presque.');
    expect(rendered).not.toContain('null jours');
    expect(rendered).not.toContain('"children":"null"');
  });

  it('taux d’encaissement null ⇒ le message explicatif, JAMAIS un « 0 % encaissé » fabriqué', async () => {
    const rendered = treeOf(await render());
    // Tue le mutant N4 : branche null neutralisée ⇒ Math.round(null/100) = « 0 % encaissé »
    // teinté danger — un chiffre FAUX présenté comme mesuré.
    expect(rendered).toContain(
      'Il me faut 3 mois de facturation pour un taux honnête — encore un peu de patience.',
    );
    expect(rendered).not.toContain('0 % encaissé');
  });

  it('part client null (base ≤ 0) ⇒ AUCUNE barre fantôme dans la rangée du client — scopé au nœud', async () => {
    // Avoir net c2 (700 €) > CA c1 (600 €) ⇒ clientsTotal ≤ 0 ⇒ shareBps null pour c1.
    configure({
      customers: q({ data: [{ id: 'c1', name: 'SARL Martin' }, { id: 'c2', name: 'SCI Nord' }] }),
      invoices: q({
        data: [
          {
            id: 'i1',
            number: 'F-2026-100',
            kind: 'final',
            status: 'paid',
            totals: { ht: 500_000, tva: 100_000, ttc: 600_000, netToPay: 600_000 },
            paid: 600_000,
            dueAt: TODAY,
            customerId: 'c1',
          },
          {
            id: 'a1',
            number: 'A-2026-001',
            kind: 'credit_note',
            status: 'paid',
            totals: { ht: 583_334, tva: 116_666, ttc: 700_000, netToPay: 700_000 },
            paid: 0,
            dueAt: TODAY,
            customerId: 'c2',
          },
        ],
      }),
    });
    const renderer = await render();
    const row = renderer.root
      .findAll(
        (node) =>
          ((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').startsWith(
            '1. SARL Martin',
          ),
        { deep: true },
      )
      .at(0);
    expect(row).toBeDefined();
    // Tue le mutant N5 : `(line.shareBps ?? 0) / 100` peindrait ici une barre à « 0% » —
    // la rangée d'un client SANS part mesurable ne contient AUCUNE largeur de barre.
    const widths = row!
      .findAllByType('View' as never)
      .map((view) => flatStyle((view.props as { style?: unknown }).style)['width'])
      .filter((width) => width !== undefined);
    expect(widths).toEqual([]);
    // Et aucun « % » de méta fabriqué dans la rangée.
    const metaTexts = row!
      .findAllByType('Text' as never)
      .map((text) => (text.props as { children?: unknown }).children)
      .filter((children): children is string => typeof children === 'string');
    expect(metaTexts.some((children) => children.includes('%'))).toBe(false);
  });
});

describe('États de premier rang', () => {
  it('aucune donnée (couverture nulle) ⇒ EmptyState voix de Bob, jamais un zéro fabriqué', async () => {
    configure({
      entries: q({ data: [] }),
      payments: q({ data: [] }),
      invoices: q({ data: [] }),
      customers: q({ data: [] }),
      expenses: q({ data: [] }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Pas encore de mouvement');
  });

  it('échec réseau ⇒ « Réessayer » — jamais un cabinet vide', async () => {
    configure({ entries: q({ isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('"#F0F7F3"'); // aucun héros sur des données absentes
  });

  it('chargement ⇒ squelettes (décor masqué aux lecteurs), aucun montant ni héros', async () => {
    configure({ entries: q({ isLoading: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityElementsHidden":true'); // Skeleton kit
    expect(rendered).not.toContain(JSON.stringify(formatEUR(240_000)).slice(1, -1));
    expect(rendered).not.toContain('"#F0F7F3"');
  });
});

describe('Rangée retour kit — cible 44 pt', () => {
  it('le retour « Argent » est un StickyBackRow à minHeight 44 (était 34 ad hoc)', async () => {
    const renderer = await render();
    const back = renderer.root
      .findAllByType('Pressable' as never)
      .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Argent');
    expect(back).toBeDefined();
    const style = (back!.props as { style: unknown }).style;
    const resolved = JSON.stringify(typeof style === 'function' ? style({ pressed: false }) : style);
    expect(resolved).toContain('"minHeight":44');
  });
});
