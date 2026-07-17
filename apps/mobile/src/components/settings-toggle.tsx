/**
 * SettingsToggle — interrupteur titre/sous-titre (Réglages facturation §RIB/§Assurance : « Afficher
 * le RIB sur les factures », « Afficher sur les factures BTP »). Aucun composant Switch n'existe
 * dans @bob/ui — motif local, réutilisable (les 2 toggles de reglages-facturation.tsx).
 * Respecte prefers-reduced-motion (useReduceMotion @bob/ui).
 */
import { useEffect, useRef } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { font, useReduceMotion, useTheme } from '@bob/ui';

export interface SettingsToggleProps {
  readonly value: boolean;
  readonly onChange: (next: boolean) => void;
  readonly title: string;
  readonly subtitle?: string;
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
}

const TRACK_WIDTH = 44;
const TRACK_HEIGHT = 26;
const KNOB_SIZE = 20;
const KNOB_TRAVEL = TRACK_WIDTH - KNOB_SIZE - 2 * 3;

export function SettingsToggle({
  value,
  onChange,
  title,
  subtitle,
  accessibilityLabel,
  disabled = false,
}: SettingsToggleProps) {
  const { colors, semantic, controls } = useTheme();
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: reduceMotion ? 0 : 180,
      useNativeDriver: false,
    }).start();
  }, [value, progress, reduceMotion]);

  const trackColor = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [controls.segmentedTrack, semantic.success],
  });
  const knobTranslate = progress.interpolate({ inputRange: [0, 1], outputRange: [0, KNOB_TRAVEL] });

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel ?? title}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        minHeight: 44,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[font('sub', 600), { fontSize: 14, color: colors.ink800 }]}>{title}</Text>
        {subtitle ? (
          <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>{subtitle}</Text>
        ) : null}
      </View>
      <Animated.View
        style={{
          width: TRACK_WIDTH,
          height: TRACK_HEIGHT,
          borderRadius: TRACK_HEIGHT / 2,
          padding: 3,
          backgroundColor: trackColor,
        }}
      >
        <Animated.View
          style={{
            width: KNOB_SIZE,
            height: KNOB_SIZE,
            borderRadius: KNOB_SIZE / 2,
            backgroundColor: colors.surface,
            transform: [{ translateX: knobTranslate }],
          }}
        />
      </Animated.View>
    </Pressable>
  );
}
