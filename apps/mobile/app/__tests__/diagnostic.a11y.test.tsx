/**
 * DIAGNOSTIC — A11Y & MATIÈRE À TRAVERS LE FADE-THROUGH (Lot 5) :
 * · les ANNONCES de phase (announceForAccessibility) survivent au MorphReplace : passer
 *   intro → steps annonce le titre de l'audit (critère de preuve du plan) ;
 * · les panneaux verre portent la recette GlassPanelDark (white07 / bord white10 /
 *   radius 18) — la triple copie est morte ;
 * · doctrine AA on-dark : plus AUCUN corps en white66 ni détail en white50 — corps ≥
 *   white80, détails/chevrons ≥ white70 (littéraux rgba) ;
 * · ProgressBar sur PreferenceState STRICT : préférence JAMAIS résolue ⇒ largeur statique
 *   ("20%" à l'étape audit), pas d'interpolation Animated.
 * Données réelles : runDiagnostic (moteur du domaine) + deriveDiagnostic — zéro fixture
 * de score. Dates relatives au présent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { deriveDiagnostic, runDiagnostic } from '@bob/core';
import { ThemeProvider } from '@bob/ui';

/**
 * SONDE COUNT-UP (verdict Lot 5, P2 — phase result hors couverture) : chaque rendu du
 * ScoreRing enregistre la valeur `score` reçue. Sous ignorance (préférence motion jamais
 * résolue), la PREMIÈRE frame doit déjà porter le score VRAI — jamais un 0 mensonger
 * (mutant N10 : useState(0) dans useCountUp).
 */
const ringScores = vi.hoisted(() => ({ value: [] as number[] }));
vi.mock('@bob/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/ui')>();
  const { createElement: h } = await import('react');
  return {
    ...actual,
    ScoreRing: (props: { score: number }) => {
      ringScores.value.push(props.score);
      return h(actual.ScoreRing as never, props as never);
    },
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FakeAnimatedValue, announceSpy } = vi.hoisted(() => {
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
  return { FakeAnimatedValue, announceSpy: vi.fn() };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
    announceForAccessibility: announceSpy,
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
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles, absoluteFill: {} },
  Text: 'Text',
  View: 'View',
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
vi.mock('../../src/agent', () => ({ usePublishAgentContext: vi.fn() }));
vi.mock('../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 150,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/data/hooks', () => ({
  useDiagnostic: () => sources.value['diagnostic'],
  useCustomers: () => sources.value['customers'],
  useInvoices: () => sources.value['invoices'],
  usePayments: () => sources.value['payments'],
  useProfile: () => sources.value['profile'],
  useDiagnosticAssessment: () => sources.value['assessment'],
  useSaveDiagnosticAssessment: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  }),
}));

const { default: Diagnostic } = await import('../diagnostic');

interface QueryDouble {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  isRefetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
}
function q(over: Partial<QueryDouble> = {}): QueryDouble {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    isRefetching: false,
    refetch: vi.fn(),
    ...over,
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const isoOf = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const TODAY = isoOf(new Date());

/** Faits RÉELS via le moteur du domaine (même patron que derive-diagnostic.test.ts). */
const FACTS = runDiagnostic({
  country: 'FR',
  trade: 'plombier',
  vatRegime: 'reel_normal',
  customerTypes: ['b2c'],
  hasDecennale: true,
  asOf: TODAY,
});

function configure(over: Partial<Record<string, unknown>> = {}): void {
  sources.value = {
    diagnostic: q({ data: FACTS }),
    customers: q({ data: [{ id: 'c1', type: 'b2c', siren: null }] }),
    invoices: q({
      data: [
        {
          id: 'i1',
          customerId: 'c1',
          kind: 'final',
          status: 'paid',
          totals: { ht: 100_000, tva: 20_000, ttc: 120_000, netToPay: 120_000 },
          lines: [{ category: 'labor' }, { category: 'supply' }],
        },
      ],
    }),
    payments: q({ data: [] }),
    profile: q({ data: { trade: 'plombier' } }),
    assessment: q({
      data: {
        status: 'current',
        saved: null,
        result: null,
        staleReason: null,
        questions: ['platform', 'offAppSales', 'accountant'],
        currentSourceAsOf: TODAY,
        currentSourceFingerprint: 'fp-1',
      },
    }),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Diagnostic)));
  });
  return renderer;
}
const treeOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

function findByLabel(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('Pressable' as never)
    .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === label);
}

async function beginAudit(renderer: ReactTestRenderer): Promise<void> {
  const cta = findByLabel(renderer, 'C’est parti — 2 min'); // diag.introCta (pote)
  expect(cta).toBeDefined();
  await act(async () => {
    (cta!.props as { onPress: () => void }).onPress();
  });
}

/** Résultat RÉEL du même use case pur que l'écran — zéro score inventé. */
const SAVED_ANSWERS = { platform: 'no', offAppSales: 'no', accountant: 'yes' } as const;
const SAVED_RESULT = deriveDiagnostic({
  facts: FACTS,
  customers: [{ id: 'c1', type: 'b2c', siren: null }],
  invoices: [
    {
      id: 'i1',
      customerId: 'c1',
      kind: 'final',
      status: 'paid',
      ttcCents: 120_000,
      lineCategories: ['labor', 'supply'],
    },
  ],
  payments: [],
  profile: { trade: 'plombier' },
  answers: SAVED_ANSWERS,
  today: TODAY,
});

