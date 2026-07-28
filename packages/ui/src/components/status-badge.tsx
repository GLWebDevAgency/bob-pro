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
  type StatusBadgePalette,
  type StatusBadgeVariant,
} from './status-badge.logic';

export type { StatusBadgeVariant };

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
  };
}

export interface StatusBadgeProps {
  label: string;
  variant: StatusBadgeVariant;
}

export function StatusBadge({ label, variant }: StatusBadgeProps) {
  const palette = useStatusBadgePalette();
  const { fg, bg } = statusBadgeColors(variant, palette);
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
  onPress?: () => void;
}

/** Chip de filtre — hauteur 34, hitSlop pour un hit-target ≥ 44. */
export function Chip({ label, active = false, onPress }: ChipProps) {
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
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
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
        opacity: pressed ? 0.8 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Text style={[font('label'), { color: c.fg }]}>{label}</Text>
    </Pressable>
  );
}
