/**
 * FACTURE/[id] — RENDU MULTI-ÉTATS (critères de preuve Lot 3, plan DA 01/08).
 *
 * Ce que ce fichier verrouille :
 *  · « Émise mais jamais transmise » est LE risque cash : StatusStrip AMBRE en TÊTE de
 *    colonne extra (avant l'échéance et tout le reste) — pastel #FBF0DF + encre AA #8A5A12 ;
 *  · dueLine → StatusStrip NEUTRE ; « envoyée le » → StatusStrip SUCCESS (encre #0E5C44) ;
 *  · relance « en attente » → badge NEUTRE (le b2b mentait sur la nature du fait) ;
 *  · feuille période : DateField kit à label VISIBLE persistant (plus un placeholder seul) ;
 *  · états : chargement / erreur réseau (retry + fermer) / introuvable.
 * Préférences motion/transparence NON RÉSOLUES pendant tout le fichier (fail-closed kit).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { ThemeProvider } from '@bob/ui';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FakeAnimatedValue, alertSpy } = vi.hoisted(() => {
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
  return { FakeAnimatedValue, alertSpy: vi.fn() };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: alertSpy },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }) }),
    loop: () => ({ start: vi.fn(), stop: vi.fn() }),
    sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, quad: {}, cubic: {} },
  Linking: { openURL: vi.fn() },
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o['ios'] ?? o['default'] },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Share: { share: vi.fn() },
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

const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => nav,
  useLocalSearchParams: () => ({ id: 'i1' }),
}));

vi.mock('../../../src/agent', () => ({ usePublishAgentContext: vi.fn() }));
vi.mock('../../../src/lib/share-document', () => ({ shareDocument: vi.fn() }));
vi.mock('../../../src/components/AccountingLinesView', () => ({ AccountingLinesView: () => null }));
vi.mock('../../../src/components/PurchaseOrderSection', () => ({
  PurchaseOrderCard: () => null,
  PurchaseOrderSheet: () => null,
}));
vi.mock('../../../src/components/DocumentActions', () => ({
  InvoiceActions: () => null,
  canCreateCreditNote: () => false,
  hasInvoiceActions: () => false,
  isCollectible: () => false,
}));
// PieceDetailView : doublure de RENDU qui expose `extra` — l'ordre de la colonne est LE sujet.
vi.mock('../../../src/components/PieceDetailView', async () => {
  const react = await import('react');
  return {
    PieceDetailView: ({ extra, actions }: { extra?: unknown; actions?: unknown }) =>
      react.createElement('PieceDetailView', null, extra as never, actions as never),
  };
});
vi.mock('../../../src/components/ConfirmSheet', () => ({
  useConfirm: () => () => Promise.resolve(true),
}));

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../../src/data/documents', () => ({
  useDocuments: () => sources.value['documents'],
}));
vi.mock('../../../src/data/client', () => ({
  useBobClient: () => ({ documentDownloadUrl: vi.fn(), getMaintenanceContract: undefined }),
}));

const { default: FactureDetail } = await import('../[id]');

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

const MARTIN = {
  id: 'c-martin',
  name: 'SARL Martin Rénovation',
  type: 'b2b',
  siren: '821503646',
  paymentTerms: null,
};
const LINE = { id: 'l1', label: 'Pose PAC', category: 'labor', qty: 1, unitPriceHT: 135667, vatRate: 20 };
/** Facture ÉMISE canal email, JAMAIS transmise (faits transportés, aucun envoi constaté). */
const NEVER_TRANSMITTED = {
  id: 'i1',
  kind: 'final',
  status: 'issued',
  number: 'F-2026-118',
  parentQuoteId: null,
  totals: { ht: 135667, vatByRate: { '20': 27133 }, vat: 27133, ttc: 162800, netToPay: 162800 },
  paid: 0,
  mentions: [],
  dueAt: '2026-07-15',
  lines: [LINE],
  customerId: 'c-martin',
  revision: 1,
  purchaseOrder: null,
  maintenanceContractId: null,
  servicePeriod: null,
  emailDeliveredAt: null,
  transmission: null,
  transmissionGuide: { channel: 'email' },
  creditNoteSource: null,
  issuedAt: '2026-07-01',
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  alertSpy.mockClear();
  sources.value = {
    invoice: q({ data: NEVER_TRANSMITTED }),
    invoices: q({ data: [NEVER_TRANSMITTED] }),
    quotes: q({ data: [] }),
    customers: q({ data: [MARTIN] }),
    documents: q({ data: [] }),
    feedItems: [],
    acct: { isLoading: false, isError: false, data: { available: false, reason: '—' }, refetch: vi.fn(), isRefetching: false },
    ...over,
  };
}

