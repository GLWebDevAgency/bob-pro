import 'react-native-gesture-handler';
import { useEffect, useState, type ReactNode } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { t } from '@bob/i18n';
import { ErrorRetry } from '@bob/ui';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
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
import { PushNotificationsBridge } from '../src/data/push';
import { ConfirmProvider } from '../src/components/ConfirmSheet';
import { GlobalBobAccess } from '../src/components/GlobalBobAccess';
import { AgentContextProvider, AgentSessionProvider } from '../src/agent';
import { QuoteDraftProvider } from '../src/quote-draft';
import { LoginScreen } from '../src/screens/LoginScreen';
import { PasswordRecoveryScreen } from '../src/screens/PasswordRecoveryScreen';
import { ProvisioningScreen } from '../src/screens/ProvisioningScreen';
import { BiometricGate } from '../src/screens/BiometricGate';
import { companyIdFromAppMetadata } from '../src/data/tenant-identity';
import { PASSWORD_RECOVERY_ROUTE } from '../src/auth-recovery/password-recovery';
import { useLegacyCatalogueProtection } from '../src/data/catalogue';

// Garde le splash NATIF visible pendant le chargement critique. L'appel au scope module est
// volontaire : exécuté avant que React puisse rendre une frame blanche.
void SplashScreen.preventAutoHideAsync();

/**
 * Migration device-scoped, indépendante du compte : retire l'ancienne clé globale en clair dès
 * le démarrage, uniquement après copie vérifiée dans le coffre. L'archive n'est attribuée à aucun
 * tenant et son état explicatif reste disponible sur l'écran Catalogue.
 */
function CatalogueLegacyProtectionBridge() {
  useLegacyCatalogueProtection();
  return null;
}

function AppReadyGate({ fontsReady, children }: { fontsReady: boolean; children: ReactNode }) {
  const { loading } = useAuth();
  const pathname = usePathname();
  const [hasPresentedApp, setHasPresentedApp] = useState(false);
  const recoveryLink = pathname === PASSWORD_RECOVERY_ROUTE;
  // Le formulaire de récupération peut s'afficher et vérifier sa preuve en parallèle du
  // bootstrap de session. Un getSession lent ne doit pas ajouter 8 secondes après le tap email.
  const ready = fontsReady && (!loading || recoveryLink);
  useEffect(() => {
    if (!ready || hasPresentedApp) return;
    // Le splash natif ne sert qu'au premier démarrage. Une nouvelle tentative d'auth après
    // affichage doit rester dans l'UI React (spinner/erreur), jamais revenir à une frame vide.
    setHasPresentedApp(true);
    void SplashScreen.hideAsync();
  }, [hasPresentedApp, ready]);
  return hasPresentedApp ? <>{children}</> : null;
}

/** Porte d'authentification : en mode connecté (Supabase configuré), exige une session. */
function AuthGate({ children }: { children: ReactNode }) {
  const { enabled, session, loading, initializationError, retryInitialization, passwordRecovery } =
    useAuth();
  const { colors, personality } = useTheme();
  const pathname = usePathname();
  // La récupération est volontairement hors du tenant/provisioning : le lien email constitue
  // la preuve éphémère, puis PasswordRecoveryScreen établit la session avant updateUser.
  // L'événement PASSWORD_RECOVERY ouvre le même écran même si le routeur n'a pas encore bougé.
  const isRecoveryRoute = pathname === PASSWORD_RECOVERY_ROUTE;
  if (isRecoveryRoute || passwordRecovery.phase !== 'idle') {
    return <PasswordRecoveryScreen />;
  }
  if (enabled && loading) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.bg,
        }}
      >
        <ActivityIndicator color={colors.ink800} />
      </View>
    );
  }
  if (enabled && initializationError) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          backgroundColor: colors.bg,
          paddingHorizontal: 18,
        }}
      >
        <ErrorRetry
          message={t('auth.bootstrapError', { personality })}
          onRetry={retryInitialization}
        />
      </View>
    );
  }
  if (enabled && !session) return <LoginScreen />;
  // C24b : session SANS tenant (app_metadata.company_id absent — compte neuf pas encore
  // provisionné) → l'app N'ENTRE PAS sur les tabs (tout endpoint tenant répondrait 403
  // PROVISIONING_REQUIRED). L'écran crée l'espace puis refreshSession : le JWT frais porte
  // company_id et ce même gate laisse passer naturellement.
  const companyId = enabled && session ? companyIdFromAppMetadata(session.user.app_metadata) : null;
  if (enabled && session && companyId === null) {
    return <ProvisioningScreen />;
  }
  // C24 : session persistée + opt-in biométrie → Face ID/Touch ID avant l'app (dégradé honnête).
  return <BiometricGate>{children}</BiometricGate>;
}

export default function RootLayout() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } }),
  );
  // Identité typographique du proto (tokens.fonts) — une famille par poids (Android).
  const [fontsLoaded, fontError] = useFonts({
    SchibstedGrotesk_700Bold,
    SchibstedGrotesk_800ExtraBold,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
  });
  // Une police corrompue ne doit jamais produire un écran blanc permanent : RN utilisera sa
  // police de secours, tandis que la télémétrie de build/QA remontera l'asset défectueux.
  const fontsReady = fontsLoaded || fontError !== null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <CatalogueLegacyProtectionBridge />
            <AuthProvider>
              <StatusBar style="light" />
              {/* C24 : le client data vit AU-DESSUS de la porte d'auth — l'inscription
                  (lookup SIRET public) en a besoin AVANT toute session. */}
              <BobClientProvider>
                <AppReadyGate fontsReady={fontsReady}>
                  {/* Racine durable : reste montée sur login/logout pour rejouer les tombstones
                      publics et invalider l'ancien owner avant tout nouveau tenant. */}
                  <PushNotificationsBridge />
                  <AuthGate>
                    <QuoteDraftProvider>
                      <AgentContextProvider>
                        <AgentSessionProvider>
                          <ConfirmProvider>
                            <Stack screenOptions={{ headerShown: false }}>
                              <Stack.Screen name="(tabs)" />
                              <Stack.Screen name="auth/recovery" />
                              <Stack.Screen name="devis/new" options={{ presentation: 'modal' }} />
                              <Stack.Screen name="devis/[id]" />
                              <Stack.Screen name="facture/[id]" />
                              <Stack.Screen name="client/[id]" />
                              <Stack.Screen name="compte" />
                              <Stack.Screen name="profil-fiscal" />
                              <Stack.Screen name="catalogue" />
                              <Stack.Screen name="reglages-facturation" />
                              <Stack.Screen name="diagnostic" />
                              <Stack.Screen name="notifications" />
                              <Stack.Screen name="onboarding" />
                              <Stack.Screen
                                name="scan-document"
                                options={{ presentation: 'modal' }}
                              />
                              <Stack.Screen name="documents/[id]" />
                              <Stack.Screen name="documents/folder/[id]" />
                              <Stack.Screen name="voix" options={{ presentation: 'modal' }} />
                              <Stack.Screen name="chantiers" />
                              <Stack.Screen name="chantier/[id]" />
                              <Stack.Screen name="ventes" />
                              <Stack.Screen name="comptabilite" />
                              <Stack.Screen name="cloture" />
                              <Stack.Screen name="pilotage" />
                            </Stack>
                            <GlobalBobAccess />
                          </ConfirmProvider>
                        </AgentSessionProvider>
                      </AgentContextProvider>
                    </QuoteDraftProvider>
                  </AuthGate>
                </AppReadyGate>
              </BobClientProvider>
            </AuthProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
