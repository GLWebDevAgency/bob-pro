/**
 * Stepper — logique pure (réserve C03, consommée par le flux devis C21).
 * Aucun import react-native : index borné, état des segments, valeur d'accessibilité.
 */

export type StepperSegmentState = 'done' | 'current' | 'todo';

/** Borne l'index d'étape dans [0, total-1] (NaN/décimales/total vide → 0). */
export function clampStepIndex(index: number, total: number): number {
  if (total <= 0 || Number.isNaN(index)) return 0;
  return Math.min(total - 1, Math.max(0, Math.trunc(index)));
}

/** État d'un segment relativement à l'étape courante (courante accentuée par le composant). */
export function stepperSegmentState(
  segmentIndex: number,
  currentIndex: number,
  total: number,
): StepperSegmentState {
  const current = clampStepIndex(currentIndex, total);
  if (segmentIndex < current) return 'done';
  if (segmentIndex === current) return 'current';
  return 'todo';
}

/** Progression en % (étape courante incluse) — 6 étapes, étape 1 → 17, étape 6 → 100. */
export function stepperProgressPercent(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round(((clampStepIndex(index, total) + 1) / total) * 100);
}

export interface StepperA11yValue {
  min: number;
  max: number;
  now: number;
  /** Texte annoncé (libellé d'étape injecté, sinon « n/total »). */
  text: string;
}

/** Valeur accessibilityValue du progressbar RN — 1-based, libellé optionnel. */
export function stepperAccessibilityValue(
  index: number,
  total: number,
  label?: string,
): StepperA11yValue {
  const max = Math.max(1, total);
  const now = clampStepIndex(index, total) + 1;
  return { min: 1, max, now, text: label ?? `${now}/${max}` };
}
