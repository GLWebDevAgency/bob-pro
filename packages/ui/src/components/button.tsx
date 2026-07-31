/**
 * Button — redlines §18. 5 types (primaire dégradé cta · secondaire · IA · IA plein
 * `aiSolid` (indigo #semantic.ai du handoff, CTA 1-tap) · danger léger) + état désactivé. Hauteur ≥ 44, radius 11–15, icône injectée, press scale 0.94.
 * `size="compact"` : CTA de carte priorité (réf dc.html) — padding 9/15, texte 13.5/600,
 * fond primaire en aplat ink (pas de dégradé aux petites tailles), hitSlop pour ≥ 44.
 * `trailingIcon` : icône après le libellé (ex. chevron › du diagnostic).
 */
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type AccessibilityRole,
  type AccessibilityState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme, font, parseGradient } from '../theme';
import {
  BUTTON_COMPACT_FONT_SIZE,
  BUTTON_COMPACT_HIT_SLOP,
  BUTTON_COMPACT_PADDING_HORIZONTAL,
  BUTTON_COMPACT_PADDING_VERTICAL,
  BUTTON_ICON_GAP,
  BUTTON_MIN_HEIGHT,
  BUTTON_PRESSED_SCALE,
  clampButtonRadius,
  resolveButtonAppearance,
  type ButtonVariant,
} from './button.logic';

export type { ButtonVariant };

export type ButtonSize = 'regular' | 'compact';

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  /** Radius 11–15 (redlines §18) — contraint par clampButtonRadius. */
  radius?: number;
  /** Icône injectée (aucune librairie d'icônes) — rendue à gauche, gap 7. */
  icon?: ReactNode;
  /** Icône rendue APRÈS le libellé (chevron de navigation…). */
  trailingIcon?: ReactNode;
  /** compact = CTA de carte (padding 9/15, 13.5/600) ; regular = bouton plein (défaut). */
  size?: ButtonSize;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  radius,
  icon,
  trailingIcon,
  size = 'regular',
  style,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
}: ButtonProps) {
  const { colors, semantic, controls, grad, theme } = useTheme();
  const compact = size === 'compact';

  const appearance = resolveButtonAppearance(variant, disabled, {
    surface: colors.surface,
    ink600: colors.ink600,
    slate300: colors.slate300,
    danger: semantic.danger,
    ai: semantic.ai,
    segmentedTrack: controls.segmentedTrack,
    buttonSecondaryBorder: controls.buttonSecondaryBorder,
  });
  const borderRadius = clampButtonRadius(radius);
  // Aux petites tailles la réf pose un aplat ink : le dégradé cta reste aux boutons pleins.
  const gradient = appearance.gradient && !compact ? parseGradient(grad.cta) : null;
  const backgroundColor =
    appearance.gradient && compact ? theme.ink : appearance.backgroundColor;

  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: BUTTON_ICON_GAP,
        ...(compact
          ? {
              paddingVertical: BUTTON_COMPACT_PADDING_VERTICAL,
              paddingHorizontal: BUTTON_COMPACT_PADDING_HORIZONTAL,
            }
          : { minHeight: BUTTON_MIN_HEIGHT, paddingHorizontal: 18 }),
      }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={appearance.textColor} />
      ) : (
        icon
      )}
      <Text
        style={[
          compact ? { ...font('sub', 600), fontSize: BUTTON_COMPACT_FONT_SIZE } : font('button'),
          { color: appearance.textColor },
        ]}
      >
        {title}
      </Text>
      {loading ? null : trailingIcon}
    </View>
  );

  return (
    <Pressable
      {...(onPress ? { onPress } : {})}
      disabled={disabled || loading}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{
        ...accessibilityState,
        disabled: disabled || accessibilityState?.disabled === true,
        busy: loading || accessibilityState?.busy === true,
      }}
      {...(compact ? { hitSlop: BUTTON_COMPACT_HIT_SLOP } : {})}
      style={({ pressed }) => [
        {
          borderRadius,
          overflow: 'hidden',
          backgroundColor,
          borderColor: appearance.borderColor,
          borderWidth: appearance.borderWidth,
          transform: [{ scale: pressed && !disabled ? BUTTON_PRESSED_SCALE : 1 }],
          ...(compact ? {} : { minHeight: BUTTON_MIN_HEIGHT, minWidth: BUTTON_MIN_HEIGHT }),
        },
        style,
      ]}
    >
      {gradient ? (
        <LinearGradient
          colors={gradient.colors}
          start={gradient.start}
          end={gradient.end}
        >
          {content}
        </LinearGradient>
      ) : (
        content
      )}
    </Pressable>
  );
}
