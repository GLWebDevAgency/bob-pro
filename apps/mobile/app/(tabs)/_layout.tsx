import { View } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../src/theme';
import { FAB } from '../../src/components/ui';

export default function TabsLayout() {
  const { theme, semantic, colors } = useTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: theme.ink2,
          tabBarInactiveTintColor: colors.slate300,
          tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line },
          tabBarLabelStyle: { fontSize: 11 },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{ title: "Aujourd'hui", tabBarIcon: ({ color, size }) => <Ionicons name="today-outline" color={color} size={size} /> }}
        />
        <Tabs.Screen
          name="clients"
          options={{ title: 'Clients', tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" color={color} size={size} /> }}
        />
        <Tabs.Screen
          name="argent"
          options={{ title: 'Argent', tabBarIcon: ({ color, size }) => <Ionicons name="wallet-outline" color={color} size={size} /> }}
        />
        <Tabs.Screen
          name="documents"
          options={{ title: 'Documents', tabBarIcon: ({ color, size }) => <Ionicons name="folder-outline" color={color} size={size} /> }}
        />
        <Tabs.Screen
          name="assistant"
          options={{
            title: 'Assistant',
            tabBarActiveTintColor: semantic.ai,
            tabBarIcon: ({ color, size }) => <Ionicons name="sparkles-outline" color={color} size={size} />,
          }}
        />
      </Tabs>
      <FAB onPress={() => router.push('/devis/new')} />
    </View>
  );
}
