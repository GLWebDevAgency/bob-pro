import { Text, View } from 'react-native';
import { font, useTheme } from '@bob/ui';
import type { FieldStatusTone } from '../../fiscal/fiscal-i18n-keys';

/**
 * Pastille de statut d'un champ fiscal (amendement 6 : « source + date + statut en TEXTE —
 * jamais couleur/coche seules »). Le texte PORTE le sens ; la couleur ne fait qu'accompagner —
 * un utilisateur daltonien ou VoiceOver lit exactement la même information.
 */
export function FiscalStatusPill({ label, tone }: { readonly label: string; readonly tone: FieldStatusTone }) {
  const { colors, semantic } = useTheme();
  const { fg, bg } =
    tone === 'success'
      ? { fg: semantic.success, bg: semantic.successBg }
      : tone === 'warning'
        ? { fg: semantic.warning, bg: semantic.warningBg }
        : { fg: colors.slate500, bg: colors.lineSoft };
  return (
    <View
      accessibilityRole="text"
      style={{
        alignSelf: 'flex-start',
        backgroundColor: bg,
        borderRadius: 6,
        paddingVertical: 2,
        paddingHorizontal: 7,
      }}
    >
      <Text style={[font('label', 700), { fontSize: 11, color: fg }]}>{label}</Text>
    </View>
  );
}
