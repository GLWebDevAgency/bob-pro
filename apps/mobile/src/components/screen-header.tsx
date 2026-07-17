/**
 * ScreenHeader — bouton retour + InnerScreenHeader COMPOSÉS en un seul bloc (retours device
 * fondateur : sur-espace entre le bouton retour et le titre de page). Chaque écran réimplémentait
 * manuellement `<View back-row><Pressable/></View><InnerScreenHeader/>` avec le paddingTop fixe de
 * `InnerScreenHeader` (56, pensé pour un en-tête SANS rien au-dessus) qui s'ajoutait À LA SUITE du
 * bouton retour déjà positionné sous l'encoche — d'où le sur-espace. Ce composant compose les deux
 * avec `InnerScreenHeader compact`, et porte la RÈGLE « le libellé du bouton retour nomme l'écran
 * de destination » (jamais un « Retour » générique) — le libellé est fourni par l'appelant via
 * i18n (déjà le cas : `reglages.back`, `account.back`… juste leur texte a changé de "Retour" à un
 * nom d'écran/« Fermer »).
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { InnerScreenHeader, font, useTheme } from '@bob/ui';
import { ChevronLeftIcon } from './icons';

export interface ScreenHeaderProps {
  /** Libellé visible ET annoncé du bouton retour — le nom de l'écran de destination (ou
   * « Fermer » quand cet écran a été ouvert depuis une modale/feuille). */
  backLabel: string;
  onBack: () => void;
  eyebrow: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export function ScreenHeader({ backLabel, onBack, eyebrow, title, subtitle, action }: ScreenHeaderProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 16 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={backLabel}
          onPress={onBack}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 44 }}
        >
          <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
          <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>{backLabel}</Text>
        </Pressable>
      </View>
      <InnerScreenHeader eyebrow={eyebrow} title={title} subtitle={subtitle} action={action} compact />
    </>
  );
}
