/**
 * LE POINT DE MONTAGE DES ONGLETS — le seul fichier du lot que RIEN ne regardait.
 *
 * ─── POURQUOI CE FICHIER EXISTE ─────────────────────────────────────────────────────────────
 * La liste `include` de `apps/mobile/vitest.config.ts` ne contenait que des chemins de `src/`.
 * Tout `apps/mobile/app/` — c'est-à-dire TOUS les points de montage d'expo-router — vivait donc
 * hors de toute suite : aucun test ne pouvait rougir, quelle que soit l'erreur de câblage. Une
 * revue par mutation l'a montré en chiffres : treize mutations appliquées à ce seul fichier de
 * montage ont toutes SURVÉCU, dont l'INVERSION du flag — la barre PORTÉE sortait quand le flag
 * était éteint, et la livrée quand il était allumé. Un lot qui sort la mauvaise barre selon le
 * flag est pire qu'un lot absent : la comparaison ON/OFF de `PERF-13` mesurerait exactement
 * l'inverse de ce qu'elle croit mesurer.
 *
 * ─── CE QUE CE FICHIER PROUVE, ET CE QU'IL NE PROUVE PAS ────────────────────────────────────
 * Il prouve le CÂBLAGE, et rien d'autre : quelle barre sort de quel bras du flag, quels
 * fournisseurs entourent le navigateur, ce que `screenLayout` enveloppe, ce que le retap fait et
 * ne fait pas. Les composants enfants sont remplacés par des DOUBLONS-HÔTES (`'PortedTabBar'`,
 * `'SlotFade'`, …) : leur comportement propre est prouvé par leurs propres suites
 * (`bob-tab-bar.test.tsx`, `bob-tab-slot.test.tsx`, `bob-tabs-scroll-view.test.tsx`). Ce fichier
 * ne rend donc AUCUN pixel et ne dit rien du rendu — c'est délibéré : le défaut qu'il traque est
 * un défaut de BRANCHEMENT, et un branchement se lit dans l'arbre, pas dans les styles.
 *
 * ─── POURQUOI IL EST DANS UN `__tests__/` ───────────────────────────────────────────────────
 * `expo-router` prend TOUT fichier `.ts/.tsx/.js/.jsx` d'`app/` pour une route. Le `blockList`
 * par défaut d'Expo écarte les `__tests__/` du bundle ; `src/lib/expo-router-bundle-guard.test.ts`
 * le vérifie plutôt que de le supposer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { patterns } from '@bob/tokens';

// ── Doublons ────────────────────────────────────────────────────────────────────────────────

interface NavigationState {
  index: number;
  routes: { key: string; name: string }[];
}

function freshState(): NavigationState {
  return {
    index: 1,
    routes: [
      { key: 'index-k', name: 'index' },
      { key: 'clients-k', name: 'clients' },
      { key: 'argent-k', name: 'argent' },
      { key: 'documents-k', name: 'documents' },
      { key: 'assistant-k', name: 'assistant' },
    ],
  };
}

const hoisted = vi.hoisted(() => ({
  /** Ce que rend le flag. C'est LUI qu'on bascule, jamais l'environnement du processus. */
  ported: { value: false },
  /** Ce que rend `useIsFocused()` pour la scène passée à `screenLayout`. */
  focused: { value: true },
  insetBottom: { value: 34 },
  /** Ce que rend `tabHapticPort()` — `undefined` est le rang normal du dépôt. */
  hapticPort: { value: undefined as unknown },
  /** Props RÉELLEMENT reçues par `<Tabs>`, un élément par rendu. */
  tabsProps: [] as Record<string, unknown>[],
  navigate: vi.fn<(name: string) => void>(),
  emit: vi.fn<(event: unknown) => { defaultPrevented: boolean }>(),
  scrollToTop: vi.fn<() => void>(),
  state: {
    value: {
      index: 1,
      routes: [
        { key: 'index-k', name: 'index' },
        { key: 'clients-k', name: 'clients' },
        { key: 'argent-k', name: 'argent' },
        { key: 'documents-k', name: 'documents' },
        { key: 'assistant-k', name: 'assistant' },
      ],
    } as NavigationState,
  },
}));

