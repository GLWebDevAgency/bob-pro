/**
 * DIAGNOSTIC TECHNIQUE — RENDU MULTI-ÉTATS (vague hors-lots, audit 03/08) :
 * · journal PAS ENCORE LU ≠ journal vide : jamais « aucun échec enregistré » pendant la
 *   lecture async (bug « fausse collection vide », doctrine P0) ;
 * · statuts i18n (« sans réponse » / « HTTP {n} ») — plus de français codé en dur ;
 * · JournalRow accessible : le label composé est RÉELLEMENT exposé (accessible=true) ;
 * · purge via ConfirmSheet kit (challenge tap, destructive) — plus d'Alert.alert ;
 * · échec de partage → Toast tone danger (croix on-dark), jamais une coche verte ;
 * · anatomie : header HORS du scroll, gouttière 20, séparateurs lineSoft, refresh teinté.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { neutrals, spacing, surfaceTint } from '@bob/tokens';
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

const shareMock = vi.hoisted(() => ({ share: vi.fn<() => Promise<unknown>>() }));

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
  Share: shareMock,
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

const journal = vi.hoisted(() => ({
  entries: [] as unknown[],
  pending: false,
  cleared: false,
}));
vi.mock('../../src/data/error-journal', () => ({
  ERROR_JOURNAL_MAX_ENTRIES: 20,
  readJournal: () =>
    journal.pending ? new Promise<never>(() => {}) : Promise.resolve(journal.entries),
  clearJournal: () => {
    journal.cleared = true;
    journal.entries = [];
    return Promise.resolve();
  },
  journalEntryTime: () => '09:12',
  journalShareText: () => 'rapport sans PII',
}));
vi.mock('../../src/observability/crash-reporter', () => ({
  resolveCrashReporterConfig: () => null,
}));

const confirmState = vi.hoisted(() => ({
  accept: true,
  requests: [] as { title: string; destructive?: boolean; challenge: { kind: string } }[],
}));
vi.mock('../../src/components/ConfirmSheet', () => ({
  useConfirm:
    () =>
    (request: { title: string; destructive?: boolean; challenge: { kind: string } }) => {
      confirmState.requests.push(request);
      return Promise.resolve(confirmState.accept);
    },
}));

const { default: DiagnosticTechnique } = await import('../diagnostic-technique');

const ENTRY = {
  at: '2026-08-03T09:12:00.000Z',
  code: 'BOB-API-502',
  method: 'POST',
  path: '/invoices',
  status: 502,
  correlationId: '98f73810-aaaa-4bbb-8ccc-121212121212',
};
const ENTRY_NO_RESPONSE = {
  at: '2026-08-03T09:15:00.000Z',
  code: 'BOB-API-0',
  method: 'GET',
  path: '/notifications',
  status: null,
  correlationId: null,
};

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(DiagnosticTechnique)));
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

function findPressableByLabel(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('Pressable' as never)
    .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === label);
}

beforeEach(() => {
  journal.entries = [ENTRY, ENTRY_NO_RESPONSE];
  journal.pending = false;
  journal.cleared = false;
  confirmState.accept = true;
  confirmState.requests = [];
  shareMock.share.mockReset();
});

describe('Journal non lu ≠ journal vide (doctrine P0)', () => {
  it('pendant la lecture async : squelette, JAMAIS « aucun échec enregistré »', async () => {
    journal.pending = true;
    const rendered = treeOf(await render());
    // La copy du vide (les 3 tons contiennent « échec ... enregistré ») n'apparaît pas.
    expect(rendered).not.toContain('enregistré');
    // La silhouette de rangée est là (skeleton accessibilityElementsHidden).
    expect(rendered).toContain('"accessibilityElementsHidden":true');
    // Et les actions Partager/Vider n'existent pas encore.
    expect(rendered).not.toContain('Partager');
  });

  it('journal réellement vide (résolu) : la voix du vide apparaît', async () => {
    journal.entries = [];
    const rendered = treeOf(await render());
    expect(rendered).toContain('aucun échec technique enregistré');
  });
});

describe('Rangées du journal — i18n et a11y', () => {
  it('statuts via i18n : « HTTP 502 » et « sans réponse » rendus depuis les clés', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('HTTP 502');
    expect(rendered).toContain('sans réponse');
  });

  it('le label composé est porté par une View accessible=true (annonce fiable)', async () => {
    const renderer = await render();
    const row = renderer.root
      .findAllByType('View' as never)
      .find(
        (node) =>
          (node.props as { accessibilityLabel?: string }).accessibilityLabel ===
          'BOB-API-502, 09:12, POST /invoices, HTTP 502',
      );
    expect(row).toBeDefined();
    expect((row!.props as { accessible?: boolean }).accessible).toBe(true);
  });

  it('séparateur de rangée = lineSoft (scopé au nœud de la rangée)', async () => {
    const renderer = await render();
    const row = renderer.root
      .findAllByType('View' as never)
      .find((node) => (node.props as { accessible?: boolean }).accessible === true);
    const style = JSON.stringify((row!.props as { style: unknown }).style);
    expect(style).toContain(`"borderBottomColor":"${neutrals.lineSoft}"`);
  });
});

describe('Purge — ConfirmSheet kit, plus jamais Alert', () => {
  it('« Vider » passe par confirm({challenge: tap, destructive}) puis purge le journal', async () => {
    const renderer = await render();
    const clearBtn = findPressableByLabel(renderer, 'Vider');
    expect(clearBtn).toBeDefined();
    await act(async () => {
      (clearBtn!.props as { onPress: () => void }).onPress();
    });
    expect(confirmState.requests).toHaveLength(1);
    expect(confirmState.requests[0]!.challenge.kind).toBe('tap');
    expect(confirmState.requests[0]!.destructive).toBe(true);
    expect(journal.cleared).toBe(true);
  });

  it('refus de la confirmation ⇒ aucune purge', async () => {
    confirmState.accept = false;
    const renderer = await render();
    const clearBtn = findPressableByLabel(renderer, 'Vider');
    await act(async () => {
      (clearBtn!.props as { onPress: () => void }).onPress();
    });
    expect(journal.cleared).toBe(false);
  });
});

describe('Échec de partage — Toast danger, jamais une coche verte', () => {
  it('Share.share rejette ⇒ Toast tone danger (croix on-dark)', async () => {
    shareMock.share.mockRejectedValueOnce(new Error('indisponible'));
    const renderer = await render();
    const shareBtn = findPressableByLabel(renderer, 'Partager');
    await act(async () => {
      (shareBtn!.props as { onPress: () => void }).onPress();
    });
    // Le glyphe du tone danger est un Svg tracé avec l'encre danger on-dark certifiée.
    const glyph = renderer.root
      .findAllByType('Svg' as never)
      .find((node) => (node.props as { stroke?: string }).stroke === surfaceTint.dark.danger.ink);
    expect(glyph).toBeDefined();
    const rendered = treeOf(renderer);
    expect(rendered).toContain('partage'); // la copy d'échec est bien affichée
  });
});

describe('Anatomie — header fixe, gouttière 20, refresh teinté', () => {
  it('le retour n’est PAS un descendant du ScrollView (header hors scroll)', async () => {
    const renderer = await render();
    const scroll = renderer.root.findByType('ScrollView' as never);
    const backInScroll = scroll
      .findAllByType('Pressable' as never)
      .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Compte');
    expect(backInScroll).toBeUndefined();
    // Mais il existe bien à l'écran, hors du scroll (libellé = écran de destination).
    expect(findPressableByLabel(renderer, 'Compte')).toBeDefined();
  });

  it('gouttière du contenu = spacing.gutter (20) et refresh teinté ink800', async () => {
    const renderer = await render();
    const scroll = renderer.root.findByType('ScrollView' as never);
    const container = JSON.stringify(
      (scroll.props as { contentContainerStyle: unknown }).contentContainerStyle,
    );
    expect(container).toContain(`"paddingHorizontal":${spacing.gutter}`);
    const refresh = (
      scroll.props as { refreshControl: { props: { tintColor: string } } }
    ).refreshControl;
    expect(refresh.props.tintColor).toBe(neutrals.ink800);
  });
});
