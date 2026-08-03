/**
 * BackHeader — bouton retour + InnerScreenHeader COMPOSÉS en un seul bloc (retours device
 * fondateur : sur-espace entre le bouton retour et le titre de page). Chaque écran réimplémentait
 * manuellement `<View back-row><Pressable/></View><InnerScreenHeader/>` avec le paddingTop fixe de
 * `InnerScreenHeader` (56, pensé pour un en-tête SANS rien au-dessus) qui s'ajoutait À LA SUITE du
 * bouton retour déjà positionné sous l'encoche — d'où le sur-espace. Ce composant compose les deux
 * avec `InnerScreenHeader compact`, et porte la RÈGLE « le libellé du bouton retour nomme l'écran
 * de destination » (jamais un « Retour » générique) — le libellé est fourni par l'appelant via
 * i18n.
 *
 * PROMU du `screen-header.tsx` local d'apps/mobile (Lot 0, plan DA 01/08 — arbitrage HEADERS :
 * « pas de composant nouveau — screen-header local est PROMU @bob/ui comme BackHeader
 * canonique »). L'arbre rendu est STRICTEMENT celui du composant local (prouvé par le test iso
 * côté mobile, chevron compris — tracé identique à ChevronLeftIcon d'icons.tsx : ‹ 18/2.2
 * ink800). Consommateurs à venir : documents/[id] (3 duplications), folder/[id], scan-document,
 * chantiers, ventes — migrés dans LEURS lots, jamais ici.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { InnerScreenHeader } from './inner-screen-header';
import { font, useTheme } from '../theme';

export interface BackHeaderProps {
  /** Libellé visible ET annoncé du bouton retour — le nom de l'écran de destination (ou
   * « Fermer » quand cet écran a été ouvert depuis une modale/feuille). */
  backLabel: string;
  onBack: () => void;
  /** OPTIONNEL depuis le Lot 3 (verdict PR #61, iso-information) : une migration d'en-tête
   * ad hoc → BackHeader ne doit pas IMPOSER une ligne de texte qui n'existait pas dans
   * l'écran d'origine. Absent = aucun nœud eyebrow rendu (InnerScreenHeader le masque). */
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

/** Chevron ‹ — même tracé que ChevronLeftIcon d'icons.tsx (lucide-style 24×24, 18/2.2). */
function BackChevron({ color }: { color: string }) {
  return (
    <Svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      stroke={color}
      strokeWidth={2.2}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M15 6l-6 6 6 6" />
    </Svg>
  );
}

export function BackHeader({ backLabel, onBack, eyebrow, title, subtitle, action }: BackHeaderProps) {
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
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            alignSelf: 'flex-start',
            minHeight: 44,
            // Press feedback standard (passe feel 18/07) — un retour qui répond au doigt.
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <BackChevron color={colors.ink800} />
          <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>{backLabel}</Text>
        </Pressable>
      </View>
      {/* Spreads conditionnels = exigence exactOptionalPropertyTypes du paquet ; pour React,
          `subtitle={undefined}` et « absent » sont le MÊME props — l'arbre rendu ne change pas. */}
      <InnerScreenHeader
        {...(eyebrow !== undefined ? { eyebrow } : {})}
        title={title}
        {...(subtitle !== undefined ? { subtitle } : {})}
        {...(action !== undefined ? { action } : {})}
        compact
      />
    </>
  );
}
