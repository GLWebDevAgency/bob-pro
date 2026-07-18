/**
 * Navigation partagée des écrans-pièces (S7). Un écran de détail atteint par deep link
 * (notification, lien) n'a parfois AUCUNE pile derrière lui : « Fermer » doit alors
 * ramener à l'accueil au lieu de ne rien faire. Même pattern que client/[id].tsx et
 * chantier/[id].tsx (goBack local), factorisé ici pour devis/[id] et facture/[id].
 */
import type { useRouter } from 'expo-router';

/** Contrat minimal du router utilisé par le helper — testable en pur, sans expo-router réel. */
export type BackCapableRouter = Pick<ReturnType<typeof useRouter>, 'canGoBack' | 'back' | 'replace'>;

/** Retour arrière si l'historique le permet, sinon replace vers l'accueil (onglets). */
export function goBackOrHome(router: BackCapableRouter): void {
  if (router.canGoBack()) router.back();
  else router.replace('/(tabs)');
}
