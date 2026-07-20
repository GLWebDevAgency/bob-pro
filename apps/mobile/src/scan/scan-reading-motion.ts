/**
 * Overlay scan « Je lis ton document… » (handoff §SCAN OVERLAY) — logique de motion PURE.
 * · sweep : la ligne de scan indigo fait l'aller-retour sur la miniature (cpScanLine 1.1s,
 *   ease-in-out alternate dans le proto) ;
 * · pulse : reduced-motion → AUCUN déplacement, un simple battement d'opacité discret,
 *   calé sur la respiration `motion.ambient` des tokens.
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

export interface ScanReadingMotion {
  mode: 'sweep' | 'pulse';
  durationMs: number;
}

/** reduced-motion ⇒ pulse statique ; sinon balayage aller-retour. */
export function resolveScanReadingMotion(reduceMotion: boolean): ScanReadingMotion {
  return reduceMotion
    ? { mode: 'pulse', durationMs: SCAN_PULSE_DURATION_MS }
    : { mode: 'sweep', durationMs: SCAN_SWEEP_DURATION_MS };
}