/**
 * `<Tabs>` d'expo-router, réduit à ce que le layout lui demande : il ENREGISTRE ses props, puis
 * rend les deux choses qu'on lui confie — la barre (`tabBar`) et une scène passée dans
 * `screenLayout` quand il y en a un. Sans ce second point, l'ABSENCE de `screenLayout` et son
 * INVERSION sous le flag seraient indiscernables.
 */
vi.mock('expo-router', async () => {
  const react = await import('react');
  const Tabs = (props: Record<string, unknown>): ReactElement => {
    hoisted.tabsProps.push(props);
    const scene = react.createElement('TabScene', { testID: 'scene' });
    const screenLayout = props['screenLayout'] as
      | ((options: { children: ReactElement }) => ReactElement)
      | undefined;
    const tabBar = props['tabBar'] as (bar: unknown) => ReactElement;
    return react.createElement(
      'TabsNavigator',
      null,
      react.createElement(
        'TabsSlot',
        null,
        screenLayout === undefined ? scene : screenLayout({ children: scene }),
      ),
      react.createElement(
        'TabsBar',
        null,
        tabBar({
          state: hoisted.state.value,
          navigation: { emit: hoisted.emit, navigate: hoisted.navigate },
        }),
      ),
      props['children'] as ReactElement,
    );
  };
  Tabs.Screen = 'TabScreen';
  return { Tabs, useIsFocused: () => hoisted.focused.value };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: hoisted.insetBottom.value, left: 0, right: 0 }),
}));

vi.mock('@bob/ui', () => ({ BottomTabBar: 'DeliveredTabBar' }));
vi.mock('../../../src/components/bob-tab-bar', () => ({ BobTabBar: 'PortedTabBar' }));
vi.mock('../../../src/components/bob-tab-slot', () => ({ BobTabSlotFade: 'SlotFade' }));
vi.mock('../../../src/components/bob-tab-bar-minimize', () => ({
  TabBarMinimizeProvider: 'MinimizeProvider',
}));
vi.mock('../../../src/components/bob-tabs-scroll-view', () => ({
  TabSceneFocus: 'SceneFocus',
  TabScrollTopProvider: 'ScrollTopProvider',
  useTabScrollTop: () => hoisted.scrollToTop,
}));
vi.mock('../../../src/components/bob-tab-bar-flag', () => ({
  isMobileTabsExperimentEnabled: () => hoisted.ported.value,
}));
vi.mock('../../../src/components/bob-tab-bar-haptics', () => ({
  tabHapticPort: () => hoisted.hapticPort.value,
}));
vi.mock('../../../src/components/icons', () => ({
  FolderIcon: 'FolderIcon',
  PeopleIcon: 'PeopleIcon',
  SparkIcon: 'SparkIcon',
  SunriseIcon: 'SunriseIcon',
  WalletIcon: 'WalletIcon',
}));

const { default: TabsLayout } = await import('../_layout');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Outillage d'arbre ───────────────────────────────────────────────────────────────────────

interface Harness {
  readonly renderer: ReactTestRenderer;
  /** Props de `<Tabs>` au dernier rendu. */
  readonly tabs: Record<string, unknown>;
}

async function mount(options: { ported?: boolean; focused?: boolean } = {}): Promise<Harness> {
  hoisted.tabsProps.length = 0;
  hoisted.ported.value = options.ported ?? false;
  hoisted.focused.value = options.focused ?? true;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<TabsLayout />);
  });
  const tree = renderer as ReactTestRenderer;
  const tabs = hoisted.tabsProps[hoisted.tabsProps.length - 1];
  expect(tabs, '`<Tabs>` n’a pas été rendu').toBeDefined();
  return { renderer: tree, tabs: tabs as Record<string, unknown> };
}

