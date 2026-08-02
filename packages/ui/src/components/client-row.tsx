/**
 * ClientRow v2 — §9 (liste clients) + slots du Lot 4 (plan DA 01/08 : « la seule primitive
 * CRM du kit était inutilisée faute de slots »).
 * Pressable padding V 13 ; avatar squircle 44 (injecté via `avatar`, sinon initiale locale) ;
 * nom 14.5/700 ink800 + slot `nameAccessory` (badge type) ; sous-titre 12.5 slate400 ;
 * montant tabular-nums teinté par `tone` + mot de statut `statusWord` 11.5 slate400
 * (le slate300/11 de l'écran échouait au soleil — plan Lot 4) ; chevron controls.chevron.
 * Le fil rouge « couleur de l'argent » : `tone` se dérive de standingAccentRole (même
 * dérivation du carnet à la fiche au geste — standing-accent.logic).
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
  /** Montant DÉJÀ formaté par l'écran (« à jour », euros entiers…) — prioritaire sur cents. */
  amountText?: string;
  /** Teinte du montant selon le standing client (défaut : neutre navy). */
  tone?: ClientRowTone;
  /** Mot de statut sous le montant (« payé », « en retard »…) — 11.5 slate400 AA. */
  statusWord?: string;
  /** Avatar injecté (composant Avatar du lot A) ; sinon initiales locales. */
  avatar?: ReactNode;
  /** Accessoire à droite du nom (StatusBadge type client…) — jamais fabriqué ici. */
  nameAccessory?: ReactNode;
  /** Chevron injecté ; sinon chevron par défaut en controls.chevron. */
  chevron?: ReactNode;
  /** Libellé accessible composé par l'écran (statut + montant) — défaut : nom, sous-titre, montant. */
  accessibilityLabel?: string;
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
  amountText,
  tone = 'neutral',
  statusWord,
  avatar,
  nameAccessory,
  chevron,
  accessibilityLabel,
  onPress,
}: ClientRowProps) {
  const { colors, semantic, controls, radius, theme } = useTheme();
  const toneColors: Record<ClientRowTone, string> = {
    success: semantic.success,
    danger: semantic.dangerVivid,
    warning: semantic.warning,
    neutral: colors.ink900,
  };
  const resolvedAmount =
    amountText ?? (amountCents !== undefined ? formatEUR(amountCents) : undefined);

  return (
    <PressableScale
      {...(onPress !== undefined ? { onPress } : {})}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={
        accessibilityLabel ?? [name, subtitle, resolvedAmount].filter(Boolean).join(', ')
      }
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
        {nameAccessory !== undefined ? (
          <View style={styles.nameRow}>
            <Text
              style={[font('body'), styles.name, styles.nameShrink, { color: colors.ink800 }]}
              numberOfLines={1}
            >
              {name}
            </Text>
            {nameAccessory}
          </View>
        ) : (
          <Text style={[font('body'), styles.name, { color: colors.ink800 }]} numberOfLines={1}>
            {name}
          </Text>
        )}
        {subtitle !== undefined ? (
          <Text style={[font('meta'), styles.subtitle, { color: colors.slate400 }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {resolvedAmount !== undefined ? (
        <View style={styles.amountColumn}>
          <Text style={[font('cardTitle'), styles.amount, { color: toneColors[tone] }]}>
            {resolvedAmount}
          </Text>
          {statusWord !== undefined ? (
            <Text style={[font('meta'), styles.statusWord, { color: colors.slate400 }]}>
              {statusWord}
            </Text>
          ) : null}
        </View>
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
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { fontWeight: '700' },
  nameShrink: { flexShrink: 1 },
  subtitle: { fontSize: 12.5, marginTop: 1 },
  amountColumn: { alignItems: 'flex-end' },
  amount: { fontSize: 15, fontVariant: ['tabular-nums'] },
  /** Mot de statut : 11.5 slate400 (plan Lot 4 — le slate300/11 échouait l'AA au soleil). */
  statusWord: { fontSize: 11.5, marginTop: 1 },
});
