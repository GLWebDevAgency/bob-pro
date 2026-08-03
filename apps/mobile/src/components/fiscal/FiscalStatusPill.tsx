import { Text, View } from 'react-native';
import { font, useTheme } from '@bob/ui';
import type { FieldStatusTone } from '../../fiscal/fiscal-i18n-keys';

/**
 * Pastille de statut d'un champ fiscal (amendement 6 : « source + date + statut en TEXTE —
 * jamais couleur/coche seules »). Le texte PORTE le sens ; la couleur ne fait qu'accompagner —
 * un utilisateur daltonien ou VoiceOver lit exactement la même information.
 *
 * Encres AA sur pastel (vague hors-lots, audit 03/08) : `warning` nu sur warningBg = 2,99:1 —
 * « À confirmer », LE statut actionnable de l'écran, échouait l'AA plein soleil. Les encres
 * foncées tokenisées pour ce cas précis (patron StatusStrip) prennent le relais :
 * warningInk 5,25:1 · successInk 6,99:1. Fonds pastel inchangés.
 */
export function FiscalStatusPill({ label, tone }: { readonly label: string; readonly tone: FieldStatusTone }) {
  const { colors, semantic } = useTheme();
  const { fg, bg } =
    tone === 'success'
      ? { fg: semantic.successInk, bg: semantic.successBg }
      : tone === 'warning'
        ? { fg: semantic.warningInk, bg: semantic.warningBg }
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
