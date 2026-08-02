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
import { Skeleton, SkeletonTextLine } from './skeleton';

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

export interface MoneyRowEmptyProps {
  label: string;
  variant?: MoneyRowVariant;
  divider?: boolean;
  /**
   * Ce que le lecteur d'écran annonce à la place du tiret (ex. « non renseigné », i18n côté
   * écran) — « — » visuel reste, mais un tiret verbalisé n'informe personne.
   */
  valueA11yLabel?: string;
}

/**
 * Rangée du grand-livre SANS donnée (Lot 1) : « — » est un état de premier rang — MÊMES
 * styles que MoneyRow (padding V 9, séparateur, crans lead/total), jamais un 0 inventé.
 */
export function MoneyRowEmpty({
  label,
  variant = 'default',
  divider = true,
  valueA11yLabel,
}: MoneyRowEmptyProps) {
  const { colors } = useTheme();
  const isTotal = variant === 'total';
  const isLead = variant === 'lead';
  return (
    <View
      style={[styles.row, isTotal && styles.rowTotal, divider && styles.divider]}
      accessible
      accessibilityLabel={`${label}, ${valueA11yLabel ?? '—'}`}
    >
      <Text
        numberOfLines={1}
        style={[
          font('body'),
          styles.label,
          { color: colors.slate500 },
          isLead && [styles.labelLead, { color: colors.ink800 }],
          isTotal && [styles.labelTotal, { color: colors.ink800 }],
        ]}
      >
        {label}
      </Text>
      <Text
        style={[
          font('cardTitle'),
          styles.amount,
          { color: colors.slate400 },
          isTotal && styles.amountTotal,
        ]}
      >
        —
      </Text>
    </View>
  );
}

export interface MoneyRowSkeletonProps {
  variant?: MoneyRowVariant;
  divider?: boolean;
}

/** Rangée du grand-livre en CHARGEMENT (Lot 1) — même gabarit que MoneyRow (padding V 9,
 *  séparateur, lead avec icône 17, total padding-top 13 + montant 20). Zéro saut. */
export function MoneyRowSkeleton({ variant = 'default', divider = true }: MoneyRowSkeletonProps) {
  const isLead = variant === 'lead';
  const isTotal = variant === 'total';
  return (
    <View style={[styles.row, isTotal && styles.rowTotal, divider && styles.divider]}>
      <View style={styles.labelWrap}>
        {isLead ? <Skeleton width={17} height={17} radius={5} /> : null}
        <SkeletonTextLine width={isLead ? 138 : 118} />
      </View>
      <SkeletonTextLine
        width={isTotal ? 92 : 72}
        barHeight={isTotal ? 18 : 15}
        boxHeight={isTotal ? 27 : 21}
      />
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
