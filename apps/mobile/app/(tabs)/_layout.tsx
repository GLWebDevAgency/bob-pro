/**
 * Tabs — la BottomTabBar @bob/ui (pill flottante, COMPONENT_SPECS.md §14) remplace la
 * barre par défaut d'expo-router : fondu de fond, ombre e2, icônes exactes de la réf
 * (lever de soleil / personnes / portefeuille / dossier / étincelle), actif ink900,
 * Assistant actif indigo IA, inactif tabInactive.
 *
 * ─── LA BARRE PORTÉE EST DERRIÈRE UN FLAG, ET ELLE EST ÉTEINTE ──────────────────────────
 * `mobile_tabs_experiment_v1` choisit entre la `BottomTabBar` LIVRÉE (défaut) et la `BobTabBar`
 * PORTÉE, qui rend les comportements normatifs de
 * [04 § Comportement normatif de la tab bar](../../../../docs/mobile-experience/04-navigation-scroll-surfaces.md).
 *
 * DEUX RAISONS, toutes deux écrites par le socle :
 *  · `PERF-13` exige la comparaison ON/OFF **sur le même commit** — sans flag, le protocole n'est
 *    pas exécutable, et sans protocole exécuté la barre portée n'est pas livrable, quel que soit
 *    son rendu à l'œil ;
 *  · c'est le levier de ROLLBACK nommé au § Owners : un seul indicateur hors seuil, le flag
 *    retombe et la barre livrée reprend la main sans migration à chaud.
 *
 * Les ROUTES ne changent pas d'une branche à l'autre : mêmes écrans, mêmes options. Ce qui change
 * sous le flag, ce sont les COMPORTEMENTS montés autour d'eux — et ils le sont RÉELLEMENT :
 *  · la barre portée à la place de la barre livrée ;
 *  · le FADE-THROUGH (comportement 5), monté par `screenLayout` autour de CHAQUE écran. C'est ce
 *    qui manquait : `BobTabSlotFade` existait, testé, et n'était monté par personne — donc jamais
 *    rendu, flag allumé ou non ;
 *  · le RETOUR EN HAUT au retap de l'onglet actif, l'un des points où le socle exige que Bob ne
 *    régresse pas vers la référence (§ Ce que la référence ne fait PAS) — SOUS DEUX CONDITIONS,
 *    et il faut les dire plutôt que d'annoncer un comportement universel : il faut que le flag
 *    soit allumé (hors flag, `TabScrollTopProvider` n'est pas monté et `useTabScrollTop` rend une
 *    fonction inerte) ET que l'écran focusé défile dans une `TabsScrollView`, ce qui est le cas
 *    de QUATRE écrans sur cinq. Sur `assistant`, comme hors flag, le retap ne fait RIEN — c'est
 *    le no-op de la référence, laissé en place là et seulement là.
 * Hors flag, l'arbre reste rigoureusement celui d'avant : aucun fournisseur, aucun enveloppeur.
 */
import { Tabs, useIsFocused } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import { patterns } from '@bob/tokens';
import { BottomTabBar, type BottomTabItem } from '@bob/ui';
import {
  FolderIcon,
  PeopleIcon,
  SparkIcon,
  SunriseIcon,
  WalletIcon,
} from '../../src/components/icons';
import { BobTabBar, type BobTabBarItem } from '../../src/components/bob-tab-bar';
import { tabHapticPort } from '../../src/components/bob-tab-bar-haptics';
import { TabBarMinimizeProvider } from '../../src/components/bob-tab-bar-minimize';
import { isMobileTabsExperimentEnabled } from '../../src/components/bob-tab-bar-flag';
import { BobTabSlotFade } from '../../src/components/bob-tab-slot';
import {
  TabSceneFocus,
  TabScrollTopProvider,
  useTabScrollTop,
} from '../../src/components/bob-tabs-scroll-view';

const ITEMS: readonly BottomTabItem[] = [
  { key: 'index', label: "Aujourd'hui", icon: (s) => <SunriseIcon color={s.color} size={s.size} /> },
  { key: 'clients', label: 'Clients', icon: (s) => <PeopleIcon color={s.color} size={s.size} /> },
  { key: 'argent', label: 'Argent', icon: (s) => <WalletIcon color={s.color} size={s.size} /> },
  { key: 'documents', label: 'Documents', icon: (s) => <FolderIcon color={s.color} size={s.size} /> },
  { key: 'assistant', label: 'Assistant', icon: (s) => <SparkIcon color={s.color} size={s.size} /> },
];

/** Mêmes clés, mêmes libellés, mêmes glyphes : la barre portée ne redessine aucune icône. */
const PORTED_ITEMS: readonly BobTabBarItem[] = ITEMS as readonly BobTabBarItem[];

/** Sous-ensemble structurel des props tabBar de react-navigation (pas de dépendance directe). */
interface TabBarSlotProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    emit: (e: {
      type: 'tabPress';
      target: string;
      canPreventDefault: true;
    }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
}

