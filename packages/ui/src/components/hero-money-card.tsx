/**
 * HeroMoneyCard — §12 (Argent, « te verser »).
 * Dégradé héros 150deg (grad.hero), radius 24, padding 20, ombre heroMoney,
 * halo vert radial (overlays.haloGreen). Le chiffre est le héros : heroNum
 * blanc tabular-nums + pill « sans risque » optionnel + phrase explicative.
 */
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { formatEUR } from '@bob/core';
import { shadowComponentsNative } from '@bob/tokens';
import { font, parseGradient, useTheme } from '../theme';

export interface HeroMoneyCardProps {
  label: string;
  amountCents: number;
  pill?: string;
  caption?: string;
}

export function HeroMoneyCard({ label, amountCents, pill, caption }: HeroMoneyCardProps) {
  const { grad, colors, semantic, overlays, radius } = useTheme();
  const gradient = parseGradient(grad.hero);
  const amountText = formatEUR(amountCents);

  return (
    <View style={[styles.shadowWrap, shadowComponentsNative.heroMoney]}>
      <LinearGradient
        colors={gradient.colors}
        start={gradient.start}
        end={gradient.end}
        style={styles.card}
        accessible
        accessibilityLabel={[label, amountText, pill, caption].filter(Boolean).join(', ')}
      >
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient id="heroMoneyHalo" cx="85%" cy="8%" r="75%">
              <Stop offset="0" stopColor={overlays.haloGreen[0]} />
              <Stop offset="1" stopColor={overlays.haloGreen[1]} />
            </RadialGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#heroMoneyHalo)" />
        </Svg>
        <Text style={[font('label'), { color: overlays.white66 }]}>{label}</Text>
        <View style={styles.amountRow}>
          <Text style={[font('heroNum'), styles.amount, { color: colors.surface }]}>
            {amountText}
          </Text>
          {pill !== undefined ? (
            <View
              style={[
                styles.pill,
                { backgroundColor: overlays.successPill, borderRadius: radius.pill },
              ]}
            >
              <Text style={[font('meta'), styles.pillText, { color: semantic.successOnDark }]}>
                {pill}
              </Text>
            </View>
          ) : null}
        </View>
        {caption !== undefined ? (
          <Text style={[font('sub'), styles.caption, { color: overlays.white66 }]}>{caption}</Text>
        ) : null}
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  shadowWrap: { borderRadius: 24 },
  card: { borderRadius: 24, padding: 20, overflow: 'hidden' },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  amount: { fontVariant: ['tabular-nums'] },
  pill: { paddingVertical: 3, paddingHorizontal: 9 },
  pillText: { fontSize: 12, fontWeight: '700' },
  caption: { marginTop: 7 },
});
