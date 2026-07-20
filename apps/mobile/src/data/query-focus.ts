/**
 * Pont AppState → focusManager (doc TanStack « React Native ») : sur mobile, React Query ne
 * voit AUCUN événement de focus par défaut (pas de `visibilitychange`) — il reste « focused »
 * pour toujours, donc `refetchOnWindowFocus` est mort et une invalidation manquée (réseau
 * coupé, refetch annulé) n'est JAMAIS rattrapée au retour au premier plan (bug terrain
 * « badge brouillon fantôme », APK d091b0b5). Module PUR : l'AppState-like et le manager
 * sont injectables — testable en node sans React Native.
 */
import { focusManager } from '@tanstack/react-query';
import type { AppStateStatus } from 'react-native';

/** Abonnement minimal retourné par AppState.addEventListener. */
export interface AppStateSubscriptionLike {
  remove(): void;
}

/** Surface minimale d'AppState consommée ici — react-native s'y conforme structurellement. */
export interface AppStateLike {
  addEventListener(
    type: 'change',
    listener: (status: AppStateStatus) => void,
  ): AppStateSubscriptionLike;
}

/** Surface minimale du focusManager de React Query. */
export interface FocusManagerLike {
  setFocused(focused?: boolean): void;
}

/** Seul 'active' est le premier plan — 'inactive' (transition iOS) n'est jamais un focus. */
export const isForegroundStatus = (status: AppStateStatus): boolean => status === 'active';

/**
 * Branche le focusManager sur le cycle de vie AppState. Retourne la fonction de débranchement
 * (à rendre depuis l'effet appelant : une seule souscription, jamais de fuite).
 */
export function connectFocusManagerToAppState(
  appState: AppStateLike,
  manager: FocusManagerLike = focusManager,
): () => void {
  const subscription = appState.addEventListener('change', (status) => {
    manager.setFocused(isForegroundStatus(status));
  });
  return () => subscription.remove();
}
