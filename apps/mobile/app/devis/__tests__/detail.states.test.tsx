/**
 * DEVIS/[id] — RENDU MULTI-ÉTATS + FLUX TVA DE DUPLICATION (critères de preuve Lot 3).
 *
 * Ce que ce fichier verrouille :
 *  · le flux TVA « Refaire ce devis » parle QuestionSheet + LegalHint — Alert.alert n'est
 *    PLUS JAMAIS appelé, et les 3 branches runDuplicate produisent des payloads
 *    BYTE-IDENTIQUES à l'historique (context/standardRateForReducedLines exacts) ;
 *  · grammaire d'erreur : un échec de duplication ouvre l'ErrorSheet au titre i18n
 *    errors.sheetTitle (« Oups » est BANNI — verdict PR #61 P3), plus la modale système ;
 *  · ajustement TVA à la copie : la navigation ATTEND la fermeture de la feuille —
 *    ÉCART DE COMPORTEMENT DÉCLARÉ vs legacy (Alert non bloquant + push immédiat), décision
 *    documentée au site d'appel (l'alerte flottait par-dessus l'écran d'arrivée) ;
 *  · états : chargement (skeletons), erreur réseau (retry + fermer), introuvable.
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
  useLocalSearchParams: () => ({ id: 'q1' }),
}));

vi.mock('../../../src/agent', () => ({ usePublishAgentContext: vi.fn() }));
vi.mock('../../../src/lib/share-document', () => ({ shareDocument: vi.fn() }));
vi.mock('../../../src/components/ShareQuoteLinkButton', () => ({ ShareQuoteLinkButton: () => null }));
vi.mock('../../../src/components/QuoteLineEditSheet', () => ({ QuoteLineEditSheet: () => null }));
vi.mock('../../../src/components/PurchaseOrderSection', () => ({
  PurchaseOrderCard: () => null,
  PurchaseOrderSheet: () => null,
}));
vi.mock('../../../src/components/DocumentActions', () => ({
  QuoteActions: () => null,
  hasQuoteActions: () => false,
}));
// PieceDetailView : doublure de RENDU qui expose `extra` (relance…) — la vue elle-même a
// ses preuves ailleurs ; ici on teste l'ÉCRAN.
vi.mock('../../../src/components/PieceDetailView', async () => {
  const react = await import('react');
  return {
    PieceDetailView: ({ extra, actions }: { extra?: unknown; actions?: unknown }) =>
      react.createElement('PieceDetailView', null, extra as never, actions as never),
  };
});
const relance = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock('../../../src/components/quote-relance-prompt.logic', () => ({
  quoteRelancePromptOf: () => relance.value,
}));

const confirmDouble = vi.hoisted(() => ({ result: true }));
vi.mock('../../../src/components/ConfirmSheet', () => ({
  useConfirm: () => () => Promise.resolve(confirmDouble.result),
}));

const duplicateDouble = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn((_input: Record<string, unknown>) =>
    Promise.resolve({ quoteId: 'q2', vatAdjustments: [] as unknown[] }),
  ),
}));
const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../../src/data/hooks', () => ({
  appErrorMessage: (e: unknown) => `msg:${(e as Error).message}`,
  useQuote: () => sources.value['quote'],
  useCustomers: () => sources.value['customers'],
  useInvoices: () => sources.value['invoices'],
  useCreateQuoteViewLink: () => ({ mutateAsync: vi.fn() }),
  useDuplicateQuote: () => duplicateDouble,
  useAttachQuotePurchaseOrder: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useDetachQuotePurchaseOrder: () => ({ mutateAsync: vi.fn() }),
  useRemoveQuoteLine: () => ({ mutateAsync: vi.fn() }),
  useUpdateQuoteLine: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('../../../src/data/documents', () => ({
  useDocuments: () => sources.value['documents'],
}));
vi.mock('../../../src/data/client', () => ({
  useBobClient: () => ({ documentDownloadUrl: vi.fn() }),
}));

const { default: DevisDetail } = await import('../[id]');

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

const MARTIN = { id: 'c-martin', name: 'SARL Martin Rénovation', type: 'b2b', siren: '821503646' };
/** Devis SIGNÉ à taux réduits (10 % + 5,5 %) — le flux TVA de duplication s'arme. */
const REDUCED_QUOTE = {
  id: 'q1',
  status: 'signed',
  number: 'D-2026-014',
  depositPct: null,
  totals: { ht: 100000, vatByRate: { '10': 8000, '5.5': 1100 }, vat: 9100, ttc: 109100, netToPay: 109100 },
  lines: [
    { id: 'l1', label: 'Pose PAC', category: 'labor', qty: 1, unitPriceHT: 80000, vatRate: 10 },
    { id: 'l2', label: 'Isolation', category: 'supply', qty: 1, unitPriceHT: 20000, vatRate: 5.5 },
  ],
  signed: true,
  customerId: 'c-martin',
  revision: 1,
  purchaseOrder: null,
  issuedAt: null,
  urgentRepair: null,
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  alertSpy.mockClear();
  nav.push.mockClear();
  confirmDouble.result = true;
  relance.value = null;
  duplicateDouble.isPending = false;
  duplicateDouble.mutateAsync = vi.fn((_input: Record<string, unknown>) =>
    Promise.resolve({ quoteId: 'q2', vatAdjustments: [] as unknown[] }),
  );
  sources.value = {
    quote: q({ data: REDUCED_QUOTE }),
    customers: q({ data: [MARTIN] }),
    invoices: q({ data: [] }),
    documents: q({ data: [] }),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(DevisDetail)));
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

