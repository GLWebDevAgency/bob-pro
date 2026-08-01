/**
 * useReduceMotion — L'implémentation UNIQUE (audit 14/07 : 2 duplications, 7 composants
 * animés qui n'écoutaient rien). Règle produit : les animations AMBIENT (halo, orbe,
 * respirations) sont COUPÉES en reduced-motion ; les transitions d'UI passent à durée 0
 * (le modèle : Sheet.tsx). Tout nouveau composant animé DOIT consommer ce hook.
 *
 * FAIL-CLOSED (Lot 0, plan DA 01/08 — arbitrage FAIL-CLOSED MOTION). `AccessibilityInfo`
 * n'a aucune variante synchrone : au premier rendu la préférence n'est PAS connue. Le hook
 * répondait `false` (« pas de réduction ») pendant cette fenêtre — un fail-OPEN qui animait
 * avant de savoir, signalé écran par écran par 4 audits (L1/L2/L4/L5). Désormais la fenêtre
 * d'ignorance répond `true` : PAS d'animation tant que la préférence n'est pas résolue —
 * la doctrine de la tab bar v2 devient la loi de tout le kit. Coût assumé : première frame
 * sans animation.
 *
 * MÉMOIRE DE MODULE — la résolution est retenue au niveau du module : seul le TOUT PREMIER
 * montage (ou un échec de lecture) traverse la fenêtre d'ignorance ; les montages suivants
 * démarrent sur la dernière valeur RÉSOLUE du système (les animations de montage — FadeIn ne
 * joue qu'au montage — restent donc vivantes après la première résolution). Chaque montage
 * relit quand même la préférence : une valeur périmée est corrigée dès la réponse native.
 *
 * Pour les cas fins qui doivent DISTINGUER « inconnu » de « réduit » (ligne de scan),
 * consommer `useReduceMotionPreference` (tri-état, use-accessibility-preference.ts).
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** Dernière valeur RÉSOLUE par le système — null tant qu'aucune lecture n'a abouti. */
let lastResolvedReduceMotion: boolean | null = null;

export function useReduceMotion(): boolean {
  // Fenêtre d'ignorance = RÉDUIT (fail-closed) ; sinon, dernière valeur résolue connue.
  const [reduced, setReduced] = useState(lastResolvedReduceMotion ?? true);
  useEffect(() => {
    let alive = true;
    const apply = (value: boolean): void => {
      lastResolvedReduceMotion = value;
      if (alive) setReduced(value);
    };
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', apply);
    AccessibilityInfo.isReduceMotionEnabled().then(apply, () => {
      // Lecture en échec : on ne décide PAS à la place de l'utilisateur — l'état reste
      // celui du montage (fermé si aucune résolution n'a jamais abouti), et la mémoire
      // de module n'est pas écrite.
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}
