import { Text, View, Pressable } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { font, useTheme } from '@bob/ui';
import { FR_MONTH_NAMES } from '../../fiscal/fiscal-dates';

/**
 * Sélecteur mois/année ACCESSIBLE (amendement 8 : cibles ≥44 pt, aucune interaction temporisée).
 * Pattern « spinbutton » standard (iOS UIStepper / accessibilityRole="adjustable") : VoiceOver
 * balaie haut/bas sur le conteneur pour incrémenter/décrémenter d'un mois ; à la souris/au doigt,
 * les boutons − / + (44×44) font la même chose. Bornes larges (5 ans en arrière, 1 an devant) —
 * suffisant pour une date de début d'activité/ACRE, jamais un blocage arbitraire.
 */
export interface MonthYearValue {
  readonly month: number; // 1-12
  readonly year: number;
}

const MIN_YEAR_OFFSET = -5;
const MAX_YEAR_OFFSET = 1;

function clamp(value: MonthYearValue, nowYear: number): MonthYearValue {
  const minTotal = (nowYear + MIN_YEAR_OFFSET) * 12;
  const maxTotal = (nowYear + MAX_YEAR_OFFSET) * 12 + 11;
  const total = Math.min(Math.max(value.year * 12 + (value.month - 1), minTotal), maxTotal);
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

function shift(value: MonthYearValue, deltaMonths: number, nowYear: number): MonthYearValue {
  const total = value.year * 12 + (value.month - 1) + deltaMonths;
  return clamp({ year: Math.floor(total / 12), month: (total % 12) + 1 }, nowYear);
}

export function MonthYearStepper({
  value,
  onChange,
  accessibilityLabel,
}: {
  readonly value: MonthYearValue;
  readonly onChange: (next: MonthYearValue) => void;
  readonly accessibilityLabel: string;
}) {
  const { colors, controls, radius } = useTheme();
  const nowYear = new Date().getFullYear();
  const label = `${FR_MONTH_NAMES[value.month - 1]} ${value.year}`;

  const dec = (): void => onChange(shift(value, -1, nowYear));
  const inc = (): void => onChange(shift(value, 1, nowYear));

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: label }}
      accessibilityActions={[
        { name: 'increment', label: 'mois suivant' },
        { name: 'decrement', label: 'mois précédent' },
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'increment') inc();
        if (event.nativeEvent.actionName === 'decrement') dec();
      }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: controls.segmentedTrack,
        borderRadius: radius.cardLg,
        padding: 6,
      }}
    >
      <Pressable
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        onPress={dec}
        hitSlop={4}
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          backgroundColor: colors.surface,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Feather name="minus" size={18} color={colors.ink800} />
      </Pressable>
      <Text
        allowFontScaling
        style={[font('cardTitle'), { fontSize: 16, color: colors.ink900, fontVariant: ['tabular-nums'] }]}
      >
        {label}
      </Text>
      <Pressable
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        onPress={inc}
        hitSlop={4}
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          backgroundColor: colors.surface,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Feather name="plus" size={18} color={colors.ink800} />
      </Pressable>
    </View>
  );
}
