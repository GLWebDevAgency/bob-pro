/**
 * QuickAction — raccourci « Vite fait » (grille 4, COMPONENT_SPECS.md §6).
 * Surface radius 16, padding 14/6, colonne centrée : pastille 34 (radius 11, fond
 * pastel sémantique par tone) + icône 18 injectée, puis label 11.5/600 slate500.
 * Cible tactile ≥ 44 (minHeight/minWidth).
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { shadowNative } from '@bob/tokens';
import { font, useTheme } from '../theme';

export type QuickActionTone =
  | 'success'
  | 'danger'
  | 'warning'
  | 'ai'
  | 'b2b'
  | 'b2g'
  | 'particulier';

export interface QuickActionProps {
  /** Style du conteneur (grilles : flexBasis, flex…). */
  style?: StyleProp<ViewStyle>;
  label: string;
  /** Fond pastel de la pastille (sémantique). Défaut : ai. */
  tone?: QuickActionTone;
  /** Icône 18 injectée, couleur pleine assortie côté appelant. */
  icon?: ReactNode;
  onPress?: () => void;
}

export function QuickAction({ style,
  label, tone = 'ai', icon, onPress }: QuickActionProps) {
  const { colors, semantic, controls } = useTheme();
  const pastel: Record<QuickActionTone, string> = {
    success: semantic.successBg,
    danger: semantic.dangerBg,
    warning: semantic.warningBg,
    ai: semantic.aiBg,
    b2b: semantic.b2bBg,
    b2g: semantic.b2gBg,
    particulier: semantic.particulierBg,
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(onPress ? { onPress } : {})}
      style={[{
        backgroundColor: colors.surface,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: controls.cardBorder,
        paddingVertical: 14,
        paddingHorizontal: 6,
        alignItems: 'center',
        minHeight: 44,
        minWidth: 44,
        ...shadowNative.e1,
      }, style]}
    >
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 11,
          backgroundColor: pastel[tone],
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </View>
      <Text
        numberOfLines={2}
        style={{
          ...font('meta'),
          fontSize: 11.5,
          color: colors.slate500,
          marginTop: 8,
          textAlign: 'center',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