/**
 * Sélection commune aux deux barres : l'événement `tabPress` reste émis, et respecté.
 *
 * RETAP SUR L'ONGLET ACTIF → RETOUR EN HAUT. La référence laisse ce cas mort : `router.navigate`
 * sur la route courante est un no-op, et rien ne se passe. Le socle l'exige des deux côtés —
 * § Exigences communes (« retap sur l'onglet actif : retour en haut ») et le tableau « Ce que la
 * référence ne fait PAS ». On demande le retour en haut de la vue défilante FOCUSÉE — quand elle
 * s'est enregistrée, voir la réserve en tête de fichier — et on ne navigue PAS : naviguer vers là
 * où on est déjà réinitialiserait la pile de l'onglet, ce que le socle interdit explicitement
 * (« il ne modifie pas un formulaire en cours »). Cette seconde moitié, elle, ne connaît aucune
 * condition : le `return` est inconditionnel dès que la route re-tapée est la route courante.
 */
function useTabSelect({ state, navigation }: TabBarSlotProps): (key: string) => void {
  const scrollToTop = useTabScrollTop();
  return (key: string) => {
    const route = state.routes.find((r) => r.name === key);
    if (!route) return;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (event.defaultPrevented) return;
    if (state.routes[state.index]?.name === route.name) {
      scrollToTop();
      return;
    }
    navigation.navigate(route.name);
  };
}

function FloatingTabBar(props: TabBarSlotProps) {
  const { state } = props;
  const insets = useSafeAreaInsets();
  const activeKey = state.routes[state.index]?.name ?? 'index';
  const onSelect = useTabSelect(props);
  return (
    <BottomTabBar
      floating
      items={ITEMS}
      activeKey={activeKey}
      insetBottom={Math.max(insets.bottom, patterns.bottomTabBar.padding[2])}
      onSelect={onSelect}
    />
  );
}

function PortedTabBar(props: TabBarSlotProps) {
  const { state } = props;
  const activeKey = state.routes[state.index]?.name ?? 'index';
  const onSelect = useTabSelect(props);
  return (
    <BobTabBar
      items={PORTED_ITEMS}
      activeKey={activeKey}
      onSelect={onSelect}
      // Le port haptique rend `undefined` tant que `UX-ADR-006` est `Proposed` : pas de tick,
      // jamais d'erreur. Il est passé explicitement pour que le branchement soit une ligne.
      hapticPort={tabHapticPort()}
      testID="bob-tab-bar"
    />
  );
}

/**
 * COMPORTEMENT 5, RÉELLEMENT MONTÉ. `screenLayout` enveloppe le contenu de CHAQUE écran d'onglet
 * — c'est le point d'accroche prévu par le navigateur, et il ne touche aucun écran livré.
 * `useIsFocused` donne le focus de façon RÉACTIVE : `navigation.isFocused()` ne re-rendrait rien.
 */
function TabSceneFade({ children }: { readonly children: ReactNode }): ReactElement {
  const focused = useIsFocused();
  return (
    <BobTabSlotFade focused={focused} testID="bob-tab-slot">
      {/* Le focus descend jusqu'à la vue défilante : c'est ce qui désigne LA cible du retour en
          haut parmi cinq écrans montés en même temps. */}
      <TabSceneFocus focused={focused}>{children}</TabSceneFocus>
    </BobTabSlotFade>
  );
}

export default function TabsLayout() {
  const ported = isMobileTabsExperimentEnabled();
  const layout = (
    <Tabs
      screenOptions={{ headerShown: false }}
      // Le fade-through n'existe que dans la branche portée : hors flag, `screenLayout` est
      // absent et les écrans sont montés exactement comme avant, sans enveloppeur.
      {...(ported ? { screenLayout: ({ children }) => <TabSceneFade>{children}</TabSceneFade> } : {})}
      tabBar={(props) =>
        ported ? (
          <PortedTabBar {...(props as unknown as TabBarSlotProps)} />
        ) : (
          <FloatingTabBar {...(props as unknown as TabBarSlotProps)} />
        )
      }
    >
      <Tabs.Screen name="index" options={{ title: "Aujourd'hui" }} />
      <Tabs.Screen name="clients" options={{ title: 'Clients' }} />
      <Tabs.Screen name="argent" options={{ title: 'Argent' }} />
      <Tabs.Screen name="documents" options={{ title: 'Documents' }} />
      <Tabs.Screen name="assistant" options={{ title: 'Assistant' }} />
    </Tabs>
  );

  // Les deux fournisseurs ne sont montés QUE dans la branche portée : hors flag, l'arbre livré
  // reste rigoureusement le même — un composant de plus, c'est déjà un changement.
  return ported ? (
    <TabBarMinimizeProvider>
      <TabScrollTopProvider>{layout}</TabScrollTopProvider>
    </TabBarMinimizeProvider>
  ) : (
    layout
  );
}
