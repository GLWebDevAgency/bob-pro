/**
 * SegmentedControl — §11 (7/30/60/90 j · scénarios).
 * Piste controls.segmentedTrack radius 12 padding 4, segments flex:1 radius 9.
 * Actif : surface + ombre e1 + text.primary ; inactif : text.muted sur la piste.
 * Les deux rôles sont certifiés AA ; slate400 reste réservé au non-contenu.
 * Hit-target ≥ 44 garanti par hitSlop vertical.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { resolveColorRole, shadowNative } from '@bob/tokens';
import { font, useTheme } from '../theme';
import { isSegmentActive, type SegmentOption } from './segmented-control.logic';

export type { SegmentOption };

export interface SegmentedControlProps<K extends string> {
  options: readonly SegmentOption<K>[];
  value: K;
  onChange: (key: K) => void;
  accessibilityLabel?: string;
}

export function SegmentedControl<K extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: SegmentedControlProps<K>) {
  const { colors, controls } = useTheme();
  return (
    <View
      style={[styles.track, { backgroundColor: controls.segmentedTrack }]}
      accessibilityRole="tablist"
      {...(accessibilityLabel !== undefined ? { accessibilityLabel } : {})}
    >
      {options.map((option) => {
        const active = isSegmentActive(option.key, value);
        return (
          <Pressable
            key={option.key}
            onPress={() => onChange(option.key)}
            hitSlop={{ top: 10, bottom: 10 }}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            style={[
              styles.segment,
              active && [styles.segmentActive, { backgroundColor: colors.surface }, shadowNative.e1],
            ]}
          >
            <Text
              style={[
                font('label'),
                styles.segmentText,
                { color: resolveColorRole(active ? 'text.primary' : 'text.muted') },
              ]}
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', gap: 4, borderRadius: 12, padding: 4 },
  segment: {
    flex: 1,
    borderRadius: 9,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: {},
  segmentText: { fontWeight: '700' },
});
