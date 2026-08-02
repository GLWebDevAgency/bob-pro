/**
 * BobSwitch — interrupteur tokenisé du kit (Lot 4, plan DA 01/08). Remplace le Switch
 * natif (couleurs plateforme hors tokens) : piste theme.ink à l'état ON (sélection
 * utilisateur = ink PARTOUT — arbitrage SÉLECTION), pouce surface, cible 44 pt.
 * FAIL-CLOSED par construction : aucune animation — le pouce BASCULE (première frame
 * = état final, aucune fenêtre d'ignorance possible). rôle `switch` + état `checked`.
 */
import { Pressable, View } from 'react-native';
import { shadowNative } from '@bob/tokens';
import { useTheme } from '../theme';
import {
  BOB_SWITCH_THUMB_SIZE,
  BOB_SWITCH_TRACK_HEIGHT,
  BOB_SWITCH_TRACK_WIDTH,
  bobSwitchThumbOffset,
  bobSwitchTrackColor,
} from './bob-switch.logic';

export interface BobSwitchProps {
  readonly value: boolean;
  readonly onValueChange: (next: boolean) => void;
  /** Libellé accessible OBLIGATOIRE — un interrupteur muet ne dit rien au lecteur d'écran. */
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly testID?: string;
}

export function BobSwitch({
  value,
  onValueChange,
  accessibilityLabel,
  disabled = false,
  testID,
}: BobSwitchProps) {
  const { theme, colors, controls, radius } = useTheme();
  return (
    <Pressable
      {...(testID !== undefined ? { testID } : {})}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      hitSlop={8}
      style={{
        minHeight: 44,
        minWidth: 44,
        justifyContent: 'center',
        alignItems: 'flex-end',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <View
        style={{
          width: BOB_SWITCH_TRACK_WIDTH,
          height: BOB_SWITCH_TRACK_HEIGHT,
          borderRadius: radius.pill,
          backgroundColor: bobSwitchTrackColor(value, {
            ink: theme.ink,
            trackOff: controls.segmentedTrack,
          }),
          justifyContent: 'center',
        }}
      >
        <View
          style={[
            {
              width: BOB_SWITCH_THUMB_SIZE,
              height: BOB_SWITCH_THUMB_SIZE,
              borderRadius: radius.pill,
              backgroundColor: colors.surface,
              transform: [{ translateX: bobSwitchThumbOffset(value) }],
            },
            shadowNative.e1,
          ]}
        />
      </View>
    </Pressable>
  );
}
