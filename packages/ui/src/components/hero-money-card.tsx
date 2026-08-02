/**
 * HeroMoneyCard — §12 (Argent, « te verser »).
 * Dégradé héros 150deg (grad.hero), radius 24, padding 20, ombre heroMoney,
 * halo vert radial (overlays.haloGreen). Le chiffre est le héros : heroNum
 * blanc tabular-nums + pill « sans risque » optionnel + phrase explicative.
 */
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { rgbaStop } from './halo-stops';
import { formatEUR } from '@bob/core';
import { shadowComponentsNative, shadowNative } from '@bob/tokens';
import { font, parseGradient, useTheme } from '../theme';
import { Skeleton } from './skeleton';

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
              <Stop
                offset="0"
                stopColor={rgbaStop(overlays.haloGreen[0]).color}
                stopOpacity={rgbaStop(overlays.haloGreen[0]).opacity}
              />
              <Stop
                offset="1"
                stopColor={rgbaStop(overlays.haloGreen[1]).color}
                stopOpacity={rgbaStop(overlays.haloGreen[1]).opacity}
              />
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

export interface HeroMoneyCardPlaceholderProps {
  /** Le MÊME label que la carte pleine (« trésorerie mobilisable »). */
  readonly label: string;
  /** Premier chargement : skeletons montant + pill + caption ; sinon « — » honnête. */
  readonly loading: boolean;
}

/**
 * État loading/failed INTÉGRÉ de la HeroMoneyCard (Lot 1, plan DA 01/08) : MÊME géométrie
 * (radius 24, padding 20 — label → montant heroNum + pill → caption) — zéro saut quand la
 * donnée arrive, jamais un montant inventé (A1-C10). Surface claire (pas le dégradé) : un
 * héros sans chiffre ne porte pas la matière du chiffre. Remplace le HeroPlaceholder local
 * d'argent.tsx — la géométrie du héros ne vit plus qu'à côté du composant qu'elle mime.
 */
export function HeroMoneyCardPlaceholder({ label, loading }: HeroMoneyCardPlaceholderProps) {
  const { colors, controls } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 24,
        borderWidth: 1,
        borderColor: controls.cardBorder,
        padding: 20,
        ...shadowNative.e2,
      }}
    >
      <Text style={[font('label'), { color: colors.slate400 }]}>{label}</Text>
      {loading ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <Skeleton width="52%" height={34} radius={9} />
            <Skeleton width={92} height={22} radius={999} />
          </View>
          <Skeleton width="74%" height={13} style={{ marginTop: 9 }} />
        </>
      ) : (
        <Text style={{ ...font('heroNum'), color: colors.slate400, marginTop: 4 }}>—</Text>
      )}
    </View>
  );
}
