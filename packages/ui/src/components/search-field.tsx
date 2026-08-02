/**
 * SearchField — champ de recherche du kit (Lot 0, plan DA 01/08) : surface + ombre e1 +
 * loupe + bouton clear à cible 44 pt. Géométrie et teintes du SearchField local de
 * clients.tsx (la référence du plan) — les marges d'écran restent aux écrans (prop style).
 * Consommateurs (lots 4 et 5) : clients, equipements/[chantierId], recherche — AUCUN
 * migré ici. La loupe est dessinée à l'identique de SearchIcon d'icons.tsx (18/2).
 */
import type { StyleProp, ViewStyle } from 'react-native';
import { Pressable, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { shadowNative } from '@bob/tokens';
import { font, useTheme } from '../theme';
import {
  SEARCH_CLEAR_HIT_SLOP,
  SEARCH_CLEAR_VISUAL,
  SEARCH_FIELD_GAP,
  SEARCH_FIELD_PADDING_HORIZONTAL,
  SEARCH_FIELD_PADDING_VERTICAL,
  searchClearVisible,
} from './search-field.logic';

interface SearchFieldBaseProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Placeholder i18n — sert aussi de libellé accessible par défaut. */
  readonly placeholder: string;
  readonly accessibilityLabel?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

/**
 * Un effaceur est soit absent, soit complet avec son libellé i18n. Le kit ne connaît pas la
 * personnalité Bob du consommateur et ne fabrique donc jamais une copy française par défaut.
 */
type SearchFieldClearProps =
  | {
      readonly onClear?: undefined;
      readonly clearAccessibilityLabel?: never;
    }
  | {
      readonly onClear: () => void;
      readonly clearAccessibilityLabel: string;
    };

export type SearchFieldProps = SearchFieldBaseProps & SearchFieldClearProps;

/** Loupe — même tracé que SearchIcon d'icons.tsx (lucide-style 24×24, 18/2). */
function SearchGlyph({ color }: { color: string }) {
  return (
    <Svg
      accessible={false}
      width={18}
      height={18}
      viewBox="0 0 24 24"
      stroke={color}
      strokeWidth={2}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={11} cy={11} r={7} />
      <Path d="M21 21l-4.3-4.3" />
    </Svg>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  onClear,
  clearAccessibilityLabel,
  accessibilityLabel,
  style,
  testID,
}: SearchFieldProps) {
  const { colors, radius } = useTheme();
  return (
    <View
      {...(testID !== undefined ? { testID } : {})}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: SEARCH_FIELD_GAP,
          backgroundColor: colors.surface,
          borderRadius: radius.squircle,
          paddingVertical: SEARCH_FIELD_PADDING_VERTICAL,
          paddingHorizontal: SEARCH_FIELD_PADDING_HORIZONTAL,
          ...shadowNative.e1,
        },
        style,
      ]}
    >
      <SearchGlyph color={colors.slate500} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.slate500}
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={accessibilityLabel ?? placeholder}
        style={[font('body'), { flex: 1, padding: 0, color: colors.ink800 }]}
      />
      {onClear !== undefined
      && clearAccessibilityLabel !== undefined
      && clearAccessibilityLabel.trim().length > 0
      && searchClearVisible(value, true) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={clearAccessibilityLabel}
          onPress={onClear}
          hitSlop={SEARCH_CLEAR_HIT_SLOP}
          style={({ pressed }) => ({
            width: SEARCH_CLEAR_VISUAL,
            height: SEARCH_CLEAR_VISUAL,
            borderRadius: radius.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? colors.lineSoft : colors.surface,
          })}
        >
          <Text
            accessible={false}
            allowFontScaling={false}
            style={{ color: colors.slate500, fontSize: 20, fontWeight: '500', lineHeight: 22 }}
          >
            ×
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
