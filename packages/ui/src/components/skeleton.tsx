/**
 * SKELETONS — le socle UNIQUE du chantier états/transitions (audit 14/07, 40 findings).
 *
 * DOCTRINE FIGÉE : un skeleton Bob Pro est un bloc lineSoft STATIQUE — pas de shimmer,
 * pas de pulse. Ce n'est pas une paresse : c'est un choix (déjà dominant dans 9 écrans,
 * reduced-motion-safe par construction, calme visuellement). La fidélité se joue sur la
 * GÉOMÉTRIE : mêmes hauteurs/rayons/positions que le composant final — ZÉRO saut de layout
 * quand les données arrivent. Remplace les 9+ réimplémentations locales (SkeletonBlock/
 * SkeletonBar/SkeletonTile/SkeletonRow) — ne plus jamais en écrire une locale.
 */
import { View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { shadowNative } from '@bob/tokens';
import { useTheme } from '../theme';
import { Card } from './card';

export interface SkeletonProps {
  width?: DimensionValue;
  height: number;
  /** Rayon = celui de l'élément FINAL simulé (défaut 8 — barre de texte). */
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/** Le primitif : un rectangle lineSoft, statique, sans bordure ni ombre. */
export function Skeleton({ width = '100%', height, radius = 8, style }: SkeletonProps) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      style={[{ width, height, borderRadius: radius, backgroundColor: colors.lineSoft }, style]}
    />
  );
}

export interface SkeletonRowProps {
  /** Forme de l'avatar de tête — false = pas d'avatar. */
  avatar?: 'circle' | 'square' | false;
  /** Taille de l'avatar (défaut 44 — la ligne de liste standard). */
  avatarSize?: number;
  /** Nombre de barres de texte (1 ou 2). */
  lines?: 1 | 2;
  /** Élément de fin de ligne : pill (badge/montant court) ou barre de texte. */
  trailing?: 'pill' | 'text' | false;
  style?: StyleProp<ViewStyle>;
}

/** Une ligne de liste réelle : avatar + 1-2 barres + fin de ligne (gabarit client/[id]). */
export function SkeletonRow({
  avatar = 'circle',
  avatarSize = 44,
  lines = 2,
  trailing = 'pill',
  style,
}: SkeletonRowProps) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }, style]}>
      {avatar !== false ? (
        <Skeleton width={avatarSize} height={avatarSize} radius={avatar === 'circle' ? avatarSize / 2 : 12} />
      ) : null}
      <View style={{ flex: 1, gap: 7 }}>
        <Skeleton width="62%" height={13} />
        {lines === 2 ? <Skeleton width="40%" height={11} /> : null}
      </View>
      {trailing === 'pill' ? <Skeleton width={54} height={22} radius={999} /> : null}
      {trailing === 'text' ? <Skeleton width={64} height={13} /> : null}
    </View>
  );
}

export interface SkeletonCardProps {
  /** Hauteur TOTALE approchant la Card réelle simulée (zéro saut à l'arrivée). */
  height?: number;
  /** Barres de contenu internes (défaut 3 : titre + deux lignes). */
  contentLines?: number;
  /** Rayon de la Card réelle simulée (défaut cardLg via Card). */
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/** Une Card en chargement : le CONTENEUR est une vraie Card (ombre e1, rayon réel) —
 *  seule l'intérieur est squeletté. Remplace tout ActivityIndicator isolé dans une Card. */
export function SkeletonCard({ height, contentLines = 3, radius, style }: SkeletonCardProps) {
  const cardProps = radius !== undefined ? { radius } : {};
  return (
    <Card {...cardProps} style={[height !== undefined ? { height, overflow: 'hidden' as const } : null, style]}>
      <Skeleton width="42%" height={14} style={{ marginBottom: 12 }} />
      {Array.from({ length: Math.max(0, contentLines - 1) }, (_, index) => (
        <Skeleton key={index} width={index % 2 === 0 ? '88%' : '64%'} height={12} style={{ marginBottom: 9 }} />
      ))}
    </Card>
  );
}

export interface SkeletonHeaderProps {
  /** Si fourni, la croix de fermeture est un VRAI Pressable — jamais piégé en chargement. */
  onClose?: () => void;
  withBadge?: boolean;
}

/** Header sticky d'une vue pièce (devis/[id], facture/[id]) en chargement : la fermeture
 *  reste FONCTIONNELLE pendant que le reste est squeletté. */
export function SkeletonHeader({ onClose, withBadge = true }: SkeletonHeaderProps) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: colors.surface,
        ...shadowNative.e1,
      }}
    >
      <View style={{ gap: 6 }}>
        <Skeleton width={64} height={10} />
        <Skeleton width={120} height={16} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {withBadge ? <Skeleton width={72} height={24} radius={999} /> : null}
        {onClose ? (
          <View
            accessibilityElementsHidden={false}
            onStartShouldSetResponder={() => true}
            onResponderRelease={onClose}
            accessibilityRole="button"
            accessibilityLabel="Fermer"
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: colors.lineSoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View style={{ width: 12, height: 2, backgroundColor: colors.slate400, transform: [{ rotate: '45deg' }] }} />
            <View
              style={{
                width: 12,
                height: 2,
                backgroundColor: colors.slate400,
                transform: [{ rotate: '-45deg' }],
                marginTop: -2,
              }}
            />
          </View>
        ) : (
          <Skeleton width={38} height={38} radius={19} />
        )}
      </View>
    </View>
  );
}
