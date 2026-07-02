/**
 * Card — carte standard (redlines §Fondations) : surface, radius 18 (18–22),
 * bordure controls.cardBorder, ombre e1 (repos) / e2 (surélevée), padding 15–18.
 */
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { shadowNative } from '@bob/tokens';
import { useTheme } from '../theme';

export interface CardProps {
  children: ReactNode;
  /** 18–22 selon densité (défaut radius.cardLg = 18). */
  radius?: number;
  /** e1 = repos · e2 = surélevée. */
  elevation?: 'e1' | 'e2';
  /** 15–18 (défaut 16). */
  padding?: number;
  style?: StyleProp<ViewStyle>;
}

export function Card({ children, radius, elevation = 'e1', padding = 16, style }: CardProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderRadius: radius ?? theme.radius.cardLg,
          borderWidth: 1,
          borderColor: theme.controls.cardBorder,
          padding,
        },
        shadowNative[elevation],
        style,
      ]}
    >
      {children}
    </View>
  );
}
