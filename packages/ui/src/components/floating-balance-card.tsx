/**
 * FloatingBalanceCard — le geste signature de l'accueil (COMPONENT_SPECS.md §1).
 * Carte blanche tirée vers le haut (marginTop −30) qui chevauche la couture navy→clair
 * de l'AppHeaderNavy (paddingBottom 46). Recette figée : patterns.floatingBalanceCard.
 * Le chiffre est le héros (31/800 ink900, tabular-nums) ; la rangée verte = la voix de Bob.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View, type TextStyle } from 'react-native';
import { formatEUR } from '@bob/core';
import { patterns, shadowNative } from '@bob/tokens';
import { font, useTheme } from '../theme';

const P = patterns.floatingBalanceCard;

export interface FloatingBalanceCardProps {
  /** Eyebrow au-dessus du montant (ex. « Tu peux te verser »). */
  label: string;
  /** Montant en centimes, formaté via formatEUR (@bob/core). */
  amountCents: number;
  /** Phrase à la voix de Bob, en success — jamais un pill. */
  voiceLine: string;
  onPress?: () => void;
  /** Flèche du cercle chevron (injectée). */
  chevronIcon?: ReactNode;
  /** Icône de la pastille verte (injectée). */
  voiceIcon?: ReactNode;
}

export function FloatingBalanceCard({
  label,
  amountCents,
  voiceLine,
  onPress,
  chevronIcon,
  voiceIcon,
}: FloatingBalanceCardProps) {
  const { colors, semantic, controls } = useTheme();
  const amount = formatEUR(amountCents);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${amount}. ${voiceLine}`}
      {...(onPress ? { onPress } : {})}
      style={{
        marginTop: P.overlap,
        marginHorizontal: P.sideInset,
        backgroundColor: colors.surface,
        borderRadius: P.radius,
        borderWidth: 1,
        borderColor: controls.cardBorder,
        paddingTop: P.padding[0],
        paddingHorizontal: P.padding[1],
        paddingBottom: P.padding[2],
        minHeight: 44,
        ...shadowNative.e3,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={[font('eyebrow'), { color: colors.slate400 }]}>{label}</Text>
          <Text
            style={{
              ...font('bigNum'),
              fontSize: P.numberSize,
              fontWeight: String(P.numberWeight) as TextStyle['fontWeight'],
              color: P.numberColor,
              fontVariant: ['tabular-nums'],
              marginTop: 3,
            }}
          >
            {amount}
          </Text>
        </View>
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: colors.lineSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {chevronIcon}
        </View>
      </View>

      <View style={{ height: 1, backgroundColor: P.divider, marginVertical: 13 }} />

      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: semantic.successBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {voiceIcon}
        </View>
        <Text
          style={{
            ...font('sub'),
            fontWeight: '600',
            color: P.voiceLineColor,
            marginLeft: 10,
            flex: 1,
          }}
        >
          {voiceLine}
        </Text>
      </View>
    </Pressable>
  );
}
