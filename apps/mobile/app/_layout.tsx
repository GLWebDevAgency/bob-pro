import 'react-native-gesture-handler';
import { useState, type ReactNode } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { useURL } from 'expo-linking';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import {
  SchibstedGrotesk_700Bold,
  SchibstedGrotesk_800ExtraBold,
} from '@expo-google-fonts/schibsted-grotesk';
import {
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
} from '@expo-google-fonts/hanken-grotesk';
import { ThemeProvider, useTheme } from '../src/theme';
import { AuthProvider, useAuth } from '../src/data/auth';
import { BobClientProvider } from '../src/data/client';
import { ConfirmProvider } from '../src/components/ConfirmSheet';
import { LoginScreen } from '../src/screens/LoginScreen';

/** Porte d'authentification : en mode connecté (Supabase configuré), exige une session. */
function AuthGate({ children }: { children: ReactNode }) {
  const { enabled, session, loading } = useAuth();
  const { colors } = useTheme();
  const pathname = usePathname();
  const incomingUrl = useURL();
  // La galerie @bob/ui (claim C03) est un outil de design sans données : hors porte d'auth.
  // On teste aussi l'URL entrante : au boot par deep link, le Stack n'est pas encore monté
  // et pathname vaut encore '/', ce qui bloquerait la navigation vers la galerie.
  if (pathname === '/gallery' || (incomingUrl ?? '').includes('/gallery')) return <>{children}</>;
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
  // Identité typographique du proto (tokens.fonts) — une famille par poids (Android).
  const [fontsLoaded] = useFonts({
    SchibstedGrotesk_700Bold,
    SchibstedGrotesk_800ExtraBold,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
  });
  if (!fontsLoaded) return null;

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
                    <Stack.Screen name="comptabilite" />
                    <Stack.Screen name="cloture" />
                    <Stack.Screen name="gallery" />
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
