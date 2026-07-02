/**
 * KpiTile — tuile « En un coup d'œil » (grille 2×2, COMPONENT_SPECS.md §5).
 * Surface radius 18, padding 15, ombre e1. Ligne icône 16 + label 12.5/600 slate500,
 * puis montant 21/800 (bigNum) teinté par tone. Le chiffre est le héros : tabular-nums.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { formatEUR } from '@bob/core';
import { shadowNative } from '@bob/tokens';
import { font, useTheme } from '../theme';

export type KpiTone = 'success' | 'danger' | 'warning' | 'ink';

export interface KpiTileProps {
  /** Style du conteneur (grilles : flexBasis, flex…). */
  style?: StyleProp<ViewStyle>;
  label: string;
  /** Montant en centimes, formaté via formatEUR (@bob/core). */
  amountCents: number;
  /** Teinte du montant — danger = dangerVivid (retard/impayé). Défaut : ink. */
  tone?: KpiTone;
  /** Icône 16 injectée (aucune lib d'icônes dans @bob/ui). */
  icon?: ReactNode;
  onPress?: () => void;
}

export function KpiTile({ style,
  label, amountCents, tone = 'ink', icon, onPress }: KpiTileProps) {
  const { colors, semantic, controls } = useTheme();
  const toneColor: Record<KpiTone, string> = {
    success: semantic.success,
    danger: semantic.dangerVivid,
    warning: semantic.warning,
    ink: colors.ink900,
  };
  const amount = formatEUR(amountCents);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${amount}`}
      {...(onPress ? { onPress } : {})}
      style={[{
        backgroundColor: colors.surface,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: controls.cardBorder,
        padding: 15,
        minHeight: 44,
        minWidth: 44,
        ...shadowNative.e1,
      }, style]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {icon ? (
          <View
            style={{
              width: 16,
              height: 16,
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 7,
            }}
          >
            {icon}
          </View>
        ) : null}
        <Text style={{ ...font('meta'), fontSize: 12.5, color: colors.slate500 }}>{label}</Text>
      </View>
      <Text
        style={{
          ...font('bigNum'),
          color: toneColor[tone],
          fontVariant: ['tabular-nums'],
          marginTop: 8,
        }}
      >
        {amount}
      </Text>
    </Pressable>
  );
}
