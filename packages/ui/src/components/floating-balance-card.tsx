/**
 * FloatingBalanceCard — le geste signature de l'accueil (COMPONENT_SPECS.md §1).
 * Carte blanche tirée vers le haut (marginTop −30) qui chevauche la couture navy→clair
 * de l'AppHeaderNavy (paddingBottom 46). Recette figée : patterns.floatingBalanceCard.
 * Le chiffre est le héros (31/800 ink900, tabular-nums) ; la rangée verte = la voix de Bob.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatEURWhole } from '@bob/core';
import { patterns, shadowNative } from '@bob/tokens';
import { font, useTheme } from '../theme';
import { PressableScale } from './pressable-scale';
import { Skeleton } from './skeleton';

const P = patterns.floatingBalanceCard;

/** Pastille discrète de fiabilité SUR le montant (ex. « estimation prudente », SPEC_EXPERT_FISCAL
 * amendement 2 : « Home = simple badge de fiabilité — pas de 2ᵉ carte/nag »). Cible tactile propre
 * (hitSlop) : ne concurrence PAS le tap sur la carte entière (onPress dédié, arrêt de propagation
 * natif de Pressable imbriqué). */
export interface FloatingBalanceCardBadge {
  readonly label: string;
  readonly onPress: () => void;
  readonly accessibilityHint?: string;
}

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
  /** Badge de fiabilité optionnel, ADDITIF (défaut absent = géométrie inchangée). */
  badge?: FloatingBalanceCardBadge;
}

export function FloatingBalanceCard({
  label,
  amountCents,
  voiceLine,
  onPress,
  chevronIcon,
  voiceIcon,
  badge,
}: FloatingBalanceCardProps) {
  const { colors, semantic, controls, radius } = useTheme();
  const amount = formatEURWhole(amountCents);

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
      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Text style={[font('eyebrow'), { color: colors.slate400 }]}>{label}</Text>
          <Text
            style={{
              ...font('bigNum'),
              fontSize: P.numberSize,
              letterSpacing: P.numberTracking,
              color: P.numberColor,
              fontVariant: ['tabular-nums'],
              marginTop: 3,
            }}
          >
            {amount}
          </Text>
          {badge ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={badge.label}
              {...(badge.accessibilityHint ? { accessibilityHint: badge.accessibilityHint } : {})}
              onPress={badge.onPress}
              hitSlop={10}
              style={{
                alignSelf: 'flex-start',
                marginTop: 7,
                minHeight: 26,
                justifyContent: 'center',
                backgroundColor: controls.segmentedTrack,
                borderRadius: radius.pill,
                paddingHorizontal: 9,
                paddingVertical: 3,
              }}
            >
              <Text style={[font('meta', 600), { fontSize: 11.5, color: colors.slate500 }]}>{badge.label}</Text>
            </Pressable>
          ) : null}
        </View>
        <View
          style={{
            width: 30,
            height: 30,
            marginTop: 3,
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
            borderRadius: 10,
            backgroundColor: semantic.successBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {voiceIcon}
        </View>
        <Text
          style={{
            ...font('sub', 600),
            color: P.voiceLineColor,
            marginLeft: 10,
            flex: 1,
            lineHeight: 18,
          }}
        >
          {voiceLine}
        </Text>
      </View>
    </Pressable>
  );
}

export interface FloatingBalanceCardPlaceholderProps {
  /** Eyebrow au-dessus du tiret/skeleton — le MÊME label que la carte pleine. */
  readonly label: string;
  /**
   * Voix de Bob sous le tiret : dit POURQUOI il n'y a pas de chiffre et le geste attendu
   * (i18n côté écran — confirmation attendue vs indisponibilité réelle).
   */
  readonly hint: string;
  /** Premier chargement : skeleton du montant (pulse fail-closed du socle), hint masqué. */
  readonly loading: boolean;
  readonly onPress: () => void;
}

/**
 * État loading/failed INTÉGRÉ de la FloatingBalanceCard (Lot 1, plan DA 01/08) : MÊME
 * recette `patterns.floatingBalanceCard` que la carte pleine — zéro saut de layout quand la
 * donnée arrive, et JAMAIS un montant inventé (A1-C10). Remplace le HeroPlaceholder local
 * de l'accueil : la géométrie du héros ne vit plus qu'ICI, à côté du composant qu'elle mime.
 */
export function FloatingBalanceCardPlaceholder({
  label,
  hint,
  loading,
  onPress,
}: FloatingBalanceCardPlaceholderProps) {
  const { colors, controls } = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={loading ? label : hint}
      accessibilityState={{ busy: loading }}
      onPress={onPress}
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
      <Text style={[font('eyebrow'), { color: colors.slate400 }]}>{label}</Text>
      {loading ? (
        <Skeleton height={31} width="46%" radius={8} style={{ marginTop: 6 }} />
      ) : (
        <Text
          style={{
            ...font('bigNum'),
            fontSize: P.numberSize,
            letterSpacing: P.numberTracking,
            color: colors.slate400,
            marginTop: 3,
          }}
        >
          —
        </Text>
      )}
      {!loading ? (
        <Text style={[font('meta'), { color: colors.slate500, marginTop: 5 }]}>{hint}</Text>
      ) : null}
    </PressableScale>
  );
}
