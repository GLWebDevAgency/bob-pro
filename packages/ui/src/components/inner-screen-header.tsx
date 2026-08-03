/**
 * InnerScreenHeader — §3 (Argent / Clients / Documents / Assistant).
 * En-tête clair : eyebrow slate400 uppercase → titre pageTitle ink800 → sous-titre 14.5 slate500.
 * L'accueil est le SEUL en-tête dégradé ; ici, fond clair (hérité de l'écran).
 *
 * VOILE V2 EN PIED (Lot 1, plan DA 01/08) : la variante `innerScreenHeader` du HeaderVeil
 * (Lot 0) est montée SOUS le bord bas de l'en-tête — UN point de montée kit, et les écrans
 * consommateurs héritent de la signature sans une ligne d'écran : le contenu fond sous le
 * titre dans la retombée canvas (ton = fond d'app : discret par construction sur le fond
 * canonique, visible dès qu'une surface différente passe dessous). Décoratif pur
 * (pointerEvents none, absolu, zéro layout), fail-closed intégral hérité du mécanisme —
 * aucun port de flou injecté (mode nominal teinté), préférence de transparence inconnue =
 * le MÊME voile plat.
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { patterns } from '@bob/tokens';
import { font, useTheme } from '../theme';
import { HeaderVeil } from './header-veil';
import { DEFAULT_HEADER_VEIL_HEIGHT } from './header-veil.logic';

export interface InnerScreenHeaderProps {
  /** OPTIONNEL depuis le Lot 3 (verdict PR #61, iso-information) : absent = aucun nœud
   * eyebrow — les migrations d'en-têtes ad hoc n'ajoutent pas de texte non demandé. */
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  /**
   * Un bouton retour précède déjà l'en-tête (compose avec lui) : le paddingTop fixe de
   * `patterns.innerScreenHeader` (56, pensé pour un en-tête EN PREMIER élément d'écran, qui
   * doit lui-même absorber l'encoche) devient un sur-espace — le bouton retour a déjà sa
   * propre marge de sécurité. `compact` retombe sur un espacement de respiration minimal.
   */
  compact?: boolean;
}

export function InnerScreenHeader({ eyebrow, title, subtitle, action, compact = false }: InnerScreenHeaderProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.root, compact ? styles.rootCompact : null]}>
      <View style={styles.texts}>
        {eyebrow !== undefined ? (
          <Text style={[font('eyebrow'), { color: colors.slate400 }]} accessibilityRole="text">
            {eyebrow}
          </Text>
        ) : null}
        <Text
          style={[font('pageTitle'), styles.title, { color: colors.ink800 }]}
          accessibilityRole="header"
        >
          {title}
        </Text>
        {subtitle !== undefined ? (
          <Text style={[font('body'), styles.subtitle, { color: colors.slate500 }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action !== undefined ? <View style={styles.action}>{action}</View> : null}

      {/* VOILE V2 — la retombée canvas SOUS l'en-tête (hauteur = débord du contrat, 44) :
          le contenu déclaré après par l'écran est peint au-dessus ; la matière vit dessous. */}
      <View pointerEvents="none" style={styles.veil}>
        <HeaderVeil variant="innerScreenHeader" testID="inner-screen-header-veil" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingTop: patterns.innerScreenHeader.paddingTop,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  rootCompact: { paddingTop: 10 },
  texts: { flex: 1 },
  title: { marginTop: 4 },
  subtitle: { marginTop: 4 },
  action: { marginLeft: 12 },
  veil: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -DEFAULT_HEADER_VEIL_HEIGHT,
    height: DEFAULT_HEADER_VEIL_HEIGHT,
  },
});