function pressByLabel(renderer: ReactTestRenderer, label: string): void {
  const node = renderer.root
    .findAllByType('Pressable' as never)
    .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === label);
  expect(node, `Pressable « ${label} » introuvable`).toBeDefined();
  (node!.props as { onPress: () => void }).onPress();
}

beforeEach(() => {
  configure();
});

describe('Flux TVA de duplication — QuestionSheet + LegalHint, jamais l’Alert système', () => {
  it('« Refaire ce devis » (taux réduits) ⇒ feuille avec la question, la mention énergie et la LegalHint — zéro Alert.alert', async () => {
    const renderer = await render();
    await act(async () => {
      pressByLabel(renderer, 'Refaire ce devis');
    });
    const rendered = treeOf(renderer);
    // La question porte la mention énergie (une ligne à 5,5 %).
    expect(rendered).toContain('et rénovation énergétique');
    expect(rendered).toContain('Oui — conditions remplies');
    expect(rendered).toContain('Non — TVA 20 %');
    // LegalHint au point de décision (in-line bénéfice + source CGI).
    expect(rendered).toContain('incontestable');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(duplicateDouble.mutateAsync).not.toHaveBeenCalled();
  });

  it('« Oui — conditions remplies » ⇒ payload BYTE-IDENTIQUE : context {housingOlderThan2y, energyRenovation}', async () => {
    const renderer = await render();
    await act(async () => {
      pressByLabel(renderer, 'Refaire ce devis');
    });
    await act(async () => {
      pressByLabel(renderer, 'Oui — conditions remplies');
    });
    expect(duplicateDouble.mutateAsync).toHaveBeenCalledTimes(1);
    const payload = duplicateDouble.mutateAsync.mock.calls[0]![0];
    expect(payload['quoteId']).toBe('q1');
    expect(payload['context']).toEqual({ housingOlderThan2y: true, energyRenovation: true });
    expect(payload).not.toHaveProperty('standardRateForReducedLines');
    expect(String(payload['idempotencyKey'])).toMatch(/^refaire:q1:/);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('« Non — TVA 20 % » ⇒ payload BYTE-IDENTIQUE : standardRateForReducedLines: true, AUCUN context', async () => {
    const renderer = await render();
    await act(async () => {
      pressByLabel(renderer, 'Refaire ce devis');
    });
    await act(async () => {
      pressByLabel(renderer, 'Non — TVA 20 %');
    });
    expect(duplicateDouble.mutateAsync).toHaveBeenCalledTimes(1);
    const payload = duplicateDouble.mutateAsync.mock.calls[0]![0];
    expect(payload['standardRateForReducedLines']).toBe(true);
    expect(payload).not.toHaveProperty('context');
  });

  it('échec de duplication ⇒ ErrorSheet au titre i18n de la grammaire (« Oups » BANNI, verdict PR #61 P3) + message discriminé', async () => {
    duplicateDouble.mutateAsync = vi.fn(() => Promise.reject(new Error('duplication refusée')));
    const renderer = await render();
    await act(async () => {
      pressByLabel(renderer, 'Refaire ce devis');
    });
    await act(async () => {
      pressByLabel(renderer, 'Non — TVA 20 %');
    });
    const rendered = treeOf(renderer);
    // errors.sheetTitle (pote) — le littéral français codé en dur a disparu du site d'appel.
    expect(rendered).toContain('Ça n’est pas passé');
    expect(rendered).not.toContain('Oups');
    expect(rendered).toContain('msg:duplication refusée');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('TVA ajustée à la copie ⇒ la navigation ATTEND la fermeture de la feuille (ÉCART DÉCLARÉ vs Alert legacy non bloquant, doctrine « traced »)', async () => {
    duplicateDouble.mutateAsync = vi.fn(() =>
      Promise.resolve({ quoteId: 'q2', vatAdjustments: [{ lineId: 'l1' }] }),
    );
    const renderer = await render();
    await act(async () => {
      pressByLabel(renderer, 'Refaire ce devis');
    });
    await act(async () => {
      pressByLabel(renderer, 'Non — TVA 20 %');
    });
    // La feuille annonce l'ajustement — l'écran n'a PAS encore navigué.
    expect(treeOf(renderer)).toContain('Brouillon créé');
    expect(nav.push).not.toHaveBeenCalled();
    await act(async () => {
      pressByLabel(renderer, 'OK');
    });
    expect(nav.push).toHaveBeenCalledWith('/devis/q2');
  });
});

describe('États — chargement / erreur / introuvable (jamais un cul-de-sac)', () => {
  it('chargement ⇒ skeletons, aucun contenu de pièce', async () => {
    configure({ quote: q({ isLoading: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityElementsHidden":true');
    expect(rendered).not.toContain('Refaire ce devis');
  });

  it('échec réseau ⇒ Réessayer ET Fermer disponibles', async () => {
    configure({ quote: q({ isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).toContain('Fermer');
  });

  it('pièce introuvable ⇒ Réessayer ET Fermer (deep link sans pile)', async () => {
    configure({ quote: q({ data: undefined }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).toContain('Fermer');
  });
});
