/**
 * PriorityCard — carte « À régler » de l'accueil (COMPONENT_SPECS.md §4).
 * Barre d'accent gauche colorée par statut, checkbox ronde 26, badge/CTA injectés
 * (ReactNode, pour éviter toute dépendance croisée entre lots). État « fait » :
 * fond successBg, bord dérivé, titre success. Mapping pur : priority-card.logic.ts.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { shadowComponentsNative } from '@bob/tokens';
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
  /** État « fait » : carte pleine successBg, titre success. */
  done?: boolean;
  onToggle?: () => void;
  /** Icône de coche injectée, visible quand done. */
  checkIcon?: ReactNode;
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
}: PriorityCardProps) {
  const { colors, semantic, controls } = useTheme();
  const c = resolvePriorityCardColors(status, done, {
    accents: {
      dangerVivid: semantic.dangerVivid,
      ink600: colors.ink600,
      b2g: semantic.b2g,
    },
    surface: colors.surface,
    cardBorder: controls.cardBorder,
    ink800: colors.ink800,
    success: semantic.success,
    successBg: semantic.successBg,
  });

  return (
    <View
      style={{
        position: 'relative',
        backgroundColor: c.background,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: c.border,
        paddingTop: 15,
        paddingRight: 16,
        paddingBottom: 15,
        paddingLeft: 17,
        ...shadowComponentsNative.priorityCard,
      }}
    >
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
            marginRight: 12,
            marginTop: 2,
          }}
        >
          {done ? checkIcon : null}
        </Pressable>

        <View style={{ flex: 1 }}>
          {badge ? <View style={{ alignSelf: 'flex-start', marginBottom: 6 }}>{badge}</View> : null}
          <Text style={{ ...font('body'), fontSize: 15.5, fontWeight: '700', color: c.title }}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 3 }]}>{subtitle}</Text>
          ) : null}
          {cta ? <View style={{ marginTop: 10 }}>{cta}</View> : null}
        </View>
      </View>
    </View>
  );
}
