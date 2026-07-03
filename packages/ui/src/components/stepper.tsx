/**
 * Stepper — progression d'un flux à n étapes (réserve C03, flux devis C21).
 * Barre segmentée : un segment par étape (flex:1, hauteur 4, radius 2) — étape
 * courante accentuée theme.ink, étapes faites theme.ink2, à venir
 * controls.segmentedTrack. Libellé de l'étape courante optionnel (eyebrow).
 * a11y : progressbar + accessibilityValue (min/max/now/texte du libellé).
 * Zéro hex/rgba — toute couleur vient de useTheme() (token-lint).
 */
import { Text, View } from 'react-native';
import { font, useTheme } from '../theme';
import {
  clampStepIndex,
  stepperAccessibilityValue,
  stepperSegmentState,
  type StepperSegmentState,
} from './stepper.logic';

export interface StepperProps {
  /** Nombre total d'étapes (≥ 1). */
  total: number;
  /** Étape courante (index 0-based — borné par la logique). */
  current: number;
  /** Libellés d'étape (optionnels) — seul celui de l'étape courante est rendu. */
  labels?: readonly string[];
  accessibilityLabel?: string;
}

export function Stepper({ total, current, labels, accessibilityLabel }: StepperProps) {
  const { theme, controls, colors } = useTheme();
  const clamped = clampStepIndex(current, total);
  const label = labels?.[clamped];
  const a11y = stepperAccessibilityValue(current, total, label);
  const segmentColor: Record<StepperSegmentState, string> = {
    done: theme.ink2,
    current: theme.ink,
    todo: controls.segmentedTrack,
  };

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={a11y}
      {...(accessibilityLabel !== undefined ? { accessibilityLabel } : {})}
    >
      <View style={{ flexDirection: 'row', gap: 5 }}>
        {Array.from({ length: Math.max(1, total) }, (_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              backgroundColor: segmentColor[stepperSegmentState(i, current, total)],
            }}
          />
        ))}
      </View>
      {label !== undefined ? (
        <Text style={[font('eyebrow'), { marginTop: 8, color: colors.slate500 }]}>{label}</Text>
      ) : null}
    </View>
  );
}
