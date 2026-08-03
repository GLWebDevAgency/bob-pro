/**
 * QuotePreviewBox — aperçu d'un message pré-rédigé (Lot 3, plan DA 01/08) : l'encadré
 * sobre du VRAI texte qui partira (relance devis PR-05, à venir : relance facture).
 * Gabarit figé de l'aperçu historique de devis/[id] : bord cardBorder, radius 12,
 * padding 12, texte sub/500 interligne 20 (arbitrage TYPO — le 13,5 ad hoc était déjà
 * le cran `sub`).
 */
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { font, useTheme } from '../theme';

export interface QuotePreviewBoxProps {
  /** Le message tel qu'il partira — déjà construit côté écran (buildQuoteRelance…). */
  readonly text: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

export function QuotePreviewBox({ text, style, testID }: QuotePreviewBoxProps) {
  const { colors, controls } = useTheme();
  return (
    <View
      {...(testID !== undefined ? { testID } : {})}
      style={[
        {
          borderRadius: 12,
          borderWidth: 1,
          borderColor: controls.cardBorder,
          padding: 12,
        },
        style,
      ]}
    >
      <Text style={[font('sub', 500), { lineHeight: 20, color: colors.ink800 }]}>{text}</Text>
    </View>
  );
}
