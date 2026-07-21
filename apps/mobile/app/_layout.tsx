import 'react-native-gesture-handler';
import { useEffect, useState, type ReactNode } from 'react';
import { AppState, Platform, View, ActivityIndicator } from 'react-native';
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
import { EmailConfirmationScreen } from '../src/screens/EmailConfirmationScreen';
import { ProvisioningScreen } from '../src/screens/ProvisioningScreen';
import { BiometricGate } from '../src/screens/BiometricGate';
import { companyIdFromAppMetadata } from '../src/data/tenant-identity';
import {
  shouldRouteToProvisioning,
  useServerNoCompanySignal,
} from '../src/data/no-company-state';
import {
  queryRetryDelayMs,
  shouldRetryQueryFailure,
} from '../src/data/query-retry-policy';
import { connectFocusManagerToAppState } from '../src/data/query-focus';
import { PASSWORD_RECOVERY_ROUTE } from '../src/auth-recovery/password-recovery';
import { EMAIL_CONFIRMATION_ROUTE } from '../src/auth-confirmation/email-confirmation';
import { useLegacyCatalogueProtection } from '../src/data/catalogue';
import { MistralConversationCheckpointProvider } from '../src/realtime/mistral-conversation-checkpoint-provider';
import { authenticatedRuntimeBoundaryKey } from '../src/data/authenticated-runtime-boundary';
import { initCrashReporter } from '../src/observability/crash-reporter';
import { Observe, ObserveRoot } from 'expo-observe';

// Garde le splash NATIF visible pendant le chargement critique. L'appel au scope module est
// volontaire : exécuté avant que React puisse rendre une frame blanche.
void SplashScreen.preventAutoHideAsync();

// Crash reporting : au scope module, AVANT le premier rendu — un plantage au montage (comme
// celui observé sur l'écran profil fiscal) doit être capturé, pas manqué de quelques frames.
// DORMANT tant qu'aucun EXPO_PUBLIC_SENTRY_DSN région UE n'est fourni : dans ce cas rien n'est
// importé ni initialisé, et l'absence du flag ne casse aucun build.
void initCrashReporter();

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
  const recoveryLink =
    pathname === PASSWORD_RECOVERY_ROUTE || pathname === EMAIL_CONFIRMATION_ROUTE;
  // Les écrans « lien email » (récupération, confirmation d'inscription) peuvent s'afficher et
  // vérifier leur preuve en parallèle du bootstrap de session. Un getSession lent ne doit pas
  // ajouter 8 secondes après le tap email.
  const ready = fontsReady && (!loading || recoveryLink);
  useEffect(() => {
    if (!ready || hasPresentedApp) return;
    // Le splash natif ne sert qu'au premier démarrage. Une nouvelle tentative d'auth après
    // affichage doit rester dans l'UI React (spinner/erreur), jamais revenir à une frame vide.
    setHasPresentedApp(true);
    void SplashScreen.hideAsync();
    // EAS Observe — « Time to Interactive » : marqué EXACTEMENT quand l'app devient utilisable
    // (polices chargées + bootstrap de session terminé, splash retiré), jamais au montage du
    // module. Mesure de performance uniquement : temps, modèle d'appareil, version d'OS et
    // identifiant d'installation anonyme — aucune donnée client, aucun transcript.
    Observe.markInteractive();
  }, [hasPresentedApp, ready]);
  return hasPresentedApp ? <>{children}</> : null;
}

