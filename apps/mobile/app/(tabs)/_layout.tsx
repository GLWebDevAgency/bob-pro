/**
 * Tabs — la BottomTabBar @bob/ui (pill flottante, COMPONENT_SPECS.md §14) remplace la
 * barre par défaut d'expo-router : fondu de fond, ombre e2, icônes exactes de la réf
 * (lever de soleil / personnes / portefeuille / dossier / étincelle), actif ink900,
 * Assistant actif indigo IA, inactif tabInactive.
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

const ITEMS: readonly BottomTabItem[] = [
  { key: 'index', label: "Aujourd'hui", icon: (s) => <SunriseIcon color={s.color} size={s.size} /> },
  { key: 'clients', label: 'Clients', icon: (s) => <PeopleIcon color={s.color} size={s.size} /> },
  { key: 'argent', label: 'Argent', icon: (s) => <WalletIcon color={s.color} size={s.size} /> },
  { key: 'documents', label: 'Documents', icon: (s) => <FolderIcon color={s.color} size={s.size} /> },
  { key: 'assistant', label: 'Assistant', icon: (s) => <SparkIcon color={s.color} size={s.size} /> },
];

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

function FloatingTabBar({ state, navigation }: TabBarSlotProps) {
  const insets = useSafeAreaInsets();
  const activeKey = state.routes[state.index]?.name ?? 'index';
  return (
    <BottomTabBar
      floating
      items={ITEMS}
      activeKey={activeKey}
      insetBottom={Math.max(insets.bottom, patterns.bottomTabBar.padding[2])}
      onSelect={(key) => {
        const route = state.routes.find((r) => r.name === key);
        if (!route) return;
        const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
        if (!event.defaultPrevented) navigation.navigate(route.name);
      }}
    />
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <FloatingTabBar {...(props as unknown as TabBarSlotProps)} />}
    >
      <Tabs.Screen name="index" options={{ title: "Aujourd'hui" }} />
      <Tabs.Screen name="clients" options={{ title: 'Clients' }} />
      <Tabs.Screen name="argent" options={{ title: 'Argent' }} />
      <Tabs.Screen name="documents" options={{ title: 'Documents' }} />
      <Tabs.Screen name="assistant" options={{ title: 'Assistant' }} />
    </Tabs>
  );
}
