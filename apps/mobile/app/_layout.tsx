import 'react-native-gesture-handler';
import { useState, type ReactNode } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from '../src/theme';
import { AuthProvider, useAuth } from '../src/data/auth';
import { BobClientProvider } from '../src/data/client';
import { ConfirmProvider } from '../src/components/ConfirmSheet';
import { LoginScreen } from '../src/screens/LoginScreen';

/** Porte d'authentification : en mode connecté (Supabase configuré), exige une session. */
function AuthGate({ children }: { children: ReactNode }) {
  const { enabled, session, loading } = useAuth();
  const { colors } = useTheme();
  if (enabled && loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.ink800} />
      </View>
    );
  }
  if (enabled && !session) return <LoginScreen />;
  return <>{children}</>;
}

export default function RootLayout() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } }),
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <AuthProvider>
              <StatusBar style="light" />
              <AuthGate>
                <BobClientProvider>
                  <ConfirmProvider>
                  <Stack screenOptions={{ headerShown: false }}>
                    <Stack.Screen name="(tabs)" />
                    <Stack.Screen name="devis/new" options={{ presentation: 'modal' }} />
                    <Stack.Screen name="devis/[id]" />
                    <Stack.Screen name="facture/[id]" />
                    <Stack.Screen name="client/[id]" />
                    <Stack.Screen name="compte" />
                    <Stack.Screen name="diagnostic" />
                    <Stack.Screen name="onboarding" />
                    <Stack.Screen name="scan-document" options={{ presentation: 'modal' }} />
                    <Stack.Screen name="chantiers" />
                    <Stack.Screen name="ventes" />
                  </Stack>
                  </ConfirmProvider>
                </BobClientProvider>
              </AuthGate>
            </AuthProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
