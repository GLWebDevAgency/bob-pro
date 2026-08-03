/**
 * FilterChip — chip de filtre ACTIF supprimable (Lot 3, plan DA 01/08) : libellé + croix,
 * cible tactile ≥ 44 pt (hitSlop), sélection en theme.ink (arbitrage SÉLECTION — jamais
 * l'indigo, canal exclusif de Bob). La croix est un bouton distinct : son libellé accessible
 * vient de l'APPELANT (i18n) — aucun libellé fabriqué dans @bob/ui (addendum O6).
 */
import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { font, useTheme } from '../theme';
import {
  FILTER_CHIP_HEIGHT,
  FILTER_CHIP_HIT_SLOP,
  FILTER_CHIP_REMOVE_DIAMETER,
  FILTER_CHIP_REMOVE_HIT_SLOP,
  filterChipColors,
} from './filter-chip.logic';

/** Croix ✕ — même tracé que CloseIcon d'icons.tsx (lucide-style 24×24). */
function RemoveCross({ color }: { color: string }) {
  return (
    <Svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      stroke={color}
      strokeWidth={2.2}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M18 6L6 18M6 6l12 12" />
    </Svg>
  );
}

interface FilterChipBaseProps {
  readonly label: string;
  /** Filtre représenté ACTIF (défaut) — inactif = proposition neutre (bord line). */
  readonly active?: boolean;
  readonly onPress?: () => void;
  /** Résumé accessible du chip quand le libellé seul est ambigu. */
  readonly accessibilityLabel?: string;
  readonly testID?: string;
}

/** La croix exige son libellé accessible i18n — la compilation refuse un chip supprimable
 *  muet (même contrat que `clearAccessibilityLabel` de SearchField, addendum O6). */
export type FilterChipProps = FilterChipBaseProps &
  (
    | { readonly onRemove: () => void; readonly removeAccessibilityLabel: string }
    | { readonly onRemove?: undefined; readonly removeAccessibilityLabel?: undefined }
  );

export function FilterChip({
  label,
  active = true,
  onPress,
  onRemove,
  removeAccessibilityLabel,
  accessibilityLabel,
  testID,
}: FilterChipProps) {
  const { theme, colors } = useTheme();
  const c = filterChipColors(active, {
    ink: theme.ink,
    surface: colors.surface,
    line: colors.line,
    slate500: colors.slate500,
  });
  const body = (
    <>
      <Text style={[font('meta', 600), { color: c.fg }]} numberOfLines={1}>
        {label}
      </Text>
      {onRemove !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={removeAccessibilityLabel}
          onPress={onRemove}
          hitSlop={FILTER_CHIP_REMOVE_HIT_SLOP}
          style={({ pressed }) => ({
            width: FILTER_CHIP_REMOVE_DIAMETER,
            height: FILTER_CHIP_REMOVE_DIAMETER,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <RemoveCross color={c.fg} />
        </Pressable>
      ) : null}
    </>
  );
  const frame = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bg,
    borderRadius: 999,
    paddingLeft: 10,
    paddingRight: onRemove !== undefined ? 6 : 10,
    height: FILTER_CHIP_HEIGHT,
  };
  if (onPress === undefined) {
    return (
      <View
        {...(testID !== undefined ? { testID } : {})}
        {...(accessibilityLabel !== undefined
          ? { accessible: true, accessibilityLabel }
          : {})}
        style={frame}
      >
        {body}
      </View>
    );
  }
  return (
    <Pressable
      {...(testID !== undefined ? { testID } : {})}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      hitSlop={{ top: FILTER_CHIP_HIT_SLOP, bottom: FILTER_CHIP_HIT_SLOP }}
      style={({ pressed }) => ({
        ...frame,
        opacity: pressed ? 0.8 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      {body}
    </Pressable>
  );
}
