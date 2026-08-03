/**
 * MON PROFIL FISCAL — RENDU MULTI-ÉTATS (vague hors-lots, audit 03/08) :
 * · encres AA sur pastel : « À confirmer » (LE statut actionnable) en warningInk 5,25:1,
 *   « Confirmé » en successInk — plus jamais l'ambre nu 2,99:1 sur warningBg ;
 * · skeleton FIDÈLE : silhouette de rangées (jamais un bloc plein de 420 px) ;
 * · état « allSet » = récompense verte (successBg + successInk + coche), plus un bloc gris ;
 * · échec pur sans cache → ErrorRetry ; stale → bannière role=alert + données conservées ;
 * · gouttière spacing.gutter (20) et crans typo (body 14.5 / meta 12) sur les rangées.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { semantic, spacing } from '@bob/tokens';
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
vi.mock('../../src/components/fiscal/FiscalFieldEditSheet', () => ({
  FiscalFieldEditSheet: () => null,
}));
vi.mock('../../src/fiscal/fiscal-value-labels', () => ({
  fieldValueDisplay: (field: string) => `VAL-${field}`,
  fieldSourceCaption: () => 'Source : ton SIRET · 01/2026',
}));

const flow = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/fiscal/use-fiscal-profile-flow', () => ({
  useFiscalProfileFlow: () => flow.value,
}));

const { default: ProfilFiscal } = await import('../profil-fiscal');

const datum = (status: string) => ({ status, value: 'micro', updatedAt: '2026-01-01T00:00:00.000Z' });
const PROFILE = {
  legalForm: datum('source_fiable'),
  taxRegime: datum('hypothese'),
  socialStatus: datum('hypothese'),
  activityNature: datum('confirme_utilisateur'),
  vatRegime: datum('hypothese'),
  acre: { status: 'manquant' },
  versementLiberatoire: datum('hypothese'),
  fiscalYearEnd: datum('confirme_utilisateur'),
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  flow.value = {
    profile: PROFILE,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
    hasPending: true,
    remainingCount: 4,
    openFlow: vi.fn(),
    confirmField: vi.fn(),
    confirmPatches: vi.fn(),
    voiceAffordances: [],
    sheets: null,
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(ProfilFiscal)));
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
  return renderer.root
    .findAllByType('Text' as never)
    .find((node) => {
      const children = (node.props as { children?: unknown }).children;
      return children === content
        || (Array.isArray(children) && children.join('') === content);
    });
}

const styleOf = (node: { props: unknown }): string =>
  JSON.stringify((node.props as { style?: unknown }).style ?? null);

beforeEach(() => {
  configure();
});

describe('États de premier rang', () => {
  it('chargement sans cache : silhouette de rangées, aucun profil inventé', async () => {
    configure({ profile: undefined, isLoading: true });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityElementsHidden":true'); // skeleton
    expect(rendered).not.toContain('VAL-legalForm'); // aucune valeur fantôme
    expect(rendered).not.toContain('Réessayer');
  });

  it('échec pur sans cache : ErrorRetry, jamais un profil vide', async () => {
    configure({ profile: undefined, isError: true });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('VAL-legalForm');
  });

  it('stale (échec avec cache) : bannière alert + les rangées restent affichées', async () => {
    configure({ isError: true });
    const renderer = await render();
    const rendered = treeOf(renderer);
    expect(rendered).toContain('dernières infos connues'); // fiscal.screen.stale (pote)
    expect(rendered).toContain('VAL-legalForm'); // le snapshot reste rendu
    // La bannière stale reste NEUTRE (lineSoft) — jamais la matière verte de la récompense.
    const banner = textNodeWith(renderer, 'T’es hors ligne — voici les dernières infos connues, peut-être plus à jour.');
    expect(banner).toBeDefined();
    const card = banner!.parent!;
    expect(JSON.stringify((card.props as { style?: unknown }).style)).toContain(
      '"backgroundColor":"#F1F4F7"', // neutrals.lineSoft, scopé à la carte de la bannière
    );
  });
});

describe('Encres AA sur pastel (FiscalStatusPill)', () => {
  it('« À confirmer » est encré warningInk (5,25:1) — plus jamais l’ambre nu', async () => {
    const renderer = await render();
    const pill = textNodeWith(renderer, 'À confirmer');
    expect(pill).toBeDefined();
    expect(styleOf(pill!)).toContain(`"color":"${semantic.warningInk}"`);
  });

  it('« Confirmé ✓ » est encré successInk (6,99:1)', async () => {
    const renderer = await render();
    const pill = textNodeWith(renderer, 'Confirmé ✓');
    expect(pill).toBeDefined();
    expect(styleOf(pill!)).toContain(`"color":"${semantic.successInk}"`);
  });
});

describe('allSet — la récompense verte du profil complet', () => {
  it('carte successBg + texte successInk + coche (plus un bloc gris désactivé)', async () => {
    configure({ hasPending: false });
    const renderer = await render();
    const allSet = textNodeWith(renderer, 'Ton profil est complet, bravo.');
    expect(allSet).toBeDefined();
    expect(styleOf(allSet!)).toContain(`"color":"${semantic.successInk}"`);
    const check = renderer.root
      .findAllByType('Svg' as never)
      .find((node) => (node.props as { stroke?: string }).stroke === semantic.successInk);
    expect(check).toBeDefined();
  });

  it('des champs en attente ⇒ CTA Bob (variant ai) et PAS la carte verte', async () => {
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('profil est complet');
    expect(rendered).toContain('4'); // remainingCount interpolé dans le CTA
  });
});

describe('Canon typo & espace', () => {
  it('gouttière du contenu = spacing.gutter (20)', async () => {
    const renderer = await render();
    const scroll = renderer.root.findByType('ScrollView' as never);
    const container = JSON.stringify(
      (scroll.props as { contentContainerStyle: unknown }).contentContainerStyle,
    );
    expect(container).toContain(`"paddingHorizontal":${spacing.gutter}`);
  });

  it('la valeur de rangée est au cran body (14.5) et la source au cran meta (12) — zéro demi-taille ad hoc', async () => {
    const renderer = await render();
    const value = textNodeWith(renderer, 'VAL-legalForm');
    expect(value).toBeDefined();
    expect(styleOf(value!)).toContain('"fontSize":14.5');
    const source = textNodeWith(renderer, 'Source : ton SIRET · 01/2026');
    expect(source).toBeDefined();
    expect(styleOf(source!)).toContain('"fontSize":12');
    expect(styleOf(source!)).not.toContain('11.5');
  });
});
