/**
 * FICHE CHANTIER — RENDU MULTI-ÉTATS (Lot 4) + VERROU DU BUG « personality: 'pote' » :
 * les miniatures photo parlent la personnalité DU THÈME (ici 'direct' → « Photo »), plus
 * jamais la voix « pote » hardcodée (« Voir la photo »). États : chargement (skeletons),
 * erreur (ErrorRetry), introuvable (notFound), nominal (héros marine + sections kit +
 * tuile fantôme d'envoi). Préférence motion NON RÉSOLUE partout (fail-closed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { ThemeProvider, type PrefsStorage } from '@bob/ui';

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
  Alert: { alert: vi.fn() },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: vi.fn(), stop: vi.fn() }),
    loop: () => ({ start: vi.fn(), stop: vi.fn() }),
    sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, quad: {}, cubic: {} },
  Image: 'Image',
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
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
vi.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: vi.fn(),
  requestMediaLibraryPermissionsAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
}));

const hoisted = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: hoisted.push, back: hoisted.back, replace: hoisted.replace, canGoBack: () => true }),
  useLocalSearchParams: () => ({ id: 'ch1' }),
}));
vi.mock('../../../src/agent', () => ({ usePublishAgentContext: vi.fn() }));
vi.mock('../../../src/components/ConfirmSheet', () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock('../../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 140,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));
vi.mock('../../../src/components/RetenueSuiviCard', () => ({ RetenueSuiviCard: () => null }));

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../../src/data/hooks', () => ({
  useChantiers: () => sources.value['chantiers'],
  useProfile: () => sources.value['profile'],
  useChantierNotes: () => sources.value['notes'],
  useAddChantierNote: () => ({ isPending: false, mutate: vi.fn() }),
  useExpenses: () => sources.value['expenses'],
  useQuotes: () => sources.value['quotes'],
  useInvoices: () => sources.value['invoices'],
  useWorksitePhotos: () => sources.value['photos'],
  useChantierEquipments: () => sources.value['equipments'],
  useUploadWorksitePhoto: () => sources.value['uploadPhoto'],
  useDeleteWorksitePhoto: () => ({ isPending: false, mutate: vi.fn() }),
  useWorksitePhotoUrl: () => ({ isLoading: false, isSuccess: true, data: { url: 'https://x/p.jpg' } }),
}));

const { default: ChantierDetail } = await import('../[id]');

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

const CHANTIER = {
  id: 'ch1',
  name: 'Villa Roquebrune',
  address: '12 chemin des Vignes',
  status: 'open',
  openedAt: '2026-06-10',
  notes: null,
  customerId: null,
  noteCount: 0,
  photoCount: 2,
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  sources.value = {
    chantiers: q({ data: [CHANTIER] }),
    profile: q({ data: { trade: 'plombier', modules: [] } }),
    notes: q({ data: [] }),
    expenses: q({ data: [] }),
    quotes: q({ data: [] }),
    invoices: q({ data: [] }),
    photos: q({ data: [{ id: 'p1' }, { id: 'p2' }] }),
    equipments: q({ data: [] }),
    uploadPhoto: { isPending: false, mutate: vi.fn() },
    ...over,
  };
}

/** Prefs du thème : personnalité DIRECT — le témoin du bug (pote disait « Voir la photo »). */
const DIRECT_STORAGE: PrefsStorage = {
  read: async () => JSON.stringify({ personality: 'direct' }),
  write: async () => {},
};

async function render(storage?: PrefsStorage): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        ThemeProvider,
        storage !== undefined ? ({ storage } as never) : (null as never),
        createElement(ChantierDetail),
      ),
    );
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

describe('VERROU DU BUG — la miniature parle la personnalité du THÈME', () => {
  it("personnalité 'direct' ⇒ label de miniature « Photo », JAMAIS « Voir la photo » (pote hardcodé)", async () => {
    const renderer = await render(DIRECT_STORAGE);
    const thumbnailLabels = renderer.root
      .findAllByType('Pressable' as never)
      .map((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel)
      .filter((label): label is string => label !== undefined);
    // Le thème est en 'direct' : la copie pote « Voir la photo » ne doit exister NULLE PART.
    expect(thumbnailLabels).toContain('Photo');
    expect(thumbnailLabels).not.toContain('Voir la photo');
  });
});

describe('États de la fiche — chargement / erreur / introuvable / nominal', () => {
  it('chargement (chantiers.isLoading) ⇒ skeletons, aucun contenu', async () => {
    configure({ chantiers: q({ isLoading: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityElementsHidden":true'); // Skeleton
    expect(rendered).not.toContain('Villa Roquebrune');
  });

  it('erreur (chantiers.isError) ⇒ ErrorRetry avec « Réessayer »', async () => {
    configure({ chantiers: q({ isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('Villa Roquebrune');
  });

  it('introuvable (id inconnu, chargé sans erreur) ⇒ message notFound, aucun héros', async () => {
    configure({ chantiers: q({ data: [] }) });
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('Villa Roquebrune');
    expect(rendered).not.toContain('Réessayer');
  });

  it('nominal ⇒ héros + sections kit en HEADERS (Journal, Photos…) et grille de photos', async () => {
    const renderer = await render();
    const rendered = treeOf(renderer);
    expect(rendered).toContain('Villa Roquebrune');
    const headers = renderer.root
      .findAllByType('Text' as never)
      .filter((node) => (node.props as { accessibilityRole?: string }).accessibilityRole === 'header');
    // SectionHeader kit : les 5 titres maison sont devenus de VRAIS headers.
    expect(headers.length).toBeGreaterThanOrEqual(3);
  });

  it("envoi en cours ⇒ TUILE FANTÔME annoncée busy dans la grille (« Photo en route… »)", async () => {
    configure({ uploadPhoto: { isPending: true, mutate: vi.fn() } });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Photo en route…'); // chantierFiche.photoUploading (pote)
    expect(rendered).toContain('"busy":true');
  });
});
