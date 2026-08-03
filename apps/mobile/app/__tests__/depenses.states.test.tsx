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
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { formatEUR } from '@bob/core';
import { ThemeProvider, contrastRatio } from '@bob/ui';

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

/** Aplati un style RN (objet ou tableau imbriqué) — le DERNIER gagne, comme au runtime. */
type FlatStyle = Record<string, unknown>;
function flatStyle(style: unknown): FlatStyle {
  if (Array.isArray(style)) {
    return style.reduce<FlatStyle>((acc, entry) => ({ ...acc, ...flatStyle(entry) }), {});
  }
  return style !== null && typeof style === 'object' ? { ...(style as FlatStyle) } : {};
}

/**
 * SCOPÉ AU NŒUD (verdict Lot 5, P1 n°3 — la pastille catégorie et le badge partagent les
 * mêmes hex que le héros : une assertion sur l'arbre entier ne prouve RIEN du héros) :
 * · le MONTANT héros = l'unique Text au cran moneyHero (fontSize 27) de l'écran ;
 * · sa CARTE = l'ancêtre le plus proche au borderRadius 20 (la Card radius={20} du héros) ;
 * · l'EYEBROW = le Text « À payer » DANS cette carte.
 */
function heroNodes(renderer: ReactTestRenderer) {
  const amount = renderer.root
    .findAllByType('Text' as never)
    .find((node) => flatStyle((node.props as { style?: unknown }).style)['fontSize'] === 27);
  expect(amount).toBeDefined();
  let card: ReactTestInstance | null = amount!.parent;
  while (
    card !== null &&
    flatStyle((card.props as { style?: unknown }).style)['borderRadius'] !== 20
  ) {
    card = card.parent;
  }
  expect(card).not.toBeNull();
  const eyebrow = card!
    .findAllByType('Text' as never)
    .find((node) => (node.props as { children?: unknown }).children === 'À payer');
  expect(eyebrow).toBeDefined();
  return {
    amountColor: flatStyle((amount!.props as { style?: unknown }).style)['color'] as string,
    cardBg: flatStyle((card!.props as { style?: unknown }).style)['backgroundColor'] as string,
    eyebrowColor: flatStyle((eyebrow!.props as { style?: unknown }).style)['color'] as string,
  };
}

function paymentSheet(renderer: ReactTestRenderer) {
  const sheets = renderer.root.findAllByType('ExpensePaymentSheet' as never);
  expect(sheets.length).toBe(1); // JAMAIS deux feuilles empilées
  return sheets[0]!;
}

beforeEach(() => {
  configure();
});

describe('PLANCHE « matière argent » — le héros dette, SCOPÉ AU NŒUD', () => {
  it('dette > 0 ⇒ LA carte héros porte le voile warningBg, LE montant est warningInk AA', async () => {
    const { amountColor, cardBg, eyebrowColor } = heroNodes(await render());
    // Le voile est sur la carte du héros elle-même — pas sur une pastille voisine.
    expect(cardBg).toBe('#FBF0DF'); // semantic.warningBg (mutant N1 : suppression du voile)
    // Le montant héros est teinté par l'état — encre AA du Lot 0, plus jamais 2,99:1.
    expect(amountColor).toBe('#8A5A12'); // semantic.warningInk (mutant N2 : jamais teinté)
    expect(eyebrowColor).toBe('#8A5A12'); // l'eyebrow quitte slate400 (2,59:1) sous le voile
    // Contraste MESURÉ sur le nœud (WCAG 2.x) : ≥ 3:1 gros texte, ≥ 4,5:1 petit texte.
    expect(contrastRatio(amountColor, cardBg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(eyebrowColor, cardBg)).toBeGreaterThanOrEqual(4.5);
  });

  it('dette à zéro ⇒ LA carte héros est neutre (surface), montant ink900, eyebrow slate400', async () => {
    configure({ expenses: q({ data: [PAID] }) });
    const { amountColor, cardBg, eyebrowColor } = heroNodes(await render());
    expect(cardBg).toBe('#FFFFFF'); // neutrals.surface — aucun voile résiduel
    expect(amountColor).toBe('#0C2340'); // colors.ink900
    expect(eyebrowColor).toBe('#8A99A8'); // colors.slate400 (hiérarchie neutre conservée)
  });

  it('mini-stats en KpiTile kit — AVEC les centimes (iso-information, chiffres fiscaux)', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('Payé ce mois-ci');
    expect(rendered).toContain('TVA récupérable du mois');
    // formatEUR, jamais l'arrondi à l'euro : 240,00 € décaissés, 55,00 € de TVA (fixtures).
    // TÉMOIN SCOPÉ PAR CONSTRUCTION (P2 de la re-vérification) : le montant seul est ambigu —
    // la rangée Point P affiche le même 240,00 € au même format. L'accessibilityLabel composite
    // de KpiTile (« label, montant ») est lui UNIQUE dans l'arbre : il lie la tuile à SA valeur,
    // et meurt si la tuile repasse à l'arrondi entier (« Payé ce mois-ci, 240 € »).
    expect(rendered).toContain(
      JSON.stringify(`Payé ce mois-ci, ${formatEUR(24_000)}`).slice(1, -1),
    );
    expect(rendered).toContain(
      JSON.stringify(`TVA récupérable du mois, ${formatEUR(5_500)}`).slice(1, -1),
    );
    expect(rendered).toContain(JSON.stringify(formatEUR(24_000)).slice(1, -1));
    expect(rendered).toContain(JSON.stringify(formatEUR(5_500)).slice(1, -1));
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
  it('pastille carburant au rôle expenseCategory.carburant — scopée à la tuile 34 pt', async () => {
    const renderer = await render();
    expect(treeOf(renderer)).toContain('Brico Dépôt');
    // La TUILE de catégorie elle-même (IconTile 34) porte le fond du rôle — assertion
    // scopée : le voile du héros partage le même hex et ne peut plus la satisfaire.
    const tile = renderer.root.findAllByType('View' as never).find((node) => {
      const style = flatStyle((node.props as { style?: unknown }).style);
      return style['width'] === 34 && style['backgroundColor'] === '#FBF0DF';
    });
    expect(tile).toBeDefined(); // expenseCategory.carburant.bg
  });

  it('lien chantier en famille de contenu neutre (documentTile) — plus de typologie b2b', async () => {
    const renderer = await render();
    // La tuile dossier (40 pt) du lien chantier : fond lineSoft #F1F4F7 — scopée à SA
    // taille ; plus AUCUNE tuile 40 pt en b2bBg (la pastille materiel 34 pt garde
    // légitimement sa primitive partagée via le rôle expenseCategory.materiel).
    const tiles40 = renderer.root.findAllByType('View' as never).filter((node) => {
      const style = flatStyle((node.props as { style?: unknown }).style);
      return style['width'] === 40;
    });
    expect(tiles40.length).toBeGreaterThan(0);
    const backgrounds = tiles40.map(
      (node) => flatStyle((node.props as { style?: unknown }).style)['backgroundColor'],
    );
    expect(backgrounds).toContain('#F1F4F7'); // documentTile.bg
    expect(backgrounds).not.toContain('#E6EDF6'); // semantic.b2bBg éteint sur le lien chantier
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
