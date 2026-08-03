/**
 * RECHERCHE GLOBALE — RENDU MULTI-ÉTATS (Lot 5) :
 * · papa vocal : la rangée de PIÈCE s'annonce en une phrase « FA-2026-012, Mairie de
 *   Lyon, 1 250,00 € » (titre + meta + MONTANT) — un résultat se comprend à l'oreille ;
 * · la tuile documents est NEUTRE (documentTile #F1F4F7) — le vert reste à l'argent,
 *   l'intérim b2g est refusé ;
 * · SearchField kit : bouton clear à cible 44 pt, libellé i18n, effacement effectif ;
 * · rangée retour kit 44 pt ; états hint / noResults / échec / chargement.
 * searchGlobal est RÉEL (@bob/core) — zéro résultat fabriqué.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { formatEUR } from '@bob/core';
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
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, in: (f: unknown) => f, quad: {}, cubic: {}, ease: {} },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles, absoluteFill: {} },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
const params = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: nav.push, back: nav.back, canGoBack: () => true }),
  useLocalSearchParams: () => params.value,
}));
vi.mock('../../src/agent', () => ({ usePublishAgentContext: vi.fn() }));
vi.mock('../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 150,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/data/documents', () => ({ useDocuments: () => sources.value['documents'] }));
vi.mock('../../src/data/hooks', () => ({
  useCustomers: () => sources.value['customers'],
  useInvoices: () => sources.value['invoices'],
  useQuotes: () => sources.value['quotes'],
}));

const { default: Recherche } = await import('../recherche');

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

const MAIRIE = {
  id: 'c1',
  name: 'Mairie de Lyon',
  type: 'b2g',
  siren: null,
  outstandingCents: 0,
};
const INVOICE = {
  id: 'i1',
  number: 'FA-2026-012',
  customerId: 'c1',
  kind: 'final',
  status: 'issued',
  totals: { ht: 104_167, tva: 20_833, ttc: 125_000, netToPay: 125_000 },
  paid: 0,
  dueAt: null,
  parentQuoteId: null,
};
const DOCUMENT = {
  id: 'd1',
  filename: 'mairie-attestation.pdf',
  kind: 'other',
  documentDate: null,
  createdAt: '2026-01-15T10:00:00.000Z',
  linkedEntityId: null,
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  params.value = { q: 'mairie' };
  sources.value = {
    customers: q({ data: [MAIRIE] }),
    invoices: q({ data: [INVOICE] }),
    quotes: q({ data: [] }),
    documents: q({ data: [DOCUMENT] }),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Recherche)));
  });
  return renderer;
}
const TEST_JSON = Symbol.for('react.test.json');
/** Les éléments React embarqués (refreshControl) sont opaques — jamais sérialisés. */
const treeOf = (renderer: ReactTestRenderer): string =>
  JSON.stringify(renderer.toJSON(), (_key, value: unknown) => {
    if (value === null || typeof value !== 'object') return value;
    const tagged = value as { $$typeof?: symbol };
    if (tagged.$$typeof !== undefined && tagged.$$typeof !== TEST_JSON) return '[react-element]';
    return value;
  });

function findByLabel(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('Pressable' as never)
    .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === label);
}

beforeEach(() => {
  configure();
});

describe('Papa vocal — le résultat se comprend à l’oreille', () => {
  it('la rangée de pièce annonce « FA-2026-012, Mairie de Lyon, 1 250,00 € » (montant inclus)', async () => {
    const renderer = await render();
    const expected = `FA-2026-012, Mairie de Lyon, ${formatEUR(125_000)}`;
    const row = findByLabel(renderer, expected);
    expect(row).toBeDefined();
  });
});

describe('Tuile documents — neutre, le vert reste à l’argent', () => {
  it('IconTile tone document (#F1F4F7), aucune tuile success dans les résultats', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('"backgroundColor":"#F1F4F7"'); // documentTile.bg
    expect(rendered).not.toContain('"backgroundColor":"#EAF2EC"'); // plus de success recyclé
  });

  it('la tuile de PIÈCE est elle aussi neutre (papier) — le b2b recyclé est éteint', async () => {
    const rendered = treeOf(await render());
    // Deux tuiles de contenu neutres : la pièce ET le document (verdict Lot 5 P3).
    const neutralTiles = rendered.split('"backgroundColor":"#F1F4F7"').length - 1;
    expect(neutralTiles).toBeGreaterThanOrEqual(2);
    // Aucun b2bBg dans ces résultats : la cliente est b2g, la pièce n'emprunte plus b2b.
    expect(rendered).not.toContain('"backgroundColor":"#E6EDF6"');
  });
});

describe('SearchField kit — clear 44 pt, effacement effectif', () => {
  it('le bouton « Effacer la recherche » existe et vide la requête (retour au hint)', async () => {
    const renderer = await render();
    const clear = findByLabel(renderer, 'Effacer la recherche');
    expect(clear).toBeDefined();
    await act(async () => {
      (clear!.props as { onPress: () => void }).onPress();
    });
    const rendered = treeOf(renderer);
    expect(rendered).not.toContain('FA-2026-012');
    expect(rendered).toContain('je ramène tout ce qui colle'); // search.hint (pote)
  });
});

describe('États de premier rang', () => {
  it('échec de chargement ⇒ « Réessayer », aucun résultat fantôme', async () => {
    configure({ customers: q({ isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('FA-2026-012');
  });

  it('chargement pendant une recherche ⇒ squelettes, aucun résultat', async () => {
    configure({ customers: q({ isLoading: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityElementsHidden":true');
    expect(rendered).not.toContain('Mairie de Lyon');
  });

  it('aucun résultat ⇒ voix de Bob avec la requête citée', async () => {
    params.value = { q: 'zzzintrouvable' };
    const rendered = treeOf(await render());
    expect(rendered).toContain('zzzintrouvable');
  });
});

describe('Rangée retour kit — cible 44 pt', () => {
  it('le retour « Fermer » est un StickyBackRow à minHeight 44', async () => {
    const renderer = await render();
    const back = findByLabel(renderer, 'Fermer');
    expect(back).toBeDefined();
    const style = (back!.props as { style: unknown }).style;
    const resolved = JSON.stringify(typeof style === 'function' ? style({ pressed: false }) : style);
    expect(resolved).toContain('"minHeight":44');
  });
});
