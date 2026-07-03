import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useRouter, type Href } from 'expo-router';
import { useBobClient } from './client';

/**
 * Pont push Expo (C25) — deux responsabilités, zéro UI :
 * 1. au boot connecté : permission (honnête, refus accepté) → getExpoPushTokenAsync (projectId EAS
 *    si présent) → POST /devices (client.registerDevice, idempotent par token) ;
 * 2. au tap sur une notification : deep link vers `data.route` posée par le serveur
 *    (ex. /facture/inv-1 — même clé que le fil GET /notifications).
 *
 * DÉGRADÉ ASSUMÉ : le push DISTANT exige un DEV BUILD (Expo Go ne le supporte plus depuis SDK 53)
 * et un vrai device (pas de token sur simulateur). Dans ces environnements, l'enregistrement
 * échoue proprement (log console, aucune alerte) — le reste du fil (GET /notifications, badge,
 * relances) fonctionne à l'identique. Pipeline prod-ready : rien à changer en dev build.
 */
export function PushNotificationsBridge() {
  const client = useBobClient();
  const router = useRouter();
  const registered = useRef(false);

  // Enregistrement du device — une fois par montage racine (le serveur est idempotent par token).
  useEffect(() => {
    if (registered.current || Platform.OS === 'web') return;
    registered.current = true;
    void (async () => {
      try {
        const current = await Notifications.getPermissionsAsync();
        const perms = current.granted ? current : await Notifications.requestPermissionsAsync();
        if (!perms.granted) {
          console.log('[push] permission refusée — pas d’enregistrement (l’app reste fonctionnelle).');
          return;
        }
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('default', {
            name: 'Bob Pro',
            importance: Notifications.AndroidImportance.DEFAULT,
          });
        }
        const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
          ?.projectId;
        const token = await Notifications.getExpoPushTokenAsync(projectId !== undefined ? { projectId } : {});
        const r = await client.registerDevice({
          expoPushToken: token.data,
          platform: Platform.OS === 'ios' ? 'ios' : 'android',
        });
        if (!r.ok) console.log('[push] enregistrement refusé par le serveur :', r.error);
      } catch (e) {
        // Expo Go / simulateur / projectId absent : pas de push distant ici — dégradé honnête.
        console.log('[push] indisponible dans cet environnement (dev build requis) :', e instanceof Error ? e.message : e);
      }
    })();
  }, [client]);

  // Deep link au tap — la route vient du serveur (notification-route.ts), jamais devinée ici.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const route = response.notification.request.content.data?.route;
      if (typeof route === 'string' && route.startsWith('/')) router.push(route as Href);
    });
    return () => sub.remove();
  }, [router]);

  return null;
}
