/**
 * useTransparencyPreference — préférence système « réduire la transparence », lue une fois et
 * suivie en direct (même patron que `useReduceMotion`, l'implémentation UNIQUE du dépôt).
 *
 * Doctrine « matière Bob » : les surfaces du kit sont OPAQUES par construction, la préférence
 * n'a donc RIEN à dégrader sur `BobSurface`. Elle a un seul effet dans tout le produit :
 * couper les échantillons de flou de `ProgressiveBlurBob` et le ramener au repli opaque
 * unique — la retombée en mode flouté est la seule matière qui échantillonne quoi que ce soit.
 *
 * POURQUOI TROIS ÉTATS ET NON UN BOOLÉEN. `AccessibilityInfo` n'a aucune variante synchrone :
 * la préférence n'est pas connue au premier rendu. Un booléen initialisé à `false` ALLUMERAIT
 * le flou une frame avant de le couper — un fail-OPEN sur une préférence d'accessibilité,
 * c'est-à-dire exactement l'effet que l'utilisateur a demandé à ne pas subir.
 * `'unknown'` oblige l'appelant à traiter ce cas, et le kit le traite en restant au rang
 * teinté (08 § Préférences d'accessibilité et premier rendu, règle fail-CLOSED).
 *
 * Android : `isReduceTransparencyEnabled()` résout `false` (préférence iOS) — l'état passe
 * donc de `'unknown'` à `'standard'`, et c'est la capacité de rendu qui gouverne là-bas.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import type { TransparencyPreference } from '../components/progressive-blur-bob.logic';

export type { TransparencyPreference };

export function useTransparencyPreference(): TransparencyPreference {
  const [preference, setPreference] = useState<TransparencyPreference>('unknown');
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((value) => {
      if (alive) setPreference(value ? 'reduced' : 'standard');
    });
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', (value) =>
      setPreference(value ? 'reduced' : 'standard'),
    );
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return preference;
}
