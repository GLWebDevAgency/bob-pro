/**
 * CONTRAT/NEW — RENDU MULTI-ÉTATS (Lot 4, correction de comportement ASSUMÉE par le plan,
 * doctrine P0 « une source absente n'est jamais une collection vide ») :
 * · customers isPending ⇒ SkeletonRow ×3 — la liste ne se présente PAS comme vide ;
 * · customers isError  ⇒ ErrorRetry (« Impossible de charger le contrat — réessaie. »)
 *   avec retry branché ; JAMAIS un picker vide silencieux ;
 * · nominal ⇒ rangées radio (sélection ink + CheckIcon, arbitrage SÉLECTION).
 * Préférence motion NON RÉSOLUE pendant tout le fichier (fail-closed du kit).
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
  },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, quad: {}, cubic: {} },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
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

const hoisted = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: hoisted.push, back: hoisted.back, replace: hoisted.replace }),
  useLocalSearchParams: () => ({}),
}));
vi.mock('../../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 140,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../../src/data/hooks', () => ({
  appErrorMessage: (e: unknown) => String(e),
  useCustomers: () => sources.value['customers'],
  useChantiers: () => sources.value['chantiers'],
  useCreateMaintenanceContract: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

const { default: NouveauContrat } = await import('../new');

interface QueryDouble {
  data: unknown;
  isPending: boolean;
  isError: boolean;
  isRefetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
}
function q(over: Partial<QueryDouble> = {}): QueryDouble {
  return { data: undefined, isPending: false, isError: false, isRefetching: false, refetch: vi.fn(), ...over };
}

const PRO_CUSTOMER = { id: 'c1', name: 'SARL Martin', type: 'b2b' };
const B2C_CUSTOMER = { id: 'c2', name: 'Jean Dupont', type: 'b2c' };

function configure(over: Partial<Record<string, unknown>> = {}): void {
  sources.value = {
    customers: q({ data: [PRO_CUSTOMER, B2C_CUSTOMER] }),
    chantiers: q({ data: [] }),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(NouveauContrat)));
  });
  return renderer;
}

const treeOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

function radiosOf(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType('Pressable' as never)
    .filter((node) => (node.props as { accessibilityRole?: string }).accessibilityRole === 'radio');
}

beforeEach(() => {
  configure();
});

describe('ÉTATS MANQUANTS clients (le bug corrigé) — jamais une collection vide', () => {
  it('customers isPending ⇒ des skeletons, AUCUNE rangée client, AUCUNE erreur', async () => {
    configure({ customers: q({ isPending: true }) });
    const renderer = await render();
    // Le témoin des skeletons : chaque Skeleton se cache des lecteurs d'écran.
    expect(treeOf(renderer)).toContain('"accessibilityElementsHidden":true');
    // Seule la rangée « Aucun site » (section site, servie) reste radio — aucun client.
    expect(radiosOf(renderer).length).toBe(1);
    expect(treeOf(renderer)).not.toContain('Impossible de charger le contrat');
    expect(treeOf(renderer)).not.toContain('SARL Martin');
  });

  it('customers isError ⇒ ErrorRetry avec le message et un retry BRANCHÉ — pas un picker vide', async () => {
    const failing = q({ isError: true });
    configure({ customers: failing });
    const renderer = await render();
    const rendered = treeOf(renderer);
    expect(rendered).toContain('Impossible de charger le contrat — réessaie.'); // contrat.dataError (pote)
    expect(rendered).toContain('Réessayer');
    // Aucune rangée client — l'échec ne se déguise pas en carnet sans client pro.
    expect(rendered).not.toContain('SARL Martin');
    expect(radiosOf(renderer).length).toBe(1); // seule la rangée « Aucun site »

    const retry = renderer.root
      .findAllByType('Pressable' as never)
      .find((node) => {
        const label = (node.props as { accessibilityLabel?: string }).accessibilityLabel;
        return label === 'Réessayer';
      });
    expect(retry).toBeDefined();
    await act(async () => {
      (retry!.props as { onPress: () => void }).onPress();
    });
    expect(failing.refetch).toHaveBeenCalledTimes(1);
  });

  it('chantiers isError ⇒ ErrorRetry pour la section site, la liste clients reste servie', async () => {
    configure({ chantiers: q({ isError: true }) });
    const renderer = await render();
    const rendered = treeOf(renderer);
    expect(rendered).toContain('SARL Martin');
    expect(rendered).toContain('Impossible de charger le contrat — réessaie.');
  });
});

describe('NOMINAL — sélection ink (arbitrage : jamais successBg) et périmètre B2B/B2G', () => {
  it('les clients pro sont des rangées RADIO ; le b2c est filtré (loi Chatel)', async () => {
    const renderer = await render();
    const radios = radiosOf(renderer);
    // SARL Martin + « Aucun site » (chantiers vides → seule la rangée site-none).
    expect(radios.length).toBe(2);
    expect(treeOf(renderer)).toContain('SARL Martin');
    expect(treeOf(renderer)).not.toContain('Jean Dupont');
  });

  it('la rangée sélectionnée porte selected:true — l’état est ANNONCÉ, pas seulement peint', async () => {
    const renderer = await render();
    const martin = radiosOf(renderer).find(
      (node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'SARL Martin',
    );
    expect(martin).toBeDefined();
    await act(async () => {
      (martin!.props as { onPress: () => void }).onPress();
    });
    const selected = radiosOf(renderer).find(
      (node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'SARL Martin',
    );
    expect((selected!.props as { accessibilityState?: { selected?: boolean } }).accessibilityState?.selected).toBe(true);
  });

  it('le titre d’étape est un header (« Client & site » en section/700)', async () => {
    const renderer = await render();
    const headers = renderer.root
      .findAllByType('Text' as never)
      .filter((node) => (node.props as { accessibilityRole?: string }).accessibilityRole === 'header');
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.map((node) => JSON.stringify(node.children)).join(' ')).toContain('Client & site');
  });
});
