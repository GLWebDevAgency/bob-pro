/**
 * PriorityCard — carte « À régler » de l'accueil (COMPONENT_SPECS.md §4).
 * Barre d'accent gauche colorée par statut, badge/CTA injectés (ReactNode).
 *
 * Trois identités (réf dc.html + C21 redécoupe 2026-07-17) :
 * · tâche actionnable (retard / marine) — checkbox ronde 26, fond surface ;
 * · carte INFO « conformite » — jamais de checkbox : puce bouclier 26 radius 8 (b2gBg),
 *   fond dégradé lavande 180° (conformityCard), bordure lavande, ombre douce indigo ;
 * · carte RAPPEL « brouillon » — jamais de checkbox non plus (rien à cocher, le devis n'est
 *   pas une tâche binaire) : puce 26 radius 8 (warningBg), fond surface normal + accent warning
 *   (même langage que les pastilles « Brouillon » de facture — pas le lavande de conformite).
 * État « fait » (tâches actionnables seulement) : fond successBg, titre success (priority-card.logic).
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { conformityCard, shadowComponentsNative } from '@bob/tokens';
import { font, useTheme } from '../theme';
import { resolvePriorityCardColors, type PriorityStatus } from './priority-card.logic';

export type { PriorityStatus };

export interface PriorityCardProps {
  /** Statut → couleur de la barre d'accent (retard / marine / conformite). */
  status: PriorityStatus;
  title: string;
  subtitle?: string;
  /** Badge de statut injecté (API de StatusBadge) — pas de dépendance croisée. */
  badge?: ReactNode;
  /** Bouton d'action injecté. */
  cta?: ReactNode;
  /** État « fait » : carte pleine successBg, titre success. Ignoré en carte info. */
  done?: boolean;
  onToggle?: () => void;
  /** Icône de coche injectée, visible quand done. */
  checkIcon?: ReactNode;
  /** Icône de tête de la carte info conformite (bouclier stroke b2g, injectée). */
  leadingIcon?: ReactNode;
}

export function PriorityCard({
  status,
  title,
  subtitle,
  badge,
  cta,
  done = false,
  onToggle,
  checkIcon,
  leadingIcon,
}: PriorityCardProps) {
  const { colors, semantic, controls } = useTheme();
  // 'conformite' ET 'brouillon' n'ont pas de checkbox (rien à cocher) ; seul 'conformite'
  // porte le fond dégradé lavande — 'brouillon' reste un fond surface normal, accent warning.
  const noCheckbox = status === 'conformite' || status === 'brouillon';
  const lavender = status === 'conformite';
  const c = resolvePriorityCardColors(status, !noCheckbox && done, {
    accents: {
      dangerVivid: semantic.dangerVivid,
      ink600: colors.ink600,
      b2g: semantic.b2g,
      warning: semantic.warning,
    },
    surface: colors.surface,
    cardBorder: controls.cardBorder,
    ink800: colors.ink800,
    success: semantic.success,
    successBg: semantic.successBg,
  });

  const frameStyle = {
    position: 'relative' as const,
    borderRadius: 20,
    borderWidth: 1,
    paddingTop: 15,
    paddingRight: 16,
    paddingBottom: 15,
    paddingLeft: 17,
  };

  const body = (
    <>
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 16,
          bottom: 16,
          width: 4,
          borderTopRightRadius: 4,
          borderBottomRightRadius: 4,
          backgroundColor: c.accent,
        }}
      />

      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        {noCheckbox ? (
          <View
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              backgroundColor: lavender ? semantic.b2gBg : semantic.warningBg,
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 13,
              marginTop: 1,
            }}
          >
            {leadingIcon}
          </View>
        ) : (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={title}
            accessibilityState={{ checked: done }}
            hitSlop={10}
            {...(onToggle ? { onPress: onToggle } : {})}
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              borderWidth: 2,
              borderColor: done ? semantic.success : controls.checkboxBorder,
              backgroundColor: done ? semantic.successBg : colors.surface,
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 13,
              marginTop: 1,
            }}
          >
            {done ? checkIcon : null}
          </Pressable>
        )}

        <View style={{ flex: 1 }}>
          {badge ? <View style={{ alignSelf: 'flex-start', marginBottom: 3 }}>{badge}</View> : null}
          <Text style={{ ...font('body', 700), fontSize: 15.5, color: c.title }}>{title}</Text>
          {subtitle ? (
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 2, lineHeight: 18 }]}>
              {subtitle}
            </Text>
          ) : null}
          {cta ? <View style={{ marginTop: 11 }}>{cta}</View> : null}
        </View>
      </View>
    </>
  );

  if (lavender) {
    return (
      <LinearGradient
        colors={[conformityCard.bgTop, conformityCard.bgBottom]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{
          ...frameStyle,
          borderColor: conformityCard.border,
          ...shadowComponentsNative.conformityCard,
        }}
      >
        {body}
      </LinearGradient>
    );
  }

  return (
    <View
      style={{
        ...frameStyle,
        backgroundColor: c.background,
        borderColor: c.border,
        ...shadowComponentsNative.priorityCard,
      }}
    >
      {body}
    </View>
  );
}
