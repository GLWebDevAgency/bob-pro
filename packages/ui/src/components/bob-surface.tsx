/**
 * BobSurface — surface teintée du kit « matière Bob » (P1 §1.2), 100 % ADDITIF : les écrans
 * existants gardent `Card`. Opaque par construction (jamais la transparence iOS), bord
 * renforcé en Increase Contrast, ombre e2 réservée à l'emphase `floating`.
 */
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { radius as radiusTokens, shadowNative } from '@bob/tokens';
import { useTheme } from '../theme';
import {
  bobSurfaceColors,
  type BobSurfaceEmphasis,
  type BobSurfaceTone,
} from './bob-surface.logic';

export type { BobSurfaceEmphasis, BobSurfaceTone };

export interface BobSurfaceProps {
  children: ReactNode;
  tone?: BobSurfaceTone;
  emphasis?: BobSurfaceEmphasis;
  /** Rayon (défaut radius.cardLg = 18). */
  radius?: number;
  /** Padding interne (défaut 16). */
  padding?: number;
  /** Increase Contrast (a11y) — bord 2 pt encre pleine. */
  highContrast?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function BobSurface({
  children,
  tone = 'neutral',
  emphasis = 'flat',
  radius,
  padding = 16,
  highContrast = false,
  style,
}: BobSurfaceProps) {
  const { appearance } = useTheme();
  const colors = bobSurfaceColors({ tone, emphasis, appearance, highContrast });
  return (
    <View
      style={[
        {
          backgroundColor: colors.backgroundColor,
          borderRadius: radius ?? radiusTokens.cardLg,
          borderWidth: colors.borderWidth,
          borderColor: colors.borderColor,
          padding,
        },
        colors.elevated ? shadowNative.e2 : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}
