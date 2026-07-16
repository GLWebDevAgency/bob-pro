import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useRouter, type Href } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth';
import { useBobClient } from './client';
import { registerBeforeSignOutCleanup } from './session-cleanup';
import { PushResponseDispatcher, installPushEventBridge } from './push-permission-events';
import {
  deriveSecurePushOwnerKey,
  getSecurePushInstallationStore,
} from './push-installation-secure-store';
import { PushInstallationRuntime } from './push-installation-runtime';
import { companyIdFromAppMetadata } from './tenant-identity';
import {
  PushPermissionCoordinator,
  derivePushConsentSurface,
  shouldRevokePushBindingForPermission,
  type PushConsentOutcome,
  type PushConsentSurface,
  type PushPermissionState,
  type PushPlatform,
} from './push-permission';

/** Métadonnée UX versionnée uniquement. Le token Expo n'est jamais persisté sur le mobile. */
const PUSH_PRIMER_DISMISSED_KEY = '@bob/push-consent/v1/primer-dismissed';
const responseDispatcher = new PushResponseDispatcher();
const pushRuntime = new PushInstallationRuntime({
  store: getSecurePushInstallationStore(),
  log: (message) => console.info(`[push] ${message}`),
});

// Politique premier plan explicite : bannière utile, centre de notifications, sans son ni badge
// inventé. Le listener du bridge rafraîchit en parallèle le fil in-app autoritatif.
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const decision = await pushRuntime
        .matchPayload(notification.request.content.data)
        .catch(() => 'not_ready' as const);
      const accepted = decision === 'matched';
      return {
        shouldShowBanner: accepted,
        shouldShowList: accepted,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    },
  });
}

let activeOwnerContext: {
  ownerKey: string;
  client: ReturnType<typeof useBobClient>;
} | null = null;

function nativePlatform(): PushPlatform {
  if (Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web')
    return Platform.OS;
  return 'web';
}

function easProjectId(): string | undefined {
  const constants = Constants as typeof Constants & { easConfig?: { projectId?: string } };
  return (
    constants.easConfig?.projectId ??
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId
  );
}

const pushPermission = new PushPermissionCoordinator({
  platform: nativePlatform(),
  getPermission: () => Notifications.getPermissionsAsync(),
  requestPermission: () =>
    Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    }),
  ensureAndroidChannel: async () => {
    if (Platform.OS !== 'android') return;
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Alertes Bob',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  },
  getAndroidChannelEnabled: async () => {
    if (Platform.OS !== 'android') return null;
    const channel = await Notifications.getNotificationChannelAsync('default');
    return channel === null ? null : channel.importance !== Notifications.AndroidImportance.NONE;
  },
  getExpoPushToken: async () => {
    const projectId = easProjectId();
    const token = await Notifications.getExpoPushTokenAsync(
      projectId === undefined ? {} : { projectId },
    );
    return token.data;
  },
  registerDevice: async (expoPushToken, platform) => {
    await pushRuntime.registerCurrent(expoPushToken, platform);
  },
  unregisterDevice: async () => {
    const captured = activeOwnerContext;
    if (captured === null) return;
    await pushRuntime.revokeOwnerAuthenticated(captured.ownerKey, captured.client);
  },
  openSystemSettings: async () => {
    const packageName = Constants.expoConfig?.android?.package;
    if (Platform.OS === 'android' && packageName !== undefined) {
      try {
        await Linking.sendIntent('android.settings.APP_NOTIFICATION_SETTINGS', [
          { key: 'android.provider.extra.APP_PACKAGE', value: packageName },
        ]);
        return;
      } catch {
        // Certains constructeurs filtrent l'intent précis : les réglages de l'app restent
        // toujours un fallback explicite et récupérable.
      }
    }
    await Linking.openSettings();
  },
  now: () => Date.now(),
  preferenceStore: {
    readDismissed: async () =>
      (await AsyncStorage.getItem(PUSH_PRIMER_DISMISSED_KEY)) === 'dismissed',
    writeDismissed: () => AsyncStorage.setItem(PUSH_PRIMER_DISMISSED_KEY, 'dismissed'),
  },
  log: (message, error) => {
    const detail = error instanceof Error ? error.message : 'erreur inconnue';
    console.info(`[push] ${message} — ${detail}`);
  },
});