/** Assessment « déjà réalisé, courant » : le CTA d'intro rouvre directement le résultat. */
function configureWithSavedResult(): void {
  configure({
    assessment: q({
      data: {
        status: 'current',
        saved: { revision: 1, updatedAt: TODAY, answers: SAVED_ANSWERS },
        result: SAVED_RESULT,
        staleReason: null,
        questions: ['platform', 'offAppSales', 'accountant'],
        currentSourceAsOf: TODAY,
        currentSourceFingerprint: 'fp-1',
      },
    }),
  });
}

beforeEach(() => {
  announceSpy.mockClear();
  ringScores.value.length = 0;
  configure();
});

describe('Annonces de phase — préservées à travers le fade-through (MorphReplace)', () => {
  it('intro → steps : le titre de l’audit est ANNONCÉ malgré le wrapper de morph', async () => {
    const renderer = await render();
    expect(announceSpy).not.toHaveBeenCalled(); // l'intro n'annonce rien
    await beginAudit(renderer);
    expect(announceSpy).toHaveBeenCalledWith('J’ai déjà regardé ton dossier'); // diag.auditTitle
    // Le contenu de l'audit est bien à l'écran (constats du dossier réel).
    expect(treeOf(renderer)).toContain('J’ai déjà regardé ton dossier');
  });
});

describe('GlassPanelDark — la triple copie est morte', () => {
  it('le panneau des constats porte la recette kit : white07, bord white10, radius 18', async () => {
    const renderer = await render();
    await beginAudit(renderer);
    const rendered = treeOf(renderer);
    expect(rendered).toContain('"backgroundColor":"rgba(255,255,255,.07)"');
    expect(rendered).toContain('"borderColor":"rgba(255,255,255,.1)"');
    expect(rendered).toContain('"borderRadius":18');
  });
});

describe('Doctrine AA on-dark — corps ≥ white80, détails ≥ white70', () => {
  it('plus AUCUN corps white66 ni détail white50 dans l’audit', async () => {
    const renderer = await render();
    await beginAudit(renderer);
    const rendered = treeOf(renderer);
    expect(rendered).not.toContain('rgba(255,255,255,.66)');
    expect(rendered).not.toContain('rgba(255,255,255,.5)"');
    expect(rendered).toContain('rgba(255,255,255,.8)'); // corps white80
    expect(rendered).toContain('rgba(255,255,255,.7)'); // détails white70
  });

  it('l’intro aussi : le corps passe en white80', async () => {
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('rgba(255,255,255,.66)');
    expect(rendered).toContain('rgba(255,255,255,.8)');
  });
});

describe('ProgressBar — PreferenceState strict, statique sous ignorance', () => {
  it('préférence JAMAIS résolue ⇒ largeur statique "20%" à l’étape audit (1/5)', async () => {
    const renderer = await render();
    await beginAudit(renderer);
    // totalSteps = 3 questions + 1 audit ⇒ progress (0+1)/(4+1) = 20 %.
    expect(treeOf(renderer)).toContain('"width":"20%"');
  });
});

describe('Phase RESULT — couverte de bout en bout (verdict Lot 5, P2)', () => {
  it('count-up honnête : le score VRAI dès la PREMIÈRE frame sous ignorance, jamais un 0', async () => {
    configureWithSavedResult();
    expect(SAVED_RESULT.score).toBeGreaterThan(0); // sanity : un 0 mensonger serait discernable
    const renderer = await render();
    await beginAudit(renderer); // diagnostic déjà réalisé et courant ⇒ résultat direct
    // La SONDE du ScoreRing (mutant N10 : useState(0) dans useCountUp — la première frame
    // peindrait 0 avant que l'effet ne corrige) : CHAQUE frame porte le score vrai.
    expect(ringScores.value.length).toBeGreaterThan(0);
    expect(ringScores.value[0]).toBe(SAVED_RESULT.score);
    expect(ringScores.value.every((score) => score === SAVED_RESULT.score)).toBe(true);
  });

  it('la transition vers le résultat est ANNONCÉE (announceForAccessibility, planTitle)', async () => {
    configureWithSavedResult();
    const renderer = await render();
    await beginAudit(renderer);
    expect(announceSpy).toHaveBeenCalledWith('Ton plan d’action'); // diag.planTitle (pote)
  });

  it('les panneaux du résultat portent la recette GlassPanelDark, le CTA dégradé est actionnable', async () => {
    configureWithSavedResult();
    const renderer = await render();
    await beginAudit(renderer);
    const rendered = treeOf(renderer);
    // Les deux GlassPanelDark du résultat (axes + plan d'action) — recette kit.
    expect(rendered).toContain('"backgroundColor":"rgba(255,255,255,.07)"');
    expect(rendered).toContain('"borderColor":"rgba(255,255,255,.1)"');
    expect(rendered).toContain('"borderRadius":18');
    // Le plan d'action est là (titre de section) et le CTA dégradé est actionnable.
    expect(rendered).toContain('Ton plan d’action');
    const cta = findByLabel(renderer, 'Configurer ma réception'); // diag.resultCta (pote)
    expect(cta).toBeDefined();
    const state = (cta!.props as { accessibilityState?: { disabled?: boolean } })
      .accessibilityState;
    expect(state?.disabled).toBe(false); // actionsDisabled=false : sources courantes
    // Et la porte de sortie douce « Plus tard » reste offerte.
    expect(findByLabel(renderer, 'Plus tard')).toBeDefined();
  });
});
