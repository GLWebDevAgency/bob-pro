/**
 * COMPTABILITÉ — RENDU MULTI-ÉTATS (Lot 5) + GRAMMAIRE D'ERREUR EXÉCUTABLE :
 * · un ÉCHEC d'export FEC produit un Toast tone DANGER (croix #FADDD9 on-dark) — plus
 *   JAMAIS la coche verte sur un échec (le seul vrai mensonge visuel du lot) ;
 * · un succès de génération garde sa coche (tone success, #6EE7B7) ;
 * · les journaux portent leurs RÔLES dédiés (journal.achats → pastille #FBF0DF) — le code
 *   ne prononce plus « particulier » pour un journal d'achats ;
 * · l'en-tête d'écriture se lit en UNE phrase VoiceOver (référence, libellé, date, journal) ;
 * · rangée retour kit 44 pt. Fixtures relatives au présent — aucune date figée.
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
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles, absoluteFill: {} },
  Text: 'Text',
  View: 'View',
}));
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle',
  Path: 'Path',
  Rect: 'Rect',
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
const share = vi.hoisted(() => ({ shareFec: vi.fn(async () => 'unavailable' as const) }));
vi.mock('../../src/lib/share-fec', () => ({ shareFec: share.shareFec }));

const sources = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  exportFec: { value: {} as Record<string, unknown> },
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
  useExportFec: () => sources.exportFec.value,
}));

const { default: Comptabilite } = await import('../comptabilite');

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
const NOW = new Date();
const TODAY = isoOf(NOW);
const TODAY_FR = `${TODAY.slice(8, 10)}/${TODAY.slice(5, 7)}/${TODAY.slice(0, 4)}`;

/** Écriture d'ACHATS du mois courant — le rôle `journal.achats`, plus jamais 'particulier'. */
const PURCHASE_ENTRY = {
  id: 'e1',
  reference: 'AC-0001',
  label: 'Fournitures Brico',
  entryDate: TODAY,
  journal: 'purchases',
  sourceType: 'expense',
  lines: [
    { account: '606', label: 'Achats', debitCents: 12_000, creditCents: 0 },
    { account: '401', label: 'Fournisseur', debitCents: 0, creditCents: 12_000 },
  ],
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  sources.entitlement.value = { allowed: true, verified: true, loading: false, decision: null };
  sources.exportFec.value = { isPending: false, mutate: vi.fn() };
  sources.value = { entries: q({ data: [PURCHASE_ENTRY] }), ...over };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Comptabilite)));
  });
  return renderer;
}
const treeOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

function findByLabel(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('Pressable' as never)
    .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === label);
}

beforeEach(() => {
  configure();
});

describe('Grammaire d’erreur — le toast dit la vérité', () => {
  it('échec d’export FEC ⇒ Toast tone DANGER (croix #FADDD9 on-dark), jamais une coche', async () => {
    const mutate = vi.fn(
      (_input: unknown, opts: { onError: () => void; onSuccess: (out: unknown) => void }) =>
        opts.onError(),
    );
    sources.exportFec.value = { isPending: false, mutate };
    const renderer = await render();
    const exportCta = findByLabel(renderer, 'Exporter (FEC / comptable)');
    expect(exportCta).toBeDefined();
    await act(async () => {
      (exportCta!.props as { onPress: () => void }).onPress();
    });
    const rendered = treeOf(renderer);
    expect(rendered).toContain('L’export a raté'); // docs.exportError (pote)
    expect(rendered).toContain('"stroke":"#FADDD9"'); // ToneGlyph croix danger on-dark
    expect(rendered).not.toContain('"stroke":"#6EE7B7"'); // AUCUNE coche verte sur un échec
  });

  it('génération réussie (partage indisponible) ⇒ Toast tone SUCCESS (coche #6EE7B7)', async () => {
    const mutate = vi.fn(
      (_input: unknown, opts: { onError: () => void; onSuccess: (out: unknown) => void }) =>
        opts.onSuccess({ filename: 'FEC.txt', warnings: [] }),
    );
    sources.exportFec.value = { isPending: false, mutate };
    const renderer = await render();
    const exportCta = findByLabel(renderer, 'Exporter (FEC / comptable)');
    await act(async () => {
      (exportCta!.props as { onPress: () => void }).onPress();
    });
    const rendered = treeOf(renderer);
    expect(rendered).toContain('FEC.txt');
    expect(rendered).toContain('"stroke":"#6EE7B7"'); // coche success on-dark du kit
  });
});

describe('Rôles journaux dédiés — fin du recyclage des typologies client', () => {
  it('écriture d’achats ⇒ pastille au rôle journal.achats (#FBF0DF) + badge « Achats »', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('"backgroundColor":"#FBF0DF"'); // journal.achats.bg
    expect(rendered).toContain('Achats'); // compta.journalPurchases (pote)
  });

  it('l’en-tête d’écriture se lit en UNE phrase (référence, libellé, date, journal)', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain(
      JSON.stringify(`AC-0001. Fournitures Brico. ${TODAY_FR}. Achats.`).slice(1, -1),
    );
  });
});

describe('États de premier rang', () => {
  it('grand-livre vide ⇒ EmptyState voix de Bob (compta.empty)', async () => {
    configure({ entries: q({ data: [] }) });
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('AC-0001');
    expect(rendered).toContain('écriture'); // compta.empty parle des écritures à venir
  });

  it('échec de chargement ⇒ « Réessayer », aucun héros vert', async () => {
    configure({ entries: q({ isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('"#F0F7F3"'); // pas de matière monthReady sans données
  });
});

describe('Rangée retour kit — cible 44 pt', () => {
  it('le retour « Documents » est un StickyBackRow à minHeight 44 (était 34 ad hoc)', async () => {
    const renderer = await render();
    const back = findByLabel(renderer, 'Documents');
    expect(back).toBeDefined();
    const style = (back!.props as { style: unknown }).style;
    const resolved = JSON.stringify(typeof style === 'function' ? style({ pressed: false }) : style);
    expect(resolved).toContain('"minHeight":44');
  });
});
