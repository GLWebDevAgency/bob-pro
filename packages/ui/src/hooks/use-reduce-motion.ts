/**
 * useReduceMotion — L'implémentation UNIQUE (audit 14/07 : 2 duplications, 7 composants
 * animés qui n'écoutaient rien). Règle produit : les animations AMBIENT (halo, orbe,
 * respirations) sont COUPÉES en reduced-motion ; les transitions d'UI passent à durée 0
 * (le modèle : Sheet.tsx). Tout nouveau composant animé DOIT consommer ce hook.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}
