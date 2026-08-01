/**
 * IconTile — pastille d'icône (redlines §Fondations) : carré 28–34, radius 9–11,
 * fond pastel sémantique (tone comme StatusBadge), icône injectée en children.
 * Lot 0 (plan DA 01/08) : tone additif `'document'` — famille de CONTENU neutre
 * (tuile documents de la recherche : le vert reste réservé à l'argent, l'intérim
 * b2g est refusé par l'arbitrage TONS RECYCLÉS). Couleurs = tokens `documentTile`.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { documentTile } from '@bob/tokens';
import { statusBadgeColors, type StatusBadgeVariant } from './status-badge.logic';
import { useStatusBadgePalette } from './status-badge';

/** Tones de la pastille : ceux du StatusBadge + `document` (contenu neutre, Lot 0). */
export type IconTileTone = StatusBadgeVariant | 'document';

export interface IconTileProps {
  /** Teinte pastel sémantique (mêmes variantes que StatusBadge §7, + 'document'). */
  tone: IconTileTone;
  /** 28–34 (défaut 32). */
  size?: number;
  /** 9–11 (défaut 10). */
  radius?: number;
  /** Icône injectée (stroke 2, couleur pleine assortie) — aucune librairie d'icônes. */
  children?: ReactNode;
}

export function IconTile({ tone, size = 32, radius = 10, children }: IconTileProps) {
  const palette = useStatusBadgePalette();
  const background =
    tone === 'document' ? documentTile.bg : statusBadgeColors(tone, palette).bg;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </View>
  );
}
