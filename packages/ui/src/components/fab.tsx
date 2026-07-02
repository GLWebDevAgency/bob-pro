/**
 * Fab — bouton d'action flottant (COMPONENT_SPECS.md §15).
 * 58×58, radius 20, dégradé fab du thème (145deg, ink2→d1), ombre e3.
 * Position absolue right 18 / bottom 104 (au-dessus de la tab bar), surchargeable.
 * Icône injectée ; défaut = « + » en colors.surface. accessibilityLabel requis.
 */
import type { ReactNode } from 'react';
import { Pressable, Text } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { shadowNative } from '@bob/tokens';
import { parseGradient, useTheme } from '../theme';

const SIZE = 58;
const RADIUS = 20;

export interface FabProps {
  /** false = rendu dans le flux (galerie, compositions) au lieu d'absolute. */
  floating?: boolean;
  readonly onPress: () => void;
  readonly accessibilityLabel: string;
  /** Icône injectée (aucune lib d'icônes) — défaut : « + » blanc. */
  readonly icon?: ReactNode;
  readonly right?: number;
  readonly bottom?: number;
}

export function Fab({ onPress, accessibilityLabel, icon, right = 18, bottom = 104, floating = true }: FabProps) {
  const { grad, colors } = useTheme();
  const gradient = parseGradient(grad.fab);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      style={({ pressed }) => [
        {
          ...(floating ? ({ position: 'absolute' } as const) : null),
          right,
          bottom,
          width: SIZE,
          height: SIZE,
          minWidth: 44,
          minHeight: 44,
          borderRadius: RADIUS,
          ...shadowNative.e3,
        },
        pressed && { transform: [{ scale: 0.94 }] },
      ]}
    >
      <LinearGradient
        colors={gradient.colors}
        start={gradient.start}
        end={gradient.end}
        style={{
          flex: 1,
          borderRadius: RADIUS,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon ?? (
          <Text
            accessible={false}
            style={{ color: colors.surface, fontSize: 28, lineHeight: 32, fontWeight: '400' }}
          >
            +
          </Text>
        )}
      </LinearGradient>
    </Pressable>
  );
}

/** Alias redlines §15. */
export const FAB = Fab;
