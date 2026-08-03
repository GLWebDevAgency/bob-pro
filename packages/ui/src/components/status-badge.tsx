/**
 * StatusBadge — redlines §7 : 5 variantes texte + fond pastel (11/700, padding 2/7, radius 6).
 * Chip — mode filtre : actif = fond ink du thème, inactif = surface + bord line, hauteur 34.
 */
import { Pressable, Text, View } from 'react-native';
import { useTheme, font } from '../theme';
import {
  BADGE_FONT_SIZE,
  BADGE_PADDING_HORIZONTAL,
  BADGE_PADDING_VERTICAL,
  BADGE_RADIUS,
  CHIP_HEIGHT,
  CHIP_HIT_SLOP,
  chipColors,
  statusBadgeColors,
  statusBadgeRoleColors,
  type StatusBadgePalette,
  type StatusBadgeVariant,
  type StatusColorRole,
} from './status-badge.logic';

export type { StatusBadgeVariant, StatusColorRole };

/** Construit la palette §7 depuis le contexte de thème (réutilisé par Avatar/IconTile). */
export function useStatusBadgePalette(): StatusBadgePalette {
  const { semantic, controls, colors } = useTheme();
  return {
    danger: semantic.danger,
    dangerBadgeBg: controls.dangerBadgeBg,
    // P1 §1.5 — badge `neutral` (Retirée, Résilié, Échu) : texte courant sur séparateur doux.
    neutralInk: colors.slate500,
    neutralBg: colors.lineSoft,
    warning: semantic.warning,
    warningBg: semantic.warningBg,
    b2b: semantic.b2b,
    b2bBg: semantic.b2bBg,
    b2g: semantic.b2g,
    b2gBg: semantic.b2gBg,
    particulier: semantic.particulier,
    particulierBg: semantic.particulierBg,
    success: semantic.success,
    successBg: semantic.successBg,
    // Lot 0 — variant 'ai' : mêmes teintes que le Badge legacy tone 'ai' (migration au pixel).
    ai: semantic.ai,
    aiBg: semantic.aiBg,
  };
}

/**
 * Soit une VARIANTE sémantique (états, typologies client), soit un RÔLE de couleur dédié
 * (Lot 5, arbitrage TONS RECYCLÉS : journaux comptables, catégories de dépense) — jamais
 * les deux : le rôle existe précisément pour que la variante cesse de mentir.
 */
export type StatusBadgeProps = { label: string } & (
  | { variant: StatusBadgeVariant; role?: undefined }
  | { variant?: undefined; role: StatusColorRole }
);

export function StatusBadge(props: StatusBadgeProps) {
  const { label } = props;
  const palette = useStatusBadgePalette();
  const { fg, bg } =
    props.role !== undefined
      ? statusBadgeRoleColors(props.role)
      : statusBadgeColors(props.variant, palette);
  return (
    <View
      accessibilityRole="text"
      style={{
        alignSelf: 'flex-start',
        backgroundColor: bg,
        borderRadius: BADGE_RADIUS,
        paddingVertical: BADGE_PADDING_VERTICAL,
        paddingHorizontal: BADGE_PADDING_HORIZONTAL,
      }}
    >
      <Text style={[font('label', 700), { fontSize: BADGE_FONT_SIZE, color: fg }]}>
        {label}
      </Text>
    </View>
  );
}

export interface ChipProps {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  accessibilityRole?: 'button' | 'radio';
}

/** Chip de filtre — hauteur 34, hitSlop pour un hit-target ≥ 44. */
export function Chip({
  label,
  active = false,
  disabled = false,
  onPress,
  accessibilityRole = 'button',
}: ChipProps) {
  const { colors, theme, radius } = useTheme();
  const c = chipColors(active, {
    ink: theme.ink,
    surface: colors.surface,
    line: colors.line,
    slate500: colors.slate500,
  });
  return (
    <Pressable
      {...(onPress ? { onPress } : {})}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={label}
      accessibilityState={
        accessibilityRole === 'radio'
          ? { checked: active, disabled }
          : { selected: active, disabled }
      }
      disabled={disabled}
      hitSlop={{ top: CHIP_HIT_SLOP, bottom: CHIP_HIT_SLOP }}
      style={({ pressed }) => ({
        height: CHIP_HEIGHT,
        minWidth: 44,
        paddingHorizontal: 14,
        borderRadius: radius.chip,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.bg,
        borderWidth: 1,
        borderColor: c.border,
        // Press feedback standard (passe feel 18/07) — même langage que PressableScale.
        opacity: disabled ? 0.48 : pressed ? 0.8 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Text style={[font('label'), { color: c.fg }]}>{label}</Text>
    </Pressable>
  );
}
