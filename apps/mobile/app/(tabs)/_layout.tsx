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
 * Le navigateur, lui, ne change PAS d'une branche à l'autre : ce sont les mêmes routes, les mêmes
 * écrans, les mêmes options. Seul le rendu de la barre change — et aucun écran livré n'est
 * touché, conformément à la borne de livraison n° 1.
 */
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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

/** Sélection commune aux deux barres : l'événement `tabPress` reste émis, et respecté. */
function useTabSelect({ state, navigation }: TabBarSlotProps): (key: string) => void {
  return (key: string) => {
    const route = state.routes.find((r) => r.name === key);
    if (!route) return;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!event.defaultPrevented) navigation.navigate(route.name);
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

export default function TabsLayout() {
  const ported = isMobileTabsExperimentEnabled();
  const layout = (
    <Tabs
      screenOptions={{ headerShown: false }}
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

  // Le fournisseur de repli n'est monté QUE dans la branche portée : hors flag, l'arbre livré
  // reste rigoureusement le même — un composant de plus, c'est déjà un changement.
  return ported ? <TabBarMinimizeProvider>{layout}</TabBarMinimizeProvider> : layout;
}
