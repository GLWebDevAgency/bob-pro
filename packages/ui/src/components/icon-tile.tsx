/**
 * IconTile — pastille d'icône (redlines §Fondations) : carré 28–34, radius 9–11,
 * fond pastel sémantique (tone comme StatusBadge), icône injectée en children.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { statusBadgeColors, type StatusBadgeVariant } from './status-badge.logic';
import { useStatusBadgePalette } from './status-badge';

export interface IconTileProps {
  /** Teinte pastel sémantique (mêmes variantes que StatusBadge §7). */
  tone: StatusBadgeVariant;
  /** 28–34 (défaut 32). */
  size?: number;
  /** 9–11 (défaut 10). */
  radius?: number;
  /** Icône injectée (stroke 2, couleur pleine assortie) — aucune librairie d'icônes. */
  children?: ReactNode;
}

export function IconTile({ tone, size = 32, radius = 10, children }: IconTileProps) {
  const palette = useStatusBadgePalette();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: statusBadgeColors(tone, palette).bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </View>
  );
}