/** Tous les nœuds d'un type de doublon, dans l'ordre de l'arbre. */
function nodes(harness: Harness, type: string): Record<string, unknown>[] {
  return harness.renderer.root
    .findAllByType(type as never)
    .map((node) => node.props as Record<string, unknown>);
}

/** Le nœud UNIQUE d'un type — et l'unicité est vérifiée, jamais supposée. */
function only(harness: Harness, type: string): Record<string, unknown> {
  const found = nodes(harness, type);
  expect(found, `${type} : attendu exactement un nœud`).toHaveLength(1);
  return found[0] as Record<string, unknown>;
}

/** Combien de nœuds d'un type DESCENDENT d'un autre — c'est ainsi qu'on lit un emboîtement. */
function nested(harness: Harness, parent: string, child: string): number {
  return harness.renderer.root
    .findByType(parent as never)
    .findAllByType(child as never).length;
}

/** La barre rendue, quel que soit le bras : c'est elle qui porte `onSelect`. */
function bar(harness: Harness): Record<string, unknown> {
  const found = [...nodes(harness, 'PortedTabBar'), ...nodes(harness, 'DeliveredTabBar')];
  expect(found, 'attendu exactement UNE barre rendue').toHaveLength(1);
  return found[0] as Record<string, unknown>;
}

async function select(harness: Harness, key: string): Promise<void> {
  const onSelect = bar(harness)['onSelect'] as (key: string) => void;
  await act(async () => {
    onSelect(key);
  });
}

