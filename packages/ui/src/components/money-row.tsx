/**
 * MoneyRow — §10 (grand-livre « le solde ment »).
 * Ligne space-between, padding V 9, séparateur patterns.moneyRow.divider.
 * Label 14 slate500 (lead : 600 ink800 + icône injectée) ; montant tabular-nums
 * teinté par signe. Variante total : padding-top 13, label 15/700, montant 20/800 navy.
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { patterns } from '@bob/tokens';
import { font, useTheme } from '../theme';
import { moneyRowAmountColor, moneyRowAmountText, type MoneyRowVariant } from './money-row.logic';

export interface MoneyRowProps {
  label: string;
  amountCents: number;
  /** 'lead' = 1er rang (600 ink800 + icône) ; 'total' = rangée de total. */
  variant?: MoneyRowVariant;
  icon?: ReactNode;
  /** Séparateur bas (défaut true ; à couper sur la dernière ligne). */
  divider?: boolean;
}

export function MoneyRow({ label, amountCents, variant = 'default', icon, divider = true }: MoneyRowProps) {
  const { colors } = useTheme();
  const isTotal = variant === 'total';
  const isLead = variant === 'lead';
  const amountColor = moneyRowAmountColor(amountCents, variant);
  const amountText = moneyRowAmountText(amountCents, variant);

  return (
    <View
      style={[styles.row, isTotal && styles.rowTotal, divider && styles.divider]}
      accessible
      accessibilityLabel={`${label}, ${amountText}`}
    >
      <View style={styles.labelWrap}>
        {icon !== undefined ? icon : null}
        <Text
          style={[
            font('body'),
            styles.label,
            { color: colors.slate500 },
            isLead && [styles.labelLead, { color: colors.ink800 }],
            isTotal && [styles.labelTotal, { color: colors.ink800 }],
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      </View>
      <Text
        style={[
          font('cardTitle'),
          styles.amount,
          { color: amountColor },
          isTotal && styles.amountTotal,
        ]}
      >
        {amountText}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 9,
  },
  rowTotal: { paddingTop: 13 },
  divider: { borderBottomWidth: 1, borderBottomColor: patterns.moneyRow.divider },
  labelWrap: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1 },
  label: { fontSize: 14 },
  labelLead: { fontWeight: '600' },
  labelTotal: { fontSize: 15, fontWeight: '700' },
  amount: { fontSize: 15, fontVariant: ['tabular-nums'], marginLeft: 12 },
  amountTotal: { fontSize: 20, fontWeight: '800' },
});
