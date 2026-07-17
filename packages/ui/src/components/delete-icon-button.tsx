/**
 * DeleteIconButton — LE bouton corbeille canonique @bob/ui (suppression destructive).
 * Inventaire des corbeilles déjà en prod avant création (même famille visuelle partout) :
 * DocumentActions/InvoiceActions (brouillon facture, 52×52/16), carte brouillon devis de
 * l'écran Aujourd'hui (40×40/12), PieceDetailView swipe ligne de devis (R6, action pleine
 * hauteur) — toutes fond `semantic.dangerBg`, icône `semantic.danger`, spinner
 * ActivityIndicator au chargement, opacité 0,5 désactivé/chargement. Ce composant fige ce
 * style en UN SEUL endroit pour toute nouvelle surface (catalogue C27 et suivantes).
 *
 * @bob/ui n'embarque aucune lib d'icônes (cf. Fab/AppHeaderNavy/IconTile) : l'icône trash-2
 * est injectée par l'appelant (`<Feather name="trash-2" color={semantic.danger} />` côté
 * apps/mobile) — seuls l'emplacement, le fond et la cible tactile sont figés ici.
 */
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import {
  clampDeleteIconButtonSize,
  deleteIconButtonOpacity,
  DELETE_ICON_BUTTON_HIT_SLOP_DEFAULT,
  DELETE_ICON_BUTTON_RADIUS_DEFAULT,
} from './delete-icon-button.logic';

export interface DeleteIconButtonProps {
  /** Icône injectée (aucune lib d'icônes dans @bob/ui) — canonique :
   *  `<Feather name="trash-2" size={18-20} color={semantic.danger} />`. */
  icon: ReactNode;
  /** Requis — jamais un bouton corbeille muet pour un lecteur d'écran. */
  accessibilityLabel: string;
  onPress: () => void;
  /** Diamètre — clampé à ≥ 44 (cible tactile) même si une valeur plus petite est passée. */
  size?: number;
  radius?: number;
  loading?: boolean;
  disabled?: boolean;
  hitSlop?: number;
  style?: StyleProp<ViewStyle>;
}

export function DeleteIconButton({
  icon,
  accessibilityLabel,
  onPress,
  size,
  radius = DELETE_ICON_BUTTON_RADIUS_DEFAULT,
  loading = false,
  disabled = false,
  hitSlop = DELETE_ICON_BUTTON_HIT_SLOP_DEFAULT,
  style,
}: DeleteIconButtonProps) {
  const { semantic } = useTheme();
  const isDisabled = disabled || loading;
  const resolvedSize = clampDeleteIconButtonSize(size);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      hitSlop={hitSlop}
      onPress={onPress}
      style={[
        {
          width: resolvedSize,
          height: resolvedSize,
          borderRadius: radius,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: semantic.dangerBg,
          opacity: deleteIconButtonOpacity(disabled, loading),
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={semantic.danger} /> : icon}
    </Pressable>
  );
}