vi.mock('../../../src/data/hooks', () => {
  return {
    appErrorMessage: (e: unknown) => `msg:${(e as Error).message}`,
    useInvoice: () => sources.value['invoice'],
    useInvoices: () => sources.value['invoices'],
    useQuotes: () => sources.value['quotes'],
    useCustomers: () => sources.value['customers'],
    useCreateInvoiceViewLink: () => ({ mutateAsync: vi.fn() }),
    useInvoicePaymentLink: () => ({ mutateAsync: vi.fn(), isPending: false, mutate: vi.fn() }),
    useGenerateInvoice: () => ({ isPending: false, mutate: vi.fn() }),
    useInvoiceAccountingPreview: () => sources.value['acct'],
    useMaintenanceContract: () => ({ data: undefined }),
    useNotificationsFeed: () => ({ items: sources.value['feedItems'] ?? [] }),
    useRecordInvoiceTransmission: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useUpdateInvoiceServicePeriod: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useAttachInvoicePurchaseOrder: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useDetachInvoicePurchaseOrder: () => ({ mutateAsync: vi.fn() }),
  };
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(FactureDetail)));
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

// ── Leçon transverse du verdict (PR #61) : les assertions de COULEUR se scopent AU NŒUD.
//    Ici en particulier : le b2b #1B3A63 vit LÉGITIMEMENT ailleurs dans l'écran (badge de
//    canal, encres) — un not.toContain global rougirait du code NON muté. ──
type StyleEntry = Record<string, unknown> | null | undefined | false | readonly StyleEntry[];
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
  props: Record<string, unknown> & { style?: unknown };
  parent: NodeLike | null;
}
/** Le Text d'un StatusBadge (label exact) ET son conteneur (radius 6 du kit) — scopé au nœud. */
function statusBadgeOf(renderer: ReactTestRenderer, label: string): { text: NodeLike; frame: NodeLike } {
  const text = (renderer.root.findAllByType('Text' as never) as unknown as NodeLike[]).find((n) => {
    if ((n.props as { children?: unknown }).children !== label) return false;
    return flattenStyle((n.parent?.props.style ?? null) as StyleEntry)['borderRadius'] === 6; // BADGE_RADIUS
  });
  expect(text, `StatusBadge « ${label} » introuvable`).toBeDefined();
  return { text: text!, frame: text!.parent! };
}

beforeEach(() => {
  configure();
});

