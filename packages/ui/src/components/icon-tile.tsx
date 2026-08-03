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
import {
  statusBadgeColors,
  type StatusBadgeVariant,
  type StatusColorRole,
} from './status-badge.logic';
import { useStatusBadgePalette } from './status-badge';

/** Tones de la pastille : ceux du StatusBadge + `document` (contenu neutre, Lot 0). */
export type IconTileTone = StatusBadgeVariant | 'document';

interface IconTileBaseProps {
  /** 28–34 (défaut 32). */
  size?: number;
  /** 9–11 (défaut 10). */
  radius?: number;
  /** Icône injectée (stroke 2, couleur pleine assortie) — aucune librairie d'icônes. */
  children?: ReactNode;
}

/**
 * Soit un TONE sémantique (mêmes variantes que StatusBadge §7, + 'document'), soit un RÔLE
 * de couleur dédié (Lot 5, arbitrage TONS RECYCLÉS : `journal.*`, `expenseCategory.*`) —
 * le fond vient alors de `role.bg`, l'icône de l'appelant se teinte en `role.ink`.
 */
export type IconTileProps = IconTileBaseProps &
  ({ tone: IconTileTone; role?: undefined } | { tone?: undefined; role: StatusColorRole });

export function IconTile(props: IconTileProps) {
  const { size = 32, radius = 10, children } = props;
  const palette = useStatusBadgePalette();
  const background =
    props.role !== undefined
      ? props.role.bg
      : props.tone === 'document'
        ? documentTile.bg
        : statusBadgeColors(props.tone, palette).bg;
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
