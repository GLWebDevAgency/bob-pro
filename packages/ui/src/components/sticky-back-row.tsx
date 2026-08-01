/**
 * StickyBackRow — rangée retour sticky du HAUT d'écran (Lot 0, plan DA 01/08, arbitrage
 * STICKY BARS : « StickyBackRow reste distincte mais partage le MÊME mécanisme de voile
 * que les headers »). Fond patterns fade[1], retour NOMMÉ (jamais un « Retour » générique),
 * cible 44 pt, chevron identique à BackHeader, voile de dissolution OPTIONNEL (HeaderVeil
 * variant 'stickyBackRow' — fail-closed par construction : sans port, voile plat).
 * Consommateurs (Lot 5) : pilotage, comptabilite, cloture, depenses, recherche — AUCUN
 * migré ici.
 */
import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { font, useTheme } from '../theme';
import { HeaderVeil } from './header-veil';
import { DEFAULT_HEADER_VEIL_HEIGHT } from './header-veil.logic';
import {
  STICKY_BACK_ROW_MIN_TARGET,
  stickyBackRowContainerStyle,
} from './sticky-back-row.logic';

export interface StickyBackRowProps {
  /** Libellé visible ET annoncé — le nom de l'écran de destination. */
  readonly backLabel: string;
  readonly onBack: () => void;
  /** Voile de dissolution sous la rangée (le mécanisme unique des headers). */
  readonly veil?: boolean;
  readonly testID?: string;
}

/** Chevron ‹ — même tracé que BackHeader/ChevronLeftIcon (lucide-style 24×24, 18/2.2). */
function BackChevron({ color }: { color: string }) {
  return (
    <Svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      stroke={color}
      strokeWidth={2.2}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M15 6l-6 6 6 6" />
    </Svg>
  );
}

export function StickyBackRow({ backLabel, onBack, veil = false, testID }: StickyBackRowProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <View {...(testID !== undefined ? { testID } : {})} style={stickyBackRowContainerStyle(insets.top)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        onPress={onBack}
        hitSlop={8}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          alignSelf: 'flex-start',
          minHeight: STICKY_BACK_ROW_MIN_TARGET,
          // Press feedback standard (passe feel 18/07) — même langage que BackHeader.
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <BackChevron color={colors.ink800} />
        <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>{backLabel}</Text>
      </Pressable>
      {veil ? (
        // La dissolution s'étend SOUS la rangée : boîte absolue ancrée à son bord bas.
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            height: DEFAULT_HEADER_VEIL_HEIGHT,
          }}
        >
          <HeaderVeil variant="stickyBackRow" />
        </View>
      ) : null}
    </View>
  );
}
