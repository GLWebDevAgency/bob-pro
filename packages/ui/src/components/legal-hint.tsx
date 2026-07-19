/**
 * LegalHint — divulgation progressive d'une protection légale, en 3 niveaux :
 *  (a) phrase in-line courte formulée BÉNÉFICE (prop `label`, i18n côté écran) ;
 *  (b) icône « ? » discrète à côté, cible tactile ≥ 44 pt ;
 *  (c) au tap : feuille (Sheet maison) 2 blocs « Ce que dit la loi » + « Pourquoi Bob fait
 *      ça », source (article) en petit — clés i18n résolues ICI selon la personnalité active.
 * Zéro hex : toute couleur vient de @bob/tokens via useTheme() (token-lint).
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme, font } from '../theme';
import { Sheet } from './sheet';
import {
  LEGAL_HINT_HIT_TARGET,
  LEGAL_HINT_ICON_DIAMETER,
  LEGAL_HINT_ICON_HIT_SLOP,
  resolveLegalHintCopy,
  type LegalHintContentInput,
} from './legal-hint.logic';

export interface LegalHintProps extends LegalHintContentInput {
  /** Phrase in-line courte, formulée BÉNÉFICE (déjà i18n ×3 tons côté écran). */
  readonly label: string;
}

export function LegalHint({ label, lawKey, whyKey, source, params }: LegalHintProps) {
  const { colors, controls, personality } = useTheme();
  const [open, setOpen] = useState(false);
  const copy = resolveLegalHintCopy(
    { lawKey, whyKey, source, ...(params ? { params } : {}) },
    personality,
  );

  return (
    // La rangée fait AU MOINS 44 pt de haut : React Native ne délivre jamais une touche hors
    // des bounds du parent (systématique sur Android) — sans cette hauteur réelle, le hitSlop
    // de la pastille serait écrasé et la cible « 44 pt » resterait fictive.
    <View
      style={{ flexDirection: 'row', alignItems: 'center', minHeight: LEGAL_HINT_HIT_TARGET }}
    >
      <Text
        style={[font('meta'), { color: colors.slate500, flexShrink: 1, lineHeight: 17 }]}
      >
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.iconLabel}
        accessibilityHint={copy.iconHint}
        onPress={() => setOpen(true)}
        // Correctif standard : la pastille garde sa taille visuelle (22 pt) et hitSlop étend la
        // cible tactile à 44 pt — jamais de marges négatives qui la rétréciraient en pratique.
        hitSlop={LEGAL_HINT_ICON_HIT_SLOP}
        style={{
          width: LEGAL_HINT_ICON_DIAMETER,
          height: LEGAL_HINT_ICON_DIAMETER,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {({ pressed }) => (
          <View
            importantForAccessibility="no"
            style={{
              width: LEGAL_HINT_ICON_DIAMETER,
              height: LEGAL_HINT_ICON_DIAMETER,
              borderRadius: LEGAL_HINT_ICON_DIAMETER / 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? controls.sheetHandle : controls.segmentedTrack,
            }}
          >
            <Text
              accessible={false}
              allowFontScaling={false}
              style={{ color: colors.slate500, fontSize: 13, fontWeight: '700', lineHeight: 16 }}
            >
              ?
            </Text>
          </View>
        )}
      </Pressable>

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        accessibilityLabel={copy.sheetLabel}
      >
        <Text
          accessibilityRole="header"
          style={[font('sub', 700), { color: colors.ink900, marginBottom: 6 }]}
        >
          {copy.lawTitle}
        </Text>
        <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginBottom: 16 }]}>
          {copy.lawBody}
        </Text>
        <Text
          accessibilityRole="header"
          style={[font('sub', 700), { color: colors.ink900, marginBottom: 6 }]}
        >
          {copy.whyTitle}
        </Text>
        <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginBottom: 16 }]}>
          {copy.whyBody}
        </Text>
        <Text style={[font('meta'), { color: colors.slate400, marginBottom: 8 }]}>
          {copy.sourceLine}
        </Text>
      </Sheet>
    </View>
  );
}
