/**
 * Overlay scan « Je lis ton document… » (handoff §SCAN OVERLAY) — logique de motion PURE.
 * · sweep : la ligne de scan indigo fait l'aller-retour sur la miniature (cpScanLine 1.1s,
 *   ease-in-out alternate dans le proto) ;
 * · pulse : reduced-motion → AUCUN déplacement, un simple battement d'opacité discret,
 *   calé sur la respiration `motion.ambient` des tokens ;
 * · static : préférence NON RÉSOLUE (`unknown`) → RIEN d'animé, la ligne posée à opacité
 *   fixe (Lot 0, plan DA 01/08 — fail-closed : le balayage n'existe que si la préférence
 *   est résolue à « pas de réduction », le pulse que si elle est résolue à « réduit »).
 */
import { motion } from '@bob/tokens';

/** Durée d'un aller (le retour dure autant) — proto : `animation: cpScanLine 1.1s`. */
export const SCAN_SWEEP_DURATION_MS = 1100;
/** Battement d'opacité en reduced-motion — respiration ambiante des tokens. */
export const SCAN_PULSE_DURATION_MS = motion.ambient;
/** Bornes d'opacité du pulse (jamais 0 : rien ne disparaît au repos, terrain-first). */
export const SCAN_PULSE_OPACITY_MIN = 0.35;
export const SCAN_PULSE_OPACITY_MAX = 0.9;
/** Course verticale de la ligne dans la miniature 154 pt (8 % → ~85 % comme le proto). */
export const SCAN_LINE_TRAVEL_TOP = 12;
export const SCAN_LINE_TRAVEL_BOTTOM = 130;

/** Préférence tri-état de la ligne de scan (miroir de `useReduceMotionPreference`). */
export type ScanReadingPreference = 'unknown' | 'reduced' | 'full';

export interface ScanReadingMotion {
  mode: 'sweep' | 'pulse' | 'static';
  durationMs: number;
}

/**
 * Résout le mouvement de la ligne de scan.
 * · `boolean` (signature historique, scan-document.tsx) : `true` ⇒ pulse, `false` ⇒ sweep —
 *   comportement STRICTEMENT inchangé, un booléen ne produit jamais `static` ;
 * · tri-état (Lot 0) : `unknown` ⇒ static (durée 0 — aucune animation avant de savoir),
 *   `reduced` ⇒ pulse, `full` ⇒ sweep.
 */
export function resolveScanReadingMotion(
  preference: boolean | ScanReadingPreference,
): ScanReadingMotion {
  if (preference === 'unknown') return { mode: 'static', durationMs: 0 };
  const reduced = preference === true || preference === 'reduced';
  return reduced
    ? { mode: 'pulse', durationMs: SCAN_PULSE_DURATION_MS }
    : { mode: 'sweep', durationMs: SCAN_SWEEP_DURATION_MS };
}
