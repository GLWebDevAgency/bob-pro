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
 * AUCUN CACHE FAIL-OPEN — chaque montage repart de l'état tri-état `unknown`. Une ancienne
 * résolution `inactive` ne peut donc jamais autoriser un FadeIn avant la nouvelle lecture native :
 * la préférence a pu changer pendant qu'aucun consommateur n'était monté, et le pont natif peut
 * échouer. `unknown` et `active` ferment tous deux l'animation ; seul `inactive`, relu ou reçu par
 * événement pendant CE montage, l'autorise.
 *
 * Pour les cas fins qui doivent DISTINGUER « inconnu » de « réduit » (ligne de scan),
 * consommer `useReduceMotionPreference` (tri-état, use-accessibility-preference.ts).
 */
import { useReduceMotionPreference } from './use-accessibility-preference';

export function useReduceMotion(): boolean {
  return useReduceMotionPreference() !== 'inactive';
}
