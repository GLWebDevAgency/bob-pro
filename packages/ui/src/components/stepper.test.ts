import { describe, it, expect } from 'vitest';
import {
  clampStepIndex,
  stepperAccessibilityValue,
  stepperProgressPercent,
  stepperSegmentState,
} from './stepper.logic';

describe('stepper.logic (réserve C03 — flux devis C21)', () => {
  it('borne l’index dans [0, total-1] (négatif, NaN, décimales, dépassement)', () => {
    expect(clampStepIndex(-2, 6)).toBe(0);
    expect(clampStepIndex(Number.NaN, 6)).toBe(0);
    expect(clampStepIndex(2.9, 6)).toBe(2);
    expect(clampStepIndex(9, 6)).toBe(5);
    expect(clampStepIndex(3, 0)).toBe(0); // total vide : jamais d'index négatif
  });

  it('état des segments : faits < courant < à venir', () => {
    expect(stepperSegmentState(0, 2, 6)).toBe('done');
    expect(stepperSegmentState(2, 2, 6)).toBe('current');
    expect(stepperSegmentState(5, 2, 6)).toBe('todo');
    // Index courant hors bornes → borné avant comparaison.
    expect(stepperSegmentState(5, 9, 6)).toBe('current');
  });

  it('progression en % (étape courante incluse) — 6 étapes du devis', () => {
    expect(stepperProgressPercent(0, 6)).toBe(17);
    expect(stepperProgressPercent(2, 6)).toBe(50);
    expect(stepperProgressPercent(5, 6)).toBe(100);
    expect(stepperProgressPercent(0, 0)).toBe(0);
  });

  it('accessibilityValue 1-based avec libellé injecté (sinon « n/total »)', () => {
    expect(stepperAccessibilityValue(2, 6, 'TVA & mentions')).toEqual({
      min: 1,
      max: 6,
      now: 3,
      text: 'TVA & mentions',
    });
    expect(stepperAccessibilityValue(0, 6)).toEqual({ min: 1, max: 6, now: 1, text: '1/6' });
    expect(stepperAccessibilityValue(9, 6).now).toBe(6);
  });
});