/** Porte d'authentification : en mode connecté (Supabase configuré), exige une session. */
function AuthGate({ children }: { children: ReactNode }) {
  const {
    enabled,
    session,
    loading,
    initializationError,
    retryInitialization,
    passwordRecovery,
    emailConfirmation,
  } = useAuth();
  const { colors, personality } = useTheme();
  const pathname = usePathname();
  // Bug device live : JWT valide AVEC company_id mais AUCUNE company en base (403 NO_COMPANY de
  // l'interceptor tenant — base réinitialisée / provisioning interrompu). Signal LIVE dérivé du
  // cache react-query : dès qu'une query le porte, l'app quitte les tabs pour l'onboarding.
  const serverReportsNoCompany = useServerNoCompanySignal();
  // La récupération est volontairement hors du tenant/provisioning : le lien email constitue
  // la preuve éphémère, puis PasswordRecoveryScreen établit la session avant updateUser.
  // L'événement PASSWORD_RECOVERY ouvre le même écran même si le routeur n'a pas encore bougé.
  const isRecoveryRoute = pathname === PASSWORD_RECOVERY_ROUTE;
  if (isRecoveryRoute || passwordRecovery.phase !== 'idle') {
    return <PasswordRecoveryScreen />;
  }
  // Confirmation d'inscription : même sortie de gate que la récupération — l'écran consomme le
  // deep link (`bobpro:///auth/callback`), échange la preuve PKCE puis laisse AuthGate entrer
  // naturellement une fois la session publiée.
  if (pathname === EMAIL_CONFIRMATION_ROUTE || emailConfirmation.phase !== 'idle') {
    return <EmailConfirmationScreen />;
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
  // PROVISIONING_REQUIRED). MÊME sortie quand le SERVEUR déclare le tenant sans company
  // (403 NO_COMPANY : company_id du JWT sans ligne en base) : session valide + company absente
  // tombe TOUJOURS sur l'onboarding, jamais sur des tabs en erreur. L'écran crée l'espace puis
  // refreshSession + purge des queries NO_COMPANY : ce même gate laisse passer naturellement.
  const companyId = enabled && session ? companyIdFromAppMetadata(session.user.app_metadata) : null;
  if (enabled && session && shouldRouteToProvisioning({ companyId, serverReportsNoCompany })) {
    return <ProvisioningScreen />;
  }
  const runtimeKey = enabled && session && companyId
    ? authenticatedRuntimeBoundaryKey({ subjectId: session.user.id, companyId })
    : 'local-runtime';
  // C24 : session persistée + opt-in biométrie → Face ID/Touch ID avant l'app (dégradé honnête).
  // Cette cle porte l'owner COMPLET. Un changement de tenant pour le meme subject doit demonter
  // AgentSession synchronement : une socket, un micro ou un transcript de A ne survit jamais dans B.
  return <BiometricGate key={runtimeKey}>{children}</BiometricGate>;
}

function RootLayout() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            // Politique UNIQUE (query-retry-policy) : 4xx/NO_COMPANY → zéro retry auto ;
            // réseau/5xx → retry borné (2) avec backoff plafonné. Le retry manuel reste.
            retry: shouldRetryQueryFailure,
            retryDelay: queryRetryDelayMs,
          },
        },
      }),
  );
  // Pont AppState → focusManager (doc TanStack « React Native ») : sans lui, React Query
  // reste « focused » pour toujours — refetchOnWindowFocus ne vit jamais et une invalidation
  // manquée n'est pas rattrapée au retour au premier plan (badge brouillon fantôme, terrain).
  // Le web garde les événements visibilitychange natifs de React Query.
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    return connectFocusManagerToAppState(AppState);
  }, []);
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
                <MistralConversationCheckpointProvider>
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
                                <Stack.Screen name="auth/callback" />
                                <Stack.Screen name="devis/new" options={{ presentation: 'modal' }} />
                                <Stack.Screen name="devis/[id]" />
                                <Stack.Screen name="facture/new" options={{ presentation: 'modal' }} />
                                <Stack.Screen name="facture/[id]" />
                                <Stack.Screen name="facture/transmission/[id]" />
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
                </MistralConversationCheckpointProvider>
              </BobClientProvider>
            </AuthProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * EAS Observe — mesure des performances RÉELLES sur l'appareil (démarrage à froid/chaud, premier
 * rendu, temps jusqu'à l'interactivité, chargement du bundle, et rendus par écran). Aucune donnée
 * personnelle : temps, modèle d'appareil, version d'OS, identifiant d'installation anonyme réinitialisé
 * à chaque réinstallation. Motivation directe : la boucle de rendu infinie du 20/07 a figé six écrans
 * sans lever la moindre erreur — invisible pour Sentry, criante pour une mesure de rendu.
 */
export default ObserveRoot.wrap(RootLayout);