describe('« Jamais transmise » — LE risque cash domine la colonne', () => {
  it('StatusStrip AMBRE (#FBF0DF / encre AA #8A5A12) rendu AVANT l’échéance neutre', async () => {
    const rendered = treeOf(await render());
    // L'état honnête (clé facture.neverTransmitted, pote).
    const neverIdx = rendered.indexOf('#FBF0DF'); // warningBg du strip ambre
    expect(neverIdx).toBeGreaterThan(-1);
    expect(rendered).toContain('"color":"#8A5A12"'); // warningInk AA (plus le warning nu 2,99:1)
    // L'échéance (dueLine, strip NEUTRE lineSoft #F1F4F7) vient APRÈS dans la colonne.
    const dueIdx = rendered.indexOf('"backgroundColor":"#F1F4F7"');
    expect(dueIdx).toBeGreaterThan(-1);
    expect(neverIdx).toBeLessThan(dueIdx);
  });

  it('transmission déclarée ⇒ StatusStrip SUCCESS (#EAF2EC / #0E5C44) avec check, plus d’ambre', async () => {
    configure({
      invoice: q({
        data: {
          ...NEVER_TRANSMITTED,
          transmission: { depositedAt: '2026-07-02', acceptedAt: null },
        },
      }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"backgroundColor":"#EAF2EC"');
    expect(rendered).toContain('"color":"#0E5C44"');
    expect(rendered).not.toContain('"backgroundColor":"#FBF0DF"');
  });
});

describe('Relances — « en attente » redevient neutre', () => {
  it('entrée pending ⇒ badge NEUTRE SCOPÉ AU NŒUD : encre slate500 SUR fond lineSoft — plus jamais la paire b2b', async () => {
    configure({
      feedItems: [
        {
          id: 'n1',
          kind: 'invoice-relance',
          route: '/facture/i1',
          title: 'Relance J+7',
          status: 'pending',
          createdAt: '2026-07-10T08:00:00.000Z',
        },
      ],
    });
    const renderer = await render();
    expect(treeOf(renderer)).toContain('Relance J+7');
    // SCOPÉ AU NŒUD du badge (verdict PR #61, P1) : #5B6B7B est l'encre courante de la moitié
    // de l'écran — l'asserter sur l'arbre entier ne prouvait RIEN (le mutant b2b survivait).
    // Et un not.toContain('#1B3A63') global rougirait du code non muté (b2b légitime ailleurs).
    const { text, frame } = statusBadgeOf(renderer, 'En cours');
    const textStyle = flattenStyle(text.props.style as StyleEntry);
    const frameStyle = flattenStyle(frame.props.style as StyleEntry);
    expect(textStyle['color']).toBe('#5B6B7B'); // neutralInk = slate500
    expect(frameStyle['backgroundColor']).toBe('#F1F4F7'); // neutralBg = lineSoft
    // La paire b2b (#1B3A63 sur #E6EDF6) ne peut pas repeindre CE badge sans rougir ici.
    expect(textStyle['color']).not.toBe('#1B3A63');
    expect(frameStyle['backgroundColor']).not.toBe('#E6EDF6');
  });

  it('entrée done ⇒ badge SUCCESS scopé (encre #0E7C5A sur #EAF2EC) — la dérivation par statut tient', async () => {
    configure({
      feedItems: [
        {
          id: 'n2',
          kind: 'invoice-relance',
          route: '/facture/i1',
          title: 'Relance J+7',
          status: 'done',
          createdAt: '2026-07-10T08:00:00.000Z',
        },
      ],
    });
    const renderer = await render();
    const { text, frame } = statusBadgeOf(renderer, 'Envoyée');
    expect(flattenStyle(text.props.style as StyleEntry)['color']).toBe('#0E7C5A');
    expect(flattenStyle(frame.props.style as StyleEntry)['backgroundColor']).toBe('#EAF2EC');
  });
});

describe('Feuille période — DateField kit (labels visibles persistants)', () => {
  it('facture de contrat BROUILLON : la feuille porte deux labels VISIBLES au-dessus des champs', async () => {
    configure({
      invoice: q({
        data: {
          ...NEVER_TRANSMITTED,
          status: 'draft',
          number: null,
          maintenanceContractId: 'mc1',
          transmissionGuide: undefined,
          issuedAt: null,
        },
      }),
    });
    const renderer = await render();
    // Ouvre la feuille période (CTA d'édition).
    const edit = renderer.root
      .findAllByType('Pressable' as never)
      .find((n) =>
        String((n.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').includes('période'),
      );
    expect(edit).toBeDefined();
    await act(async () => {
      (edit!.props as { onPress: () => void }).onPress();
    });
    const rendered = treeOf(renderer);
    // Les labels des DateField sont RENDUS (pas seulement des placeholders).
    expect(rendered).toContain('Début (AAAA-MM-JJ)');
    expect(rendered).toContain('Fin incluse (AAAA-MM-JJ)');
    expect(rendered).toContain('"placeholder":"AAAA-MM-JJ"');
  });
});

describe('États — chargement / erreur / introuvable (jamais un cul-de-sac)', () => {
  it('chargement ⇒ skeletons', async () => {
    configure({ invoice: q({ isLoading: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityElementsHidden":true');
  });

  it('échec réseau ⇒ Réessayer ET Fermer', async () => {
    configure({ invoice: q({ isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).toContain('Fermer');
  });

  it('introuvable ⇒ Réessayer ET Fermer (deep link sans pile) — zéro Alert système', async () => {
    configure({ invoice: q({ data: undefined }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).toContain('Fermer');
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