export interface PushPermissionConsent {
  readonly state: PushPermissionState;
  readonly surface: PushConsentSurface;
  readonly requestFromUser: () => Promise<PushConsentOutcome>;
  readonly dismissPrimer: () => Promise<PushConsentOutcome>;
  readonly openSettingsFromUser: () => Promise<PushConsentOutcome>;
  readonly retryFromUser: () => Promise<PushConsentOutcome>;
  readonly refreshSilently: () => Promise<PushPermissionState>;
}

const PUSH_PERMISSION_ACTIONS = {
  requestFromUser: () => pushPermission.requestFromUser(),
  dismissPrimer: () => pushPermission.dismissPrimer(),
  openSettingsFromUser: () => pushPermission.openSettingsFromUser(),
  retryFromUser: () => pushPermission.retryFromUser(),
  refreshSilently: () => pushPermission.refreshSilently(),
} as const;

/** État partagé avec l'écran Notifications, sans coupler la politique pure à React/Expo. */
export function usePushPermissionConsent(): PushPermissionConsent {
  const state = useSyncExternalStore(
    pushPermission.subscribe,
    pushPermission.getSnapshot,
    pushPermission.getSnapshot,
  );
  return {
    state,
    surface: derivePushConsentSurface(state),
    ...PUSH_PERMISSION_ACTIONS,
  };
}

/**
 * Pont push racine — aucune UI et surtout aucun prompt au boot.
 *
 * - si l'OS avait déjà autorisé les notifications : canal Android → token → serveur ;
 * - sinon : simple observation, l'app reste entièrement fonctionnelle ;
 * - au retour des réglages système : resynchronisation silencieuse ;
 * - au tap d'une notification : deep link serveur historique inchangé.
 */
