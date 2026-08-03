/**
 * NOTIFICATIONS — RENDU MULTI-ÉTATS (vague hors-lots, audit 03/08) :
 * · grammaire d'erreur : Toast TONE success/danger (fin de la coche verte sur les échecs),
 *   échec d'ENVOI de relance et de « tout marquer lu » → ErrorSheet 2 faces (code + corrélation) ;
 * · doctrine des tons : le fil/les relances auto = canal 'ai' de Bob (fin de l'alias b2g),
 *   cordial → variant warning (pixel identique), neutre → neutral (plus jamais « B2B ») ;
 * · AA : bandeau MED = StatusStrip danger (encre foncée), pénalités/chrono/ligne planifiée
 *   en warningInk (l'ambre nu 3,4:1 échouait le petit texte) ;
 * · papa vocal : item du fil annoncé « titre, statut · date, non lue » — plus de
 *   accessibilityState.selected détourné ;
 * · un seul langage de pression (la carte conformité répondait plus au doigt) ;
 * · BackHeader kit + gouttière spacing.gutter (20).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { controls, semantic, spacing, surfaceTint } from '@bob/tokens';
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
    loop: () => ({ start: vi.fn(), stop: vi.fn() }),
    sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, in: (f: unknown) => f, quad: {}, cubic: {}, ease: {} },
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles, absoluteFill: {} },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  findNodeHandle: () => null,
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
  useFocusEffect: vi.fn(),
}));
vi.mock('../../src/agent', () => ({ usePublishAgentContext: vi.fn() }));
vi.mock('../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 150,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));
vi.mock('../../src/data/push-permission-events', () => ({
  parseAllowlistedPushRoute: () => null,
}));

const confirmState = vi.hoisted(() => ({ accept: true, requests: [] as unknown[] }));
vi.mock('../../src/components/ConfirmSheet', () => ({
  useConfirm: () => (request: unknown) => {
    confirmState.requests.push(request);
    return Promise.resolve(confirmState.accept);
  },
}));

const push = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/data/push', () => ({
  usePushPermissionConsent: () => push.value,
}));

const sources = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/data/hooks', () => ({
  useNotificationsFeed: () => sources.value['feed'],
  useMarkNotificationRead: () => sources.value['markRead'],
  useMarkNotificationsReadThrough: () => sources.value['markAllRead'],
  useSendRelance: () => sources.value['sendRelance'],
  useUnreadNotificationsPreview: () => sources.value['unreadPreview'],
}));

const { default: Notifications } = await import('../notifications');

const FEED_ITEM = {
  id: 'n1',
  title: 'Relance envoyée à Mairie de Lyon',
  status: 'done',
  readAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  route: null,
};
const DUE_CORDIAL = {
  invoiceId: 'i1',
  customerId: 'c1',
  customerName: 'Marc Dupont',
  docNumber: 'F-2026-001',
  amountCents: 125_000,
  daysLate: 5,
  tone: 'cordial',
  nextEscalationAt: null,
  penalties: null,
  prescription: null,
};
const SCHEDULED_CORDIAL = {
  invoiceId: 'i3',
  customerId: 'c3',
  customerName: 'Louise Bernard',
  docNumber: 'F-2026-003',
  amountCents: 80_000,
  daysLate: 2,
  tone: 'cordial',
  nextEscalationAt: '2026-08-10',
  penalties: { interestCents: 2_771, dailyCents: 62 },
  prescription: { urgency: 'a_surveiller', deadline: '2027-01-15' },
};
const UPCOMING = {
  invoiceId: 'i2',
  customerId: 'c2',
  customerName: 'Atelier Roux',
  docNumber: 'F-2026-002',
  amountCents: 50_000,
  inDays: 3,
};

function feedValue(over: Partial<Record<string, unknown>> = {}) {
  return {
    unreadCount: 1,
    isError: false,
    isLoading: false,
    isRefetching: false,
    refetch: vi.fn(),
    count: 1,
    items: [FEED_ITEM],
    due: [DUE_CORDIAL],
    scheduled: [SCHEDULED_CORDIAL],
    upcoming: [UPCOMING],
    conformite: true,
    ...over,
  };
}

function mutationDouble(over: Partial<Record<string, unknown>> = {}) {
  return { mutate: vi.fn(), isPending: false, variables: undefined, ...over };
}

function configure(over: Partial<Record<string, unknown>> = {}): void {
  push.value = { surface: 'hidden', state: { operation: 'idle' }, refreshSilently: vi.fn() };
  sources.value = {
    feed: feedValue(),
    markRead: mutationDouble(),
    markAllRead: mutationDouble(),
    sendRelance: mutationDouble(),
    unreadPreview: {
      data: { unreadCount: 1, throughCreatedAt: '2026-08-01T10:00:00.000Z' },
      isError: false,
      isFetching: false,
      refetch: vi.fn(async () => ({
        data: { unreadCount: 1, throughCreatedAt: '2026-08-01T10:00:00.000Z' },
        isError: false,
      })),
    },
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Notifications)));
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

function pressables(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('Pressable' as never);
}
function findByLabelStart(renderer: ReactTestRenderer, prefix: string) {
  return pressables(renderer).find((node) =>
    ((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').startsWith(prefix),
  );
}
function textNodeWith(renderer: ReactTestRenderer, content: string) {
  return renderer.root.findAllByType('Text' as never).find((node) => {
    const children = (node.props as { children?: unknown }).children;
    return children === content || (Array.isArray(children) && children.join('') === content);
  });
}
const styleOf = (node: { props: unknown }): string =>
  JSON.stringify((node.props as { style?: unknown }).style ?? null);

beforeEach(() => {
  confirmState.accept = true;
  confirmState.requests = [];
  nav.push.mockReset();
  configure();
});

describe('États de premier rang', () => {
  it('chargement (aucun snapshot) : squelettes, aucune section', async () => {
    configure({ feed: feedValue({ unreadCount: null, isLoading: true, items: [], due: [], scheduled: [], upcoming: [], conformite: false, count: 0 }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityElementsHidden":true');
    expect(rendered).not.toContain('Relances automatiques');
  });

  it('échec bloquant (aucun snapshot) : ErrorRetry seul, aucune carte fantôme', async () => {
    configure({ feed: feedValue({ unreadCount: null, isError: true, items: [], due: [], scheduled: [], upcoming: [], conformite: false, count: 0 }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('Marc Dupont');
  });

  it('stale (échec avec snapshot) : ErrorRetry + le fil reste rendu', async () => {
    configure({ feed: feedValue({ isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).toContain('Relance envoyée à Mairie de Lyon');
  });

  it('aucune actualité : la voix de Bob, zéro carte fantôme', async () => {
    configure({ feed: feedValue({ count: 0, items: [], due: [], scheduled: [], upcoming: [], conformite: false }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Rien à signaler — tout roule.');
  });
});

describe('Doctrine des tons — le canal de Bob est déclaré ai', () => {
  it('l’item du fil porte la tuile indigo AI (aiBg) et l’icône semantic.ai — plus d’alias b2g', async () => {
    const renderer = await render();
    const item = findByLabelStart(renderer, 'Relance envoyée à Mairie de Lyon');
    expect(item).toBeDefined();
    const tile = item!
      .findAllByType('View' as never)
      .find((node) => styleOf(node).includes(`"backgroundColor":"${semantic.aiBg}"`));
    expect(tile).toBeDefined();
    const icon = item!
      .findAllByType('Svg' as never)
      .find((node) => (node.props as { stroke?: string }).stroke === semantic.ai);
    expect(icon).toBeDefined();
  });

  it('la carte « Relances automatiques » est en canal ai (c’est Bob qui agit)', async () => {
    const renderer = await render();
    const title = textNodeWith(renderer, 'Relances automatiques');
    expect(title).toBeDefined();
    // La tuile de la même carte est aiBg — scopé à la carte (ancêtre commun le plus proche).
    const card = title!.parent!.parent!.parent!;
    const tile = card
      .findAllByType('View' as never)
      .find((node) => styleOf(node).includes(`"backgroundColor":"${semantic.aiBg}"`));
    expect(tile).toBeDefined();
  });

  it('ligne planifiée cordiale : encre warningInk (AA) — jamais l’ambre nu en petit texte', async () => {
    const renderer = await render();
    const line = textNodeWith(renderer, 'Cordial · le 10/08/2026');
    expect(line).toBeDefined();
    expect(styleOf(line!)).toContain(`"color":"${semantic.warningInk}"`);
  });

  it('pénalités courues + chrono a_surveiller : warningInk, pastille graphique reste warning', async () => {
    const renderer = await render();
    const rendered = treeOf(renderer);
    expect(rendered).toContain('27,71'); // pénalités chiffrées par le moteur
    const penalties = renderer.root
      .findAllByType('Text' as never)
      .find((node) => JSON.stringify((node.props as { children?: unknown }).children).includes('27,71'));
    expect(styleOf(penalties!)).toContain(`"color":"${semantic.warningInk}"`);
    const dot = renderer.root
      .findAllByType('View' as never)
      .find((node) => styleOf(node).includes(`"backgroundColor":"${semantic.warning}"`));
    expect(dot).toBeDefined(); // le point du chrono garde l'ambre vif (graphique ≥3:1)
  });
});

describe('Bandeau MED — StatusStrip danger AA', () => {
  it('le texte L441-10 est encré surfaceTint.light.danger.ink sur fond dangerBg', async () => {
    const renderer = await render();
    const med = textNodeWith(
      renderer,
      'La mise en demeure (L441-10 + indemnité 40 €) n’est jamais envoyée sans ta validation.',
    );
    expect(med).toBeDefined();
    expect(styleOf(med!)).toContain(`"color":"${surfaceTint.light.danger.ink}"`);
    expect(styleOf(med!.parent!)).toContain(`"backgroundColor":"${semantic.dangerBg}"`);
  });
});

describe('Grammaire d’erreur — tones et ErrorSheet', () => {
  it('échec du marquage lu d’un item ⇒ Toast tone danger (croix on-dark)', async () => {
    configure({
      markRead: mutationDouble({
        mutate: (_id: string, opts: { onError: (e: unknown) => void }) => opts.onError(new Error('ko')),
      }),
    });
    const renderer = await render();
    const item = findByLabelStart(renderer, 'Relance envoyée à Mairie de Lyon');
    await act(async () => {
      (item!.props as { onPress: () => void }).onPress();
    });
    const glyph = renderer.root
      .findAllByType('Svg' as never)
      .find((node) => (node.props as { stroke?: string }).stroke === surfaceTint.dark.danger.ink);
    expect(glyph).toBeDefined();
  });

  it('« Tout marquer lu » réussi ⇒ Toast tone success (coche successOnDark)', async () => {
    configure({
      markAllRead: mutationDouble({
        mutate: (_through: string, opts: { onSuccess: (r: { updatedCount: number }) => void }) =>
          opts.onSuccess({ updatedCount: 3 }),
      }),
    });
    const renderer = await render();
    const markAll = pressables(renderer).find((node) =>
      ((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').includes('non lue'),
    );
    expect(markAll).toBeDefined();
    await act(async () => {
      (markAll!.props as { onPress: () => void }).onPress();
    });
    expect(confirmState.requests.length).toBe(1);
    const glyph = renderer.root
      .findAllByType('Svg' as never)
      .find((node) => (node.props as { stroke?: string }).stroke === semantic.successOnDark);
    expect(glyph).toBeDefined();
  });

  it('échec de l’ENVOI de relance ⇒ ErrorSheet 2 faces avec code court et corrélation', async () => {
    configure({
      sendRelance: mutationDouble({
        mutate: (_id: string, opts: { onError: (e: unknown) => void }) =>
          opts.onError({
            kind: 'unavailable',
            code: 'BOB-API-503',
            correlationId: '98f73810-aaaa-4bbb-8ccc-121212121212',
          }),
      }),
    });
    const renderer = await render();
    const relancer = pressables(renderer).find(
      (node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Relancer',
    );
    expect(relancer).toBeDefined();
    await act(async () => {
      (relancer!.props as { onPress: () => void }).onPress();
    });
    const rendered = treeOf(renderer);
    expect(rendered).toContain('BOB-API-503'); // face développeur : code court
    expect(rendered).toContain('L’envoi a raté — réessaie dans un instant.'); // message actionnable
  });
});

describe('Papa vocal & langage de pression', () => {
  it('l’item non lu est annoncé « titre, statut · date, non lue » — sans selected détourné', async () => {
    const renderer = await render();
    const item = findByLabelStart(renderer, 'Relance envoyée à Mairie de Lyon');
    const props = item!.props as { accessibilityLabel: string; accessibilityState?: unknown };
    expect(props.accessibilityLabel).toContain('Envoyée · 01/08/2026');
    expect(props.accessibilityLabel).toContain('non lue');
    expect(props.accessibilityState).toBeUndefined();
  });

  it('la carte conformité répond au doigt (pressed 0.65) et son chevron est controls.chevron', async () => {
    const renderer = await render();
    const conformite = findByLabelStart(renderer, 'Conformité 2026');
    expect(conformite).toBeDefined();
    const style = (conformite!.props as { style: unknown }).style;
    expect(typeof style).toBe('function');
    const pressed = JSON.stringify((style as (s: { pressed: boolean }) => unknown)({ pressed: true }));
    expect(pressed).toContain('"opacity":0.65');
    const chevron = conformite!
      .findAllByType('Svg' as never)
      .find((node) => (node.props as { stroke?: string }).stroke === controls.chevron);
    expect(chevron).toBeDefined();
  });
});

describe('Anatomie — BackHeader kit et gouttière', () => {
  it('le retour est le BackHeader kit (« Fermer ») et le contenu est à spacing.gutter (20)', async () => {
    const renderer = await render();
    const back = pressables(renderer).find(
      (node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Fermer',
    );
    expect(back).toBeDefined();
    const scroll = renderer.root.findByType('ScrollView' as never);
    const container = JSON.stringify(
      (scroll.props as { contentContainerStyle: unknown }).contentContainerStyle,
    );
    expect(container).toContain(`"paddingHorizontal":${spacing.gutter}`);
  });
});
