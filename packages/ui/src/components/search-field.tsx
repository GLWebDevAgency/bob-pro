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

export interface SearchFieldProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Placeholder i18n — sert aussi de libellé accessible par défaut. */
  readonly placeholder: string;
  /** Fourni ⇒ bouton clear (cible 44 pt) dès que `value` est non vide. */
  readonly onClear?: () => void;
  /** Libellé accessible du bouton clear (défaut « Effacer » — patron Sheet « Fermer »). */
  readonly clearAccessibilityLabel?: string;
  readonly accessibilityLabel?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

/** Loupe — même tracé que SearchIcon d'icons.tsx (lucide-style 24×24, 18/2). */
function SearchGlyph({ color }: { color: string }) {
  return (
    <Svg
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
  clearAccessibilityLabel = 'Effacer',
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
      <SearchGlyph color={colors.slate300} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.slate300}
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={accessibilityLabel ?? placeholder}
        style={[font('body'), { flex: 1, padding: 0, color: colors.ink800 }]}
      />
      {searchClearVisible(value, onClear !== undefined) ? (
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
            style={{ color: colors.slate400, fontSize: 20, fontWeight: '500', lineHeight: 22 }}
          >
            ×
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
