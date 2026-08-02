/**
 * MoneyText — « le chiffre est le héros » : montants formatés par formatEUR (@bob/core),
 * tabular-nums partout, couleur par défaut ink900.
 */
import { Text } from 'react-native';
import { formatEUR } from '@bob/core';
import { useTheme, font } from '../theme';
import { moneyTypeKey, type MoneyVariant } from './money-text.logic';

export type { MoneyVariant };

export interface MoneyTextProps {
  /** Montant en centimes (formatEUR). */
  cents: number;
  /** hero = 42/800 · moneyHero = 27/800 (héros d'écran, Lot 0) · big = 21/800 · body (défaut). */
  variant?: MoneyVariant;
  /** Teinte (success/dangerVivid…) — défaut ink900. */
  color?: string;
}

export function MoneyText({ cents, variant = 'body', color }: MoneyTextProps) {
  const { colors } = useTheme();
  return (
    <Text
      style={[
        font(moneyTypeKey(variant)),
        { color: color ?? colors.ink900, fontVariant: ['tabular-nums'] },
      ]}
    >
      {formatEUR(cents)}
    </Text>
  );
}
