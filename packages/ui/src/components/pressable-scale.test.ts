import { describe, expect, it } from 'vitest';
import {
  PRESSABLE_SCALE_IN_MS,
  PRESSABLE_SCALE_MIN_TARGET,
  PRESSABLE_SCALE_OPACITY_PRESSED,
  PRESSABLE_SCALE_OUT_MS,
  PRESSABLE_SCALE_PRESSED,
  resolvePressMotion,
} from './pressable-scale.logic';

describe('press feedback standard', () => {
  it('enfoncement 0.98 + opacité 0.9 — plus doux que le 0.94 des boutons pleins', () => {
    expect(PRESSABLE_SCALE_PRESSED).toBe(0.98);
    expect(PRESSABLE_SCALE_OPACITY_PRESSED).toBe(0.9);
  });

  it('cible tactile ≥ 44 pt', () => {
    expect(PRESSABLE_SCALE_MIN_TARGET).toBeGreaterThanOrEqual(44);
  });

  it('entrée rapide (≤ 100 ms) et sortie plus longue que l’entrée — relâchement naturel', () => {
    expect(PRESSABLE_SCALE_IN_MS).toBeLessThanOrEqual(100);
    expect(PRESSABLE_SCALE_OUT_MS).toBeGreaterThan(PRESSABLE_SCALE_IN_MS);
  });
});

describe('resolvePressMotion', () => {
  it('pressé → progrès 1 en 90 ms ; relâché → 0 en 150 ms', () => {
    expect(resolvePressMotion(true, false)).toEqual({ toValue: 1, duration: PRESSABLE_SCALE_IN_MS });
    expect(resolvePressMotion(false, false)).toEqual({
      toValue: 0,
      duration: PRESSABLE_SCALE_OUT_MS,
    });
  });

  it('reduced-motion → durée 0 dans les deux sens, le feedback reste', () => {
    expect(resolvePressMotion(true, true)).toEqual({ toValue: 1, duration: 0 });
    expect(resolvePressMotion(false, true)).toEqual({ toValue: 0, duration: 0 });
  });
});
