/**
 * ClientRow — §9 (liste clients).
 * Pressable padding V 13 ; avatar squircle 44 (injecté via `avatar`, sinon
 * initiale locale) ; nom 14.5/700 ink800 + sous-titre 12.5 slate400 ; montant
 * tabular-nums teinté par `tone` ; chevron controls.chevron (injectable).
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { formatEUR } from '@bob/core';
import { font, useTheme } from '../theme';
import { PressableScale } from './pressable-scale';

export type ClientRowTone = 'success' | 'danger' | 'warning' | 'neutral';

export interface ClientRowProps {
  name: string;
  subtitle?: string;
  amountCents?: number;
  /** Teinte du montant selon le statut client (défaut : neutre navy). */
  tone?: ClientRowTone;
  /** Avatar injecté (composant Avatar du lot A) ; sinon initiales locales. */
  avatar?: ReactNode;
  /** Chevron injecté ; sinon chevron par défaut en controls.chevron. */
  chevron?: ReactNode;
  onPress?: () => void;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

export function ClientRow({
  name,
  subtitle,
  amountCents,
  tone = 'neutral',
  avatar,
  chevron,
  onPress,
}: ClientRowProps) {
  const { colors, semantic, controls, radius, theme } = useTheme();
  const toneColors: Record<ClientRowTone, string> = {
    success: semantic.success,
    danger: semantic.dangerVivid,
    warning: semantic.warning,
    neutral: colors.ink900,
  };
  const amountText = amountCents !== undefined ? formatEUR(amountCents) : undefined;

  return (
    <PressableScale
      {...(onPress !== undefined ? { onPress } : {})}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={[name, subtitle, amountText].filter(Boolean).join(', ')}
    >
      {avatar !== undefined ? (
        avatar
      ) : (
        <View
          style={[styles.avatar, { borderRadius: radius.squircle, backgroundColor: theme.ink2 }]}
        >
          <Text style={[font('cardTitle'), styles.avatarText, { color: colors.surface }]}>
            {initialsOf(name)}
          </Text>
        </View>
      )}
      <View style={styles.texts}>
        <Text style={[font('body'), styles.name, { color: colors.ink800 }]} numberOfLines={1}>
          {name}
        </Text>
        {subtitle !== undefined ? (
          <Text style={[font('meta'), styles.subtitle, { color: colors.slate400 }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {amountText !== undefined ? (
        <Text style={[font('cardTitle'), styles.amount, { color: toneColors[tone] }]}>
          {amountText}
        </Text>
      ) : null}
      {chevron !== undefined ? (
        chevron
      ) : (
        <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
          <Path
            d="M9 6l6 6-6 6"
            stroke={controls.chevron}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    minHeight: 44,
  },
  avatar: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 15 },
  texts: { flex: 1 },
  name: { fontWeight: '700' },
  subtitle: { fontSize: 12.5, marginTop: 1 },
  amount: { fontSize: 15, fontVariant: ['tabular-nums'] },
});
