/**
 * StatusStrip — bandeau d'état (Lot 0, plan DA 01/08) : icône injectée + fond sémantique
 * pastel + encre foncée AA. Résorbe 6 duplications (PieceDetailView deposit/progress/
 * paidDone, facture/[id] ×3, transmission ×2) — consommateurs migrés dans LEURS lots,
 * jamais ici. Texte sur l'échelle (label 13/600) : les 12,5 ad hoc s'arrondissent au cran
 * existant (arbitrage TYPO — aucune demi-taille tokenisée).
 */
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { surfaceTint } from '@bob/tokens';
import { font, useTheme } from '../theme';
import {
  STATUS_STRIP_GAP,
  STATUS_STRIP_PADDING_HORIZONTAL,
  STATUS_STRIP_PADDING_VERTICAL,
  STATUS_STRIP_RADIUS,
  statusStripColors,
  type StatusStripPalette,
  type StatusStripTone,
} from './status-strip.logic';

export type { StatusStripTone };

/** Construit la palette du bandeau depuis le thème (+ l'encre danger de surfaceTint). */
export function useStatusStripPalette(): StatusStripPalette {
  const { colors, semantic } = useTheme();
  return {
    successBg: semantic.successBg,
    successInk: semantic.successInk,
    warningBg: semantic.warningBg,
    warningInk: semantic.warningInk,
    dangerBg: semantic.dangerBg,
    // L'encre danger foncée AA du kit matière (semantic.danger nu : 4,10:1 < 4,5).
    dangerInk: surfaceTint.light.danger.ink,
    b2bBg: semantic.b2bBg,
    b2bInk: semantic.b2b,
    neutralBg: colors.lineSoft,
    neutralInk: colors.slate500,
  };
}

export interface StatusStripProps {
  readonly tone: StatusStripTone;
  /** Texte d'état — déjà i18n-isé par l'écran. */
  readonly label: string;
  /** Icône injectée (≈ 15, teinte assortie côté appelant) — aucune lib d'icônes. */
  readonly icon?: ReactNode;
  /** Résumé accessible quand le libellé seul est ambigu. */
  readonly accessibilityLabel?: string;
  readonly testID?: string;
}

export function StatusStrip({ tone, label, icon, accessibilityLabel, testID }: StatusStripProps) {
  const palette = useStatusStripPalette();
  const { bg, ink } = statusStripColors(tone, palette);
  return (
    <View
      {...(testID !== undefined ? { testID } : {})}
      {...(accessibilityLabel !== undefined ? { accessible: true, accessibilityLabel } : {})}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: STATUS_STRIP_GAP,
        backgroundColor: bg,
        borderRadius: STATUS_STRIP_RADIUS,
        paddingVertical: STATUS_STRIP_PADDING_VERTICAL,
        paddingHorizontal: STATUS_STRIP_PADDING_HORIZONTAL,
      }}
    >
      {icon !== undefined ? icon : null}
      <Text
        accessible={accessibilityLabel === undefined}
        style={[font('label', 600), { color: ink, flex: 1 }]}
      >
        {label}
      </Text>
    </View>
  );
}
