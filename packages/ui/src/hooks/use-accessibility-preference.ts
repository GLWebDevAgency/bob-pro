/**
 * PRÉFÉRENCES D'ACCESSIBILITÉ À TROIS ÉTATS — même patron que `useTransparencyPreference`, et
 * pour la même raison : `AccessibilityInfo` n'a AUCUNE variante synchrone. Au premier rendu, la
 * valeur n'est pas revenue.
 *
 * POURQUOI CES DEUX HOOKS EXISTENT À CÔTÉ DE `useReduceMotion`. Depuis le Lot 0 (plan DA
 * 01/08), le hook livré est FAIL-CLOSED lui aussi : pendant la fenêtre d'ignorance il répond
 * `true` (réduit — aucune animation avant de savoir), en gardant sa signature `boolean` pour
 * ses sept consommateurs. Ce qu'un `boolean` ne peut PAS dire, c'est la différence entre
 * « réduit » et « pas encore su » : les cas fins qui rendent un état DIFFÉRENT pendant
 * l'ignorance (tab bar, ligne de scan — statique pendant `unknown`, pulse en `reduced`)
 * consomment la variante tri-état ci-dessous.
 *
 * LE LECTEUR D'ÉCRAN N'AVAIT AUCUN HOOK. Il en faut un, et il est structurant : un détecteur de
 * geste qui CONSOMME les touches d'exploration ne doit pas être monté tant qu'on ne sait pas si
 * VoiceOver/TalkBack est actif. L'état sûr est aussi l'état accessible.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import type { PreferenceState } from '../components/bob-tab-bar.logic';

export type { PreferenceState };

/**
 * Fabrique commune : lecture unique, abonnement au changement, et surtout un état initial
 * `'unknown'` qui OBLIGE l'appelant à traiter la fenêtre d'ignorance.
 *
 * L'abonnement est posé AVANT que la lecture ne se résolve, et le nettoyage annule la reprise
 * de la promesse : un composant démonté pendant la lecture ne réveille jamais un état mort.
 */
function useSystemPreference(
  read: () => Promise<boolean>,
  event: 'reduceMotionChanged' | 'screenReaderChanged',
): PreferenceState {
  const [state, setState] = useState<PreferenceState>('unknown');
  useEffect(() => {
    let alive = true;
    const apply = (value: boolean): void => {
      if (alive) setState(value ? 'active' : 'inactive');
    };
    const subscription = AccessibilityInfo.addEventListener(event, apply);
    read().then(apply, () => {
      // Une lecture qui échoue laisse l'état INCONNU — donc le rang sûr. On ne bascule jamais
      // vers « inactive » par défaut : ce serait décider à la place de l'utilisateur.
      if (alive) setState('unknown');
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, [read, event]);
  return state;
}

const readReduceMotion = (): Promise<boolean> => AccessibilityInfo.isReduceMotionEnabled();
const readScreenReader = (): Promise<boolean> => AccessibilityInfo.isScreenReaderEnabled();

/** Reduce Motion, tri-état. `'unknown'` compte comme ACTIF chez tous les appelants. */
export function useReduceMotionPreference(): PreferenceState {
  return useSystemPreference(readReduceMotion, 'reduceMotionChanged');
}

/** Lecteur d'écran actif, tri-état. `'unknown'` compte comme ACTIF : pas de détecteur monté. */
export function useScreenReaderPreference(): PreferenceState {
  return useSystemPreference(readScreenReader, 'screenReaderChanged');
}
