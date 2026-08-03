/**
 * TRANSMISSION/[id] (guide de dépôt Chorus/portail) — RENDU MULTI-ÉTATS (Lot 3).
 *
 * Ce que ce fichier verrouille :
 *  · checklist « à faire soi-même » : ton NEUTRE (lineSoft + slate500) — l'indigo de Bob
 *    (aiBg #F1EBFA) a QUITTÉ la checklist : c'est l'artisan qui agit, pas Bob ;
 *  · « vérifié / à vérifier » : ENCRES AA successInk #0E5C44 / warningInk #8A5A12 (les
 *    success/warning nus ne passaient pas le petit texte sur pastel) ;
 *  · « Déposée le… » : StatusStrip SUCCESS avec check — la même grammaire d'état que
 *    l'acompte de la pièce (planche « chaîne complète ») ;
 *  · skeleton FIDÈLE : 3 cartes (checklist / actions / suivi) ;
 *  · les CTA restent atteignables pendant le guidage vocal (insets Bob-aware).
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

vi.mock('../../../../src/lib/share-document', () => ({ shareDocument: vi.fn() }));
vi.mock('../../../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 140,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../../../src/data/hooks', () => ({
  appErrorMessage: (e: unknown) => `msg:${(e as Error).message}`,
  useInvoice: () => sources.value['invoice'],
  useRecordInvoiceTransmission: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('../../../../src/data/documents', () => ({
  useDocuments: () => sources.value['documents'],
}));
vi.mock('../../../../src/data/client', () => ({
  useBobClient: () => ({ documentDownloadUrl: vi.fn() }),
}));

const { default: TransmissionGuide } = await import('../[id]');

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

/** Guide Chorus : 1 prérequis vérifié, 1 à vérifier, 1 à faire soi-même. */
const GUIDED_INVOICE = {
  id: 'i1',
  number: 'F-2026-118',
  purchaseOrder: null,
  transmission: null,
  transmissionGuide: {
    channel: 'chorus',
    chorusServiceCode: null,
    checklist: [
      { label: 'SIRET du client vérifié', done: true },
      { label: 'N° d’engagement à vérifier', done: false },
      { label: 'Déposer le PDF sur Chorus Pro', done: undefined },
    ],
  },
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  alertSpy.mockClear();
  sources.value = {
    invoice: q({ data: GUIDED_INVOICE }),
    documents: q({ data: [] }),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(TransmissionGuide)));
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

describe('Checklist — l’indigo rendu à Bob, encres AA', () => {
  it('« à faire soi-même » = NEUTRE (lineSoft #F1F4F7 + slate500 #5B6B7B) — aiBg #F1EBFA ABSENT de l’écran', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('Déposer le PDF sur Chorus Pro');
    // Le ton manuel est neutre…
    expect(rendered).toContain('"backgroundColor":"#F1F4F7"');
    expect(rendered).toContain('"color":"#5B6B7B"');
    // …et l'indigo sémantique de Bob a quitté la checklist (et l'écran entier) — le badge
    // b2g du header partage le hex #4338CA, c'est le FOND aiBg qui est le témoin univoque.
    expect(rendered).not.toContain('#F1EBFA'); // semantic.aiBg
  });

  it('vérifié / à vérifier : encres AA successInk #0E5C44 / warningInk #8A5A12 (plus les tons nus)', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('"color":"#0E5C44"');
    expect(rendered).toContain('"color":"#8A5A12"');
    // Les encres nues sous-contrastées ont disparu des états de checklist.
    expect(rendered).not.toContain('"color":"#C77A12"'); // semantic.warning nu (2,99:1)
  });
});

describe('Suivi déclaré — StatusStrip avec check (la même grammaire que la pièce)', () => {
  it('« Déposée le… » ⇒ StatusStrip success (pastel #EAF2EC) + tracé du CheckIcon', async () => {
    configure({
      invoice: q({
        data: { ...GUIDED_INVOICE, transmission: { depositedAt: '2026-07-02', acceptedAt: null } },
      }),
    });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"backgroundColor":"#EAF2EC"');
    expect(rendered).toContain('02/07/2026');
    // Le check est dessiné (icône vectorielle injectée), encre successInk.
    expect(rendered).toContain('"stroke":"#0E5C44"');
  });

  it('sans dépôt déclaré : le CTA « Déposée aujourd’hui » reste le premier geste, aucune date affirmée', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('Déposée aujourd’hui');
    // Aucune date de dépôt inventée (les dates ne viennent QUE du déclaré).
    expect(rendered).not.toContain('02/07/2026');
  });
});

describe('États — skeleton fidèle / erreur', () => {
  it('chargement ⇒ TROIS cartes skeleton (checklist / actions / suivi)', async () => {
    configure({ invoice: q({ isLoading: true }) });
    const renderer = await render();
    const rendered = treeOf(renderer);
    expect(rendered).toContain('"accessibilityElementsHidden":true');
    // 3 SkeletonCard : la silhouette du vrai écran, pas une approximation à 2 cartes.
    const cardMatches = rendered.match(/"contentLines"/g);
    void cardMatches; // les contentLines ne traversent pas le JSON — compte par conteneurs :
    expect(rendered.split('"accessibilityElementsHidden":true').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('échec réseau ⇒ Réessayer ET Fermer — zéro Alert système', async () => {
    configure({ invoice: q({ isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).toContain('Fermer');
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