export function PushNotificationsBridge() {
  const client = useBobClient();
  const { enabled: authEnabled, session } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [eventBridgeReady, setEventBridgeReady] = useState(false);
  const authenticatedCompanyId = companyIdFromAppMetadata(session?.user.app_metadata);
  const ownerCompanyId = authEnabled ? authenticatedCompanyId : client.companyId;
  const ownerUserId = authEnabled ? (session?.user.id ?? null) : 'local-demo-device';

  useEffect(() => {
    let mounted = true;
    let unregisterSignOutCleanup: (() => void) | null = null;
    let appStateSubscription: { remove(): void } | null = null;
    // Barrière synchrone : pendant le hash d'identité, aucun payload de l'owner précédent ne
    // peut être affiché ni navigué. Cette transition ne touche pas encore au SecureStore.
    const ownerTransition = Platform.OS === 'web' ? null : pushRuntime.beginOwnerTransition(client);
    setEventBridgeReady(false);
    activeOwnerContext = null;
    // Ferme également les POST du coordinateur pendant le hash et la lecture SecureStore.
    pushPermission.setRegistrationContext(null);

    const revokeIfPermissionAuthoritativelyDisabled = async (
      ownerKey: string | null,
      state: PushPermissionState,
    ): Promise<void> => {
      if (
        ownerKey === null ||
        ownerTransition === null ||
        !shouldRevokePushBindingForPermission(state) ||
        !mounted ||
        !pushRuntime.isTransitionCurrent(ownerTransition, ownerKey)
      )
        return;
      const locallyNeutralized = await pushRuntime
        .revokeTransitionOwnerAuthenticated(ownerTransition, ownerKey)
        .catch(() => false);
      if (
        !locallyNeutralized ||
        !mounted ||
        !pushRuntime.isTransitionCurrent(ownerTransition, ownerKey)
      )
        return;
      pushPermission.invalidateRegistrationAfterRevocation(ownerKey);
    };

    void (async () => {
      if (Platform.OS === 'web') {
        await pushPermission.bootstrapSilently();
        return;
      }
      if (ownerTransition === null) return;
      const ownerKey =
        ownerCompanyId !== null && ownerUserId !== null
          ? await deriveSecurePushOwnerKey(ownerCompanyId, ownerUserId)
          : null;
      if (!mounted || !pushRuntime.isTransitionCurrent(ownerTransition)) return;
      const reconciled = await pushRuntime.completeOwnerTransition(ownerTransition, ownerKey);
      if (!mounted || !reconciled || !pushRuntime.isTransitionCurrent(ownerTransition, ownerKey))
        return;

      activeOwnerContext = ownerKey === null ? null : { ownerKey, client };
      pushPermission.setRegistrationContext(ownerKey);
      pushRuntime.setAppActive(AppState.currentState === 'active');

      if (ownerKey !== null) {
        unregisterSignOutCleanup = registerBeforeSignOutCleanup(async () => {
          // Le tombstone part immédiatement, même si le coordinateur attend encore un POST.
          const durableRevocation = pushRuntime
            .revokeOwnerAuthenticated(ownerKey, client)
            .catch(() => undefined);
          await pushPermission.revokeRegistrationBeforeSignOut(async () => durableRevocation);
          await durableRevocation;
        });
      }

      const initialState = await pushPermission.bootstrapSilently();
      if (!mounted || !pushRuntime.isTransitionCurrent(ownerTransition, ownerKey)) return;
      await revokeIfPermissionAuthoritativelyDisabled(ownerKey, initialState);
      if (!mounted || !pushRuntime.isTransitionCurrent(ownerTransition, ownerKey)) return;

      appStateSubscription = AppState.addEventListener('change', (nextState) => {
        if (!mounted || !pushRuntime.isTransitionCurrent(ownerTransition, ownerKey)) return;
        const active = nextState === 'active';
        pushRuntime.setAppActive(active);
        if (!active) return;
        void pushPermission
          .refreshSilently()
          .then(async (state) => {
            if (!mounted || !pushRuntime.isTransitionCurrent(ownerTransition, ownerKey)) return;
            await revokeIfPermissionAuthoritativelyDisabled(ownerKey, state);
          })
          .catch(() => undefined);
      });
      setEventBridgeReady(true);
    })().catch(() => {
      // SecureStore/crypto indisponible : push reste intégralement fail-closed, l'app demeure utile.
      if (mounted) setEventBridgeReady(false);
    });

    return () => {
      mounted = false;
      appStateSubscription?.remove();
      unregisterSignOutCleanup?.();
      if (ownerTransition !== null && pushRuntime.isTransitionCurrent(ownerTransition)) {
        pushRuntime.setAppActive(false);
        pushPermission.setRegistrationContext(null);
        activeOwnerContext = null;
        pushRuntime.abortOwnerTransition(ownerTransition);
      } else if (ownerTransition === null) {
        pushPermission.setRegistrationContext(null);
        activeOwnerContext = null;
      }
    };
  }, [client, ownerCompanyId, ownerUserId]);

  // Deep link au tap — la route vient du serveur (notification-route.ts), jamais devinée ici.
  useEffect(() => {
    if (!eventBridgeReady) return;
    return installPushEventBridge(
      {
        subscribeToResponses: (listener) =>
          Notifications.addNotificationResponseReceivedListener(listener),
        getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
        clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
        subscribeToForegroundNotifications: (listener) =>
          Notifications.addNotificationReceivedListener(listener),
        matchPayload: (payload) => pushRuntime.matchPayload(payload),
        navigate: (route) => router.push(route as Href),
        // Même clé que useNotificationsFeed/useUnreadNotificationsPreview.
        onForegroundNotification: () =>
          void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
        log: (message, error) => {
          console.info(
            `[push] ${message} —`,
            error instanceof Error ? error.message : 'erreur inconnue',
          );
        },
      },
      responseDispatcher,
    );
  }, [eventBridgeReady, queryClient, router]);

  return null;
}
