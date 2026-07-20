import { describe, expect, it } from 'vitest';
import { motion } from '@bob/tokens';
import {
  SCAN_LINE_TRAVEL_BOTTOM,
  SCAN_LINE_TRAVEL_TOP,
  SCAN_PULSE_OPACITY_MIN,
  SCAN_SWEEP_DURATION_MS,
  resolveScanReadingMotion,
} from './scan-reading-motion';

describe('resolveScanReadingMotion', () => {
  it('mouvement autorisé → balayage aller-retour au rythme du proto (1,1 s)', () => {
    expect(resolveScanReadingMotion(false)).toEqual({
      mode: 'sweep',
      durationMs: SCAN_SWEEP_DURATION_MS,
    });
    expect(SCAN_SWEEP_DURATION_MS).toBe(1100);
  });

  it('reduced-motion → pulse discret SANS déplacement, calé sur motion.ambient', () => {
    expect(resolveScanReadingMotion(true)).toEqual({
      mode: 'pulse',
      durationMs: motion.ambient,
    });
  });

  it('garde-fous terrain-first : la ligne reste dans la miniature et jamais invisible', () => {
    expect(SCAN_LINE_TRAVEL_TOP).toBeGreaterThan(0);
    expect(SCAN_LINE_TRAVEL_BOTTOM).toBeGreaterThan(SCAN_LINE_TRAVEL_TOP);
    expect(SCAN_LINE_TRAVEL_BOTTOM).toBeLessThan(154);
    expect(SCAN_PULSE_OPACITY_MIN).toBeGreaterThan(0);
  });
});
