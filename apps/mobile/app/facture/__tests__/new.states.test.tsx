/**
 * FACTURE/NEW (facture directe) — RENDU MULTI-ÉTATS (critères de preuve Lot 3).
 *
 * Ce que ce fichier verrouille :
 *  · CORRECTION du récap : chaque ligne remisée affiche son montant NET (même formule que
 *    l'étape 2) — la vérité visuelle SOMME vers le total (la confiance dans les chiffres
 *    est le produit) ;
 *  · la garde du wizard parle ErrorNotice (rôle alert porté par le composant, code
 *    BOB-API-422 du registre fermé) — plus un Text rouge perdu ;
 *  · borderWidth CONSTANT 2 sur la sélection client (fin du saut d'1 px) ;
 *  · titres d'étape sur le cran wizardTitle 24 (fin de screenH1+fontSize) ;
 *  · états de l'étape client : chargement / erreur / carnet vide.
 * NOTE : l'intervention « TTC dans la sticky » reste SUSPENDUE (GO fondateur non donné) —
 * aucune assertion ici ne l'exige.
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
  ActivityIndicator: 'ActivityIndicator',
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }) }),
    loop: () => ({ start: vi.fn(), stop: vi.fn() }),
    sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, quad: {}, cubic: {} },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o['ios'] ?? o['default'] },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
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
vi.mock('expo-router', () => ({ useRouter: () => nav }));

vi.mock('../../../src/components/ConfirmSheet', () => ({
  useConfirm: () => () => Promise.resolve(true),
}));
vi.mock('../../../src/data/catalogue', () => ({
  useCatalogue: () => ({ prestations: [] }),
}));

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../../src/data/hooks', () => ({
  appErrorMessage: (e: unknown) => `msg:${(e as Error).message}`,
  useCustomers: () => sources.value['customers'],
  useCompanyMe: () => sources.value['company'],
  useComposeStandaloneInvoice: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useChantiers: () => sources.value['chantiers'],
  useProfile: () => ({ data: undefined }),
}));

const { default: FactureDirecteNew } = await import('../new');

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

const DURAND = { id: 'c-durand', name: 'Mme Durand', type: 'b2c', siren: null, isInternational: false };

function configure(over: Partial<Record<string, unknown>> = {}): void {
  nav.replace.mockClear();
  sources.value = {
    customers: q({ data: [DURAND] }),
    company: q({ data: { vatRegime: 'normal' } }),
    chantiers: q({ data: [] }),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(FactureDirecteNew)));
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

async function press(renderer: ReactTestRenderer, label: string): Promise<void> {
  const node = renderer.root
    .findAllByType('Pressable' as never)
    .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === label);
  expect(node, `Pressable « ${label} » introuvable`).toBeDefined();
  await act(async () => {
    (node!.props as { onPress: () => void }).onPress();
  });
}

/** Pilote le wizard jusqu'au récap avec UNE ligne remisée (−10 %). */
async function driveToRecapWithDiscountedLine(renderer: ReactTestRenderer): Promise<void> {
  // Étape 1 : choisir Mme Durand + urgence « oui » (b2c → question obligatoire).
  await press(renderer, 'Mme Durand');
  await press(renderer, 'Oui, dépannage urgent');
  await press(renderer, 'Continuer');
  // Étape 2 : TVA standard, puis une ligne 100 € −10 %.
  await press(renderer, 'Taux normal — 20 %');
  const byLabel = (label: string) =>
    renderer.root
      .findAllByType('TextInput' as never)
      .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === label);
  await act(async () => {
    (byLabel('Prestation (ex. chauffe-eau 200 L posé)')!.props as { onChangeText: (v: string) => void }).onChangeText(
      'Dépannage chauffe-eau',
    );
  });
  await act(async () => {
    (byLabel('PU HT (€)')!.props as { onChangeText: (v: string) => void }).onChangeText('100');
  });
  await act(async () => {
    (byLabel('Remise')!.props as { onChangeText: (v: string) => void }).onChangeText('10');
  });
  await press(renderer, 'Ajouter la ligne');
  await press(renderer, 'Continuer');
}

beforeEach(() => {
  configure();
});

describe('Récap — le montant de ligne est NET (la vérité visuelle somme vers le total)', () => {
  it('ligne 100 € −10 % ⇒ le récap affiche 90,00 € (jamais 100,00 €) et le total TTC suit', async () => {
    const renderer = await render();
    await driveToRecapWithDiscountedLine(renderer);
    const rendered = treeOf(renderer);
    // LE témoin de la correction : la ZONE DES LIGNES (entre le libellé et le bloc des
    // totaux « Total HT avant remise ») porte le NET 90,00 € et JAMAIS le brut 100,00 € —
    // le brut barré reste, lui, DANS le bloc des totaux (B3, avant/après assumé).
    const lineIdx = rendered.indexOf('Dépannage chauffe-eau');
    const totalsIdx = rendered.indexOf('Total HT avant remise');
    expect(lineIdx).toBeGreaterThan(-1);
    expect(totalsIdx).toBeGreaterThan(lineIdx);
    const linesZone = rendered.slice(lineIdx, totalsIdx);
    expect(linesZone).toContain('90,00');
    expect(linesZone).not.toContain('100,00');
    // HT net + TVA 20 % → TTC 108,00 € : la colonne somme vers le total.
    expect(rendered).toContain('108,00');
  });

  it('titres d’étape sur le cran wizardTitle (24) — fin du screenH1 recomposé', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('"fontSize":24');
    expect(rendered).not.toContain('"fontSize":27'); // screenH1 n'apparaît plus en titre d'étape
  });

  it('sélection client : borderWidth CONSTANT 2 (fin du saut d’1 px)', async () => {
    const renderer = await render();
    const row = renderer.root
      .findAllByType('Pressable' as never)
      .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === 'Mme Durand');
    expect(JSON.stringify((row!.props as { style: unknown }).style)).toContain('"borderWidth":2');
  });
});

describe('Garde du wizard — ErrorNotice (rôle alert porté, code du registre fermé)', () => {
  it('« Continuer » sans client ⇒ ErrorNotice BOB-API-422 avec le message de garde', async () => {
    const renderer = await render();
    await press(renderer, 'Continuer');
    const rendered = treeOf(renderer);
    expect(rendered).toContain('"accessibilityRole":"alert"');
    expect(rendered).toContain('BOB-API-422');
  });
});

describe('États de l’étape client — chargement / erreur / carnet vide', () => {
  it('chargement ⇒ skeletons', async () => {
    configure({ customers: q({ isLoading: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityElementsHidden":true');
    expect(rendered).not.toContain('Mme Durand');
  });

  it('échec réseau ⇒ Réessayer, jamais une liste vide', async () => {
    configure({ customers: q({ isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('Mme Durand');
  });

  it('0 client ⇒ message d’invitation, pas une erreur', async () => {
    configure({ customers: q({ data: [] }) });
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('Réessayer');
    expect(rendered).not.toContain('Mme Durand');
  });
});
