/**
 * Button — redlines §18. 4 types (primaire dégradé cta · secondaire · IA · danger léger)
 * + état désactivé. Hauteur ≥ 44, radius 11–15, icône injectée, press scale 0.94.
 */
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme, font, parseGradient } from '../theme';
import {
  BUTTON_ICON_GAP,
  BUTTON_MIN_HEIGHT,
  BUTTON_PRESSED_SCALE,
  clampButtonRadius,
  resolveButtonAppearance,
  type ButtonVariant,
} from './button.logic';

export type { ButtonVariant };

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
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  radius,
  icon,
  style,
  accessibilityLabel,
}: ButtonProps) {
  const { colors, semantic, controls, grad } = useTheme();

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
  const gradient = appearance.gradient ? parseGradient(grad.cta) : null;

  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: BUTTON_ICON_GAP,
        minHeight: BUTTON_MIN_HEIGHT,
        paddingHorizontal: 18,
      }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={appearance.textColor} />
      ) : (
        icon
      )}
      <Text style={[font('button'), { color: appearance.textColor }]}>{title}</Text>
    </View>
  );

  return (
    <Pressable
      {...(onPress ? { onPress } : {})}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled, busy: loading }}
      style={({ pressed }) => [
        {
          borderRadius,
          minHeight: BUTTON_MIN_HEIGHT,
          minWidth: BUTTON_MIN_HEIGHT,
          overflow: 'hidden',
          backgroundColor: appearance.backgroundColor,
          borderColor: appearance.borderColor,
          borderWidth: appearance.borderWidth,
          transform: [{ scale: pressed && !disabled ? BUTTON_PRESSED_SCALE : 1 }],
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