beforeEach(() => {
  hoisted.tabsProps.length = 0;
  hoisted.navigate.mockReset();
  hoisted.scrollToTop.mockReset();
  hoisted.emit.mockReset();
  hoisted.emit.mockReturnValue({ defaultPrevented: false });
  hoisted.hapticPort.value = undefined;
  hoisted.insetBottom.value = 34;
  hoisted.state.value = freshState();
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LE FLAG CHOISIT LA BARRE — ET DANS LE BON SENS
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('le flag choisit la barre, et dans le BON SENS', () => {
  it('ÉTEINT → la barre LIVRÉE, et la portée n’est nulle part', async () => {
    const harness = await mount({ ported: false });
    expect(nodes(harness, 'DeliveredTabBar')).toHaveLength(1);
    expect(nodes(harness, 'PortedTabBar')).toHaveLength(0);
  });

  it('ALLUMÉ → la barre PORTÉE, et la livrée n’est nulle part', async () => {
    const harness = await mount({ ported: true });
    expect(nodes(harness, 'PortedTabBar')).toHaveLength(1);
    expect(nodes(harness, 'DeliveredTabBar')).toHaveLength(0);
  });

  it('la barre portée porte son `testID` — c’est par lui que les suites de rendu la trouvent', async () => {
    expect(only(await mount({ ported: true }), 'PortedTabBar')['testID']).toBe('bob-tab-bar');
  });

  it('lui passe le port haptique tel que l’adaptateur le rend — absent aujourd’hui, branché demain', async () => {
    expect(only(await mount({ ported: true }), 'PortedTabBar')['hapticPort']).toBeUndefined();
    const sentinel = { tick: () => undefined };
    hoisted.hapticPort.value = sentinel;
    expect(only(await mount({ ported: true }), 'PortedTabBar')['hapticPort']).toBe(sentinel);
  });

  it('la barre LIVRÉE reste flottante et reçoit le retrait bas du socle', async () => {
    // `Math.max(inset bas, patterns.bottomTabBar.padding[2])` : 34 gagne sur 26…
    const withInset = only(await mount({ ported: false }), 'DeliveredTabBar');
    expect(withInset['floating']).toBe(true);
    expect(withInset['insetBottom']).toBe(34);
    // …et 26 gagne sur 0. Le 26 est le token LIVRÉ, pas un chiffre choisi ici.
    expect(patterns.bottomTabBar.padding[2]).toBe(26);
    hoisted.insetBottom.value = 0;
    expect(only(await mount({ ported: false }), 'DeliveredTabBar')['insetBottom']).toBe(26);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LES DEUX FOURNISSEURS — MONTÉS SOUS LE FLAG, ABSENTS HORS FLAG
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('les deux fournisseurs — sous le flag, et seulement là', () => {
  it('ALLUMÉ → `TabBarMinimizeProvider` PUIS `TabScrollTopProvider` entourent le navigateur', async () => {
    const harness = await mount({ ported: true });
    expect(nodes(harness, 'MinimizeProvider')).toHaveLength(1);
    expect(nodes(harness, 'ScrollTopProvider')).toHaveLength(1);
    // L'ORDRE compte, et il se lit par DESCENDANCE, pas par relecture du fichier : le registre
    // du retour en haut est SOUS le fournisseur de repli, et le navigateur sous les deux.
    expect(nested(harness, 'MinimizeProvider', 'ScrollTopProvider')).toBe(1);
    expect(nested(harness, 'ScrollTopProvider', 'TabsNavigator')).toBe(1);
  });

  it('ÉTEINT → AUCUN fournisseur : l’arbre livré est rigoureusement celui d’avant', async () => {
    const harness = await mount({ ported: false });
    expect(nodes(harness, 'MinimizeProvider')).toHaveLength(0);
    expect(nodes(harness, 'ScrollTopProvider')).toHaveLength(0);
    // Et le navigateur est rendu quand même — « aucun fournisseur » n'est pas « rien ».
    expect(nodes(harness, 'TabsNavigator')).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// COMPORTEMENT 5 — `screenLayout` N'EXISTE QUE DANS LE BRAS PORTÉ
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('5 · le fade-through est monté par `screenLayout`, sous le flag et seulement là', () => {
  it('ALLUMÉ → `screenLayout` est passé, et il enveloppe la scène de `BobTabSlotFade`', async () => {
    const harness = await mount({ ported: true });
    expect(typeof harness.tabs['screenLayout']).toBe('function');
    expect(only(harness, 'SlotFade')['testID']).toBe('bob-tab-slot');
    // La scène est bien DEDANS : un enveloppeur qui ne contient pas l'écran n'enveloppe rien.
    expect(nested(harness, 'SlotFade', 'TabScene')).toBe(1);
  });

  it('ÉTEINT → la prop `screenLayout` est ABSENTE, et rien n’enveloppe la scène', async () => {
    const harness = await mount({ ported: false });
    expect('screenLayout' in harness.tabs).toBe(false);
    expect(nodes(harness, 'SlotFade')).toHaveLength(0);
    expect(nodes(harness, 'SceneFocus')).toHaveLength(0);
    // La scène, elle, est toujours rendue : c'est l'enveloppeur qui manque, pas l'écran.
    expect(nodes(harness, 'TabScene')).toHaveLength(1);
  });

  it('le focus DESCEND jusqu’à `TabSceneFocus` — sans quoi les CINQ écrans se croient focusés', async () => {
    const focused = await mount({ ported: true, focused: true });
    expect(only(focused, 'SlotFade')['focused']).toBe(true);
    expect(only(focused, 'SceneFocus')['focused']).toBe(true);

    const blurred = await mount({ ported: true, focused: false });
    expect(only(blurred, 'SlotFade')['focused']).toBe(false);
    expect(only(blurred, 'SceneFocus')['focused']).toBe(false);
  });

  it('`TabSceneFocus` est DANS le fondu, et l’écran est DANS `TabSceneFocus`', async () => {
    const harness = await mount({ ported: true });
    expect(nested(harness, 'SlotFade', 'SceneFocus')).toBe(1);
    expect(nested(harness, 'SceneFocus', 'TabScene')).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LA SÉLECTION — COMMUNE AUX DEUX BARRES
// ════════════════════════════════════════════════════════════════════════════════════════════

describe.each([
  ['portée', true],
  ['livrée', false],
] as const)('la sélection, barre %s', (_label, ported) => {
  it('RETAP sur l’onglet actif → retour en haut, et AUCUNE navigation', async () => {
    // La route active est `clients` (index 1). Naviguer vers là où l'on est déjà
    // RÉINITIALISERAIT la pile de l'onglet, ce que le socle interdit explicitement.
    const harness = await mount({ ported });
    await select(harness, 'clients');
    expect(hoisted.scrollToTop).toHaveBeenCalledTimes(1);
    expect(hoisted.navigate).not.toHaveBeenCalled();
  });

  it('tap sur un AUTRE onglet → navigation, et aucun retour en haut', async () => {
    const harness = await mount({ ported });
    await select(harness, 'argent');
    expect(hoisted.navigate).toHaveBeenCalledTimes(1);
    expect(hoisted.navigate).toHaveBeenCalledWith('argent');
    expect(hoisted.scrollToTop).not.toHaveBeenCalled();
  });

  it('émet `tabPress` sur la CLÉ de route, annulable — et RESPECTE l’annulation', async () => {
    const harness = await mount({ ported });
    await select(harness, 'argent');
    expect(hoisted.emit).toHaveBeenCalledTimes(1);
    expect(hoisted.emit).toHaveBeenCalledWith({
      type: 'tabPress',
      target: 'argent-k',
      canPreventDefault: true,
    });

    hoisted.navigate.mockReset();
    hoisted.scrollToTop.mockReset();
    hoisted.emit.mockReturnValue({ defaultPrevented: true });
    await select(harness, 'argent');
    expect(hoisted.navigate).not.toHaveBeenCalled();
    // L'annulation coupe AUSSI le retour en haut : un écran qui refuse le `tabPress` ne se fait
    // pas remonter dans son dos.
    await select(harness, 'clients');
    expect(hoisted.scrollToTop).not.toHaveBeenCalled();
  });

  it('une clé INCONNUE ne fait rien — pas même émettre', async () => {
    const harness = await mount({ ported });
    await select(harness, 'reglages');
    expect(hoisted.emit).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
    expect(hoisted.scrollToTop).not.toHaveBeenCalled();
  });

  it('l’onglet ACTIF est celui de l’état, et `index` sert de repli hors bornes', async () => {
    hoisted.state.value = { ...freshState(), index: 2 };
    expect(bar(await mount({ ported }))['activeKey']).toBe('argent');
    hoisted.state.value = { ...freshState(), index: 9 };
    expect(bar(await mount({ ported }))['activeKey']).toBe('index');
  });

  it('porte les CINQ destinations, mêmes clés et mêmes libellés dans les deux bras', async () => {
    const items = bar(await mount({ ported }))['items'] as { key: string; label: string }[];
    expect(items.map((item) => item.key)).toEqual([
      'index',
      'clients',
      'argent',
      'documents',
      'assistant',
    ]);
    expect(items.map((item) => item.label)).toEqual([
      'Aujourd’hui',
      'Clients',
      'Argent',
      'Documents',
      'Assistant',
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LES ROUTES NE CHANGENT PAS D'UN BRAS À L'AUTRE
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('les routes ne changent pas d’un bras à l’autre', () => {
  it.each([
    ['portée', true],
    ['livrée', false],
  ] as const)(
    'barre %s : les cinq écrans, mêmes noms, mêmes titres, même ordre',
    async (_label, ported) => {
      const harness = await mount({ ported });
      const screens = nodes(harness, 'TabScreen').map((props) => ({
        name: props['name'],
        title: (props['options'] as { title: string }).title,
      }));
      expect(screens).toEqual([
        { name: 'index', title: 'Aujourd’hui' },
        { name: 'clients', title: 'Clients' },
        { name: 'argent', title: 'Argent' },
        { name: 'documents', title: 'Documents' },
        { name: 'assistant', title: 'Assistant' },
      ]);
      expect(harness.tabs['screenOptions']).toEqual({ headerShown: false });
    },
  );
});
