/**
 * PressableRow — carte pressable icône + titre + sous-titre + chevron (redlines menu profil /
 * Compte / Facturation & modèles). Facteur commun des rangées de navigation déjà répétées à la
 * main dans compte.tsx (Facturation & modèles, Mon profil fiscal…) — extrait pour le nouveau menu
 * profil, réutilisable partout où ce motif revient.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { shadowNative } from '@bob/tokens';
import { font, useTheme } from '@bob/ui';
import { ChevronRightIcon } from './icons';

export interface PressableRowProps {
  readonly onPress: () => void;
  readonly icon: ReactNode;
  readonly title: string;
  readonly subtitle?: string;
  readonly accessibilityLabel?: string;
  readonly trailing?: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

export function PressableRow({ onPress, icon, title, subtitle, accessibilityLabel, trailing, style }: PressableRowProps) {
  const { colors, controls, radius } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}. ${subtitle}` : title)}
      onPress={onPress}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 11,
          minHeight: 44,
          backgroundColor: colors.surface,
          borderRadius: radius.cardLg,
          borderWidth: 1,
          borderColor: controls.cardBorder,
          padding: 15,
        },
        shadowNative.e1,
        style,
      ]}
    >
      {icon}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[font('sub', 600), { fontSize: 14.5, color: colors.ink800 }]}>{title}</Text>
        {subtitle ? (
          <Text numberOfLines={1} style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ?? <ChevronRightIcon color={colors.slate300} size={17} />}
    </Pressable>
  );
}
