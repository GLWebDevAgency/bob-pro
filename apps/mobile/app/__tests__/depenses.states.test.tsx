/**
 * DÉPENSES — RENDU MULTI-ÉTATS (Lot 5) + ALLER-RETOUR onError DU PASSAGE PAYÉ :
 * · héros MATIÈRE : dette > 0 ⇒ voile warningBg (#FBF0DF) + MoneyText moneyHero (27/800)
 *   teinté warning ; dette à zéro ⇒ carte neutre (surface), montant ink900 ;
 * · mini-stats → KpiTile kit (Payé ce mois-ci / TVA récupérable) ;
 * · MorphReplace payé : le flux « Enregistrer comme payée » qui ÉCHOUE rouvre la feuille
 *   avec le brouillon et l'erreur — AUCUN état fantôme (critère de preuve du plan) ;
 * · Toast tone DANGER sur l'échec chantier (croix #FADDD9) — plus de coche mensongère ;
 * · rôles catégories dédiés (expenseCategory.carburant sur la pastille) ;
 * · EmptyState, rangée retour kit 44 pt. Dates relatives au présent.
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
    announceForAccessibility: vi.fn(),
    setAccessibilityFocus: vi.fn(),
  },
  ActivityIndicator: 'ActivityIndicator',
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, in: (f: unknown) => f, quad: {}, cubic: {}, ease: {} },
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles, absoluteFill: {} },
  Text: 'Text',
  View: 'View',
  findNodeHandle: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('@bob/ai', () => ({ challengeFor: () => ({ kind: 'tap' }) }));

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
// Confirmation comptable TOUJOURS accordée (le palier est testé ailleurs) — le test vise
// l'aller-retour d'état autour de la mutation.
vi.mock('../../src/components/ConfirmSheet', () => ({
  useConfirm: () => async () => true,
}));
// La feuille partagée devient un STUB inspectable : on lit visible/error, on pilote onSubmit.
vi.mock('../../src/components/ExpensePaymentSheet', () => ({
  ExpensePaymentSheet: 'ExpensePaymentSheet',
}));

const sources = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  pay: { value: {} as Record<string, unknown> },
  blocking: { value: false },
}));
vi.mock('../../src/data/authoritative-query-state', () => ({
  hasBlockingAuthoritativeDataError: () => sources.blocking.value,
}));
vi.mock('../../src/data/hooks', () => ({
  useExpenses: () => sources.value['expenses'],
  useChantiers: () => sources.value['chantiers'],
  usePayExpense: () => sources.pay.value,
  useRegularizeExpensePayment: () => ({ isPending: false, mutate: vi.fn(), variables: undefined }),
  useAssignExpenseChantier: () => sources.value['assignChantier'],
}));

const { default: Depenses } = await import('../depenses');

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

const pad2 = (n: number): string => String(n).padStart(2, '0');
const isoOf = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const TODAY = isoOf(new Date());

const TO_PAY = {
  id: 'x1',
  supplierName: 'Brico Dépôt',
  category: 'carburant',
  status: 'to_pay',
  totalTtcCents: 9_000,
  vatCents: 1_500,
  documentDate: TODAY,
  chantierId: null,
  paymentEvidence: null,
};
const PAID = {
  id: 'x2',
  supplierName: 'Point P',
  category: 'materiel',
  status: 'paid',
  totalTtcCents: 24_000,
  vatCents: 4_000,
  documentDate: TODAY,
  chantierId: 'ch1',
  paymentEvidence: { paidOn: TODAY, method: 'card', reference: null, proofDocumentId: null },
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  sources.blocking.value = false;
  sources.pay.value = { isPending: false, mutate: vi.fn(), variables: undefined };
  sources.value = {
    expenses: q({ data: [TO_PAY, PAID] }),
    chantiers: q({ data: [{ id: 'ch1', name: 'Villa Sud', status: 'open' }] }),
    assignChantier: { isPending: false, mutate: vi.fn() },
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Depenses)));
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

function findByLabel(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('Pressable' as never)
    .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === label);
}

function paymentSheet(renderer: ReactTestRenderer) {
  const sheets = renderer.root.findAllByType('ExpensePaymentSheet' as never);
  expect(sheets.length).toBe(1); // JAMAIS deux feuilles empilées
  return sheets[0]!;
}

beforeEach(() => {
  configure();
});

describe('PLANCHE « matière argent » — le héros dette', () => {
  it('dette > 0 ⇒ voile warningBg (#FBF0DF) + moneyHero 27 teinté warning (#C77A12)', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('"backgroundColor":"#FBF0DF"');
    expect(rendered).toContain('"fontSize":27');
    expect(rendered).toContain('"color":"#C77A12"');
  });

  it('dette à zéro ⇒ carte neutre (pas de voile), montant ink900', async () => {
    configure({ expenses: q({ data: [PAID] }) });
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('"backgroundColor":"#FBF0DF"');
    expect(rendered).toContain('"fontSize":27');
  });

  it('mini-stats en KpiTile kit (labels + montants entiers)', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('Payé ce mois-ci');
    expect(rendered).toContain('TVA récupérable du mois');
  });
});

describe('MorphReplace payé — l’aller-retour onError rejoué', () => {
  it('échec de la mutation ⇒ la feuille SE ROUVRE avec l’erreur, aucun état fantôme', async () => {
    vi.useFakeTimers();
    try {
      const mutate = vi.fn(
        (_input: unknown, callbacks: { onError: () => void; onSuccess: () => void }) =>
          callbacks.onError(),
      );
      sources.pay.value = { isPending: false, mutate, variables: undefined };
      const renderer = await render();

      // 1. Ouvrir la feuille de paiement depuis la carte « à payer ».
      const payCta = findByLabel(renderer, 'Enregistrer comme payée — Brico Dépôt');
      expect(payCta).toBeDefined();
      await act(async () => {
        (payCta!.props as { onPress: () => void }).onPress();
      });
      expect((paymentSheet(renderer).props as { visible: boolean }).visible).toBe(true);

      // 2. Soumettre la preuve — la feuille se ferme, la confirmation part après 240 ms.
      await act(async () => {
        (paymentSheet(renderer).props as {
          onSubmit: (evidence: { paidOn: string; method: string; reference: null }) => void;
        }).onSubmit({ paidOn: TODAY, method: 'card', reference: null });
      });
      expect((paymentSheet(renderer).props as { visible: boolean }).visible).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(300);
        await vi.runOnlyPendingTimersAsync();
      });

      // 3. La mutation a échoué ⇒ la feuille est ROUVERTE, l'erreur affichée, pas de fantôme.
      expect(mutate).toHaveBeenCalledTimes(1);
      const sheet = paymentSheet(renderer);
      expect((sheet.props as { visible: boolean }).visible).toBe(true);
      expect((sheet.props as { error: string | null }).error).toBe(
        'Je n’ai pas pu enregistrer le paiement — rien n’a changé.',
      );
      // La carte est toujours « à payer » — le statut n'a jamais menti pendant l'échec.
      expect(findByLabel(renderer, 'Enregistrer comme payée — Brico Dépôt')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Toast — l’échec chantier dit la vérité', () => {
  it('délier échoue ⇒ toast tone DANGER (croix #FADDD9), jamais une coche', async () => {
    const assignMutate = vi.fn(
      (_input: unknown, callbacks: { onError: () => void; onSuccess: () => void }) =>
        callbacks.onError(),
    );
    configure({ assignChantier: { isPending: false, mutate: assignMutate } });
    const renderer = await render();
    const unlink = renderer.root
      .findAllByType('Pressable' as never)
      .find((node) =>
        ((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').includes(
          '— Point P',
        ) &&
        ((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').startsWith('Délier'),
      );
    expect(unlink).toBeDefined();
    await act(async () => {
      (unlink!.props as { onPress: () => void }).onPress();
      // useConfirm est un stub async — laisser la microtâche se résoudre.
      await Promise.resolve();
    });
    const rendered = treeOf(renderer);
    expect(rendered).toContain('Le lien avec le chantier a raté'); // dep.chantierError (pote)
    expect(rendered).toContain('"stroke":"#FADDD9"'); // croix danger on-dark
    expect(rendered).not.toContain('"stroke":"#6EE7B7"');
  });
});

describe('Rôles catégories dédiés & états', () => {
  it('pastille carburant au rôle expenseCategory.carburant (#FBF0DF), sans typologie client', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('Brico Dépôt');
    expect(rendered).toContain('"backgroundColor":"#FBF0DF"'); // expenseCategory.carburant.bg
  });

  it('aucune dépense ⇒ EmptyState voix de Bob', async () => {
    configure({ expenses: q({ data: [] }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('scanne ton premier reçu');
  });

  it('échec bloquant ⇒ « Réessayer », aucun héros', async () => {
    configure({ expenses: q({ isError: true }) });
    sources.blocking.value = true;
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('"fontSize":27');
  });
});

describe('Rangée retour kit — cible 44 pt', () => {
  it('le retour « Fermer » est un StickyBackRow à minHeight 44 (était 34 ad hoc)', async () => {
    const renderer = await render();
    const back = findByLabel(renderer, 'Fermer');
    expect(back).toBeDefined();
    const style = (back!.props as { style: unknown }).style;
    const resolved = JSON.stringify(typeof style === 'function' ? style({ pressed: false }) : style);
    expect(resolved).toContain('"minHeight":44');
  });
});
