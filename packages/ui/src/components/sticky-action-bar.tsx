/**
 * StickyActionBar — UNE barre d'action sticky à 2 variantes (Lot 0, plan DA 01/08,
 * arbitrage STICKY BARS — fusion StickyCtaBar/StickyActionBar) :
 *  · 'bar'      — surface + borderTop lineSoft, slots MONTANT + CTA (facture/new,
 *                 PieceDetailView) : le récap chiffré et le geste au même endroit ;
 *  · 'floating' — pilule aplat ink + ombre e3 + liseré accent sémantique + apparition
 *                 FadeIn FAIL-CLOSED (client/[id]) : le fil rouge « couleur de l'argent »
 *                 jusque dans le geste.
 * Lot 0 : AUCUN écran migré — les adoptions appartiennent aux lots 3 et 4.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { shadowNative } from '@bob/tokens';
import { font, useTheme } from '../theme';
import { FadeIn } from './fade-in';
import {
  stickyBarContainerStyle,
  stickyFloatingContainerStyle,
  stickyFloatingPillStyle,
} from './sticky-action-bar.logic';

interface StickyActionBarBaseProps {
  readonly testID?: string;
}

export interface StickyActionBarBarProps extends StickyActionBarBaseProps {
  readonly variant: 'bar';
  /** Slot MONTANT (récap chiffré au-dessus du CTA) — ex. « Total TTC · 2 400 € ». */
  readonly amountSlot?: ReactNode;
  /** Slot CTA — le Button kit de l'écran (Continuer / Créer la facture…). */
  readonly children: ReactNode;
}

export interface StickyActionBarFloatingProps extends StickyActionBarBaseProps {
  readonly variant: 'floating';
  /** Libellé du geste — « Relancer F-2024-018 · 2 400 € ». */
  readonly label: string;
  readonly onPress: () => void;
  /** Liseré accent sémantique (teinte du standing — fil rouge « couleur de l'argent »). */
  readonly accentColor?: string;
  /** Icône de fin (chevron…) injectée — aucune lib d'icônes. */
  readonly trailingIcon?: ReactNode;
  readonly accessibilityLabel?: string;
}

export type StickyActionBarProps = StickyActionBarBarProps | StickyActionBarFloatingProps;

export function StickyActionBar(props: StickyActionBarProps) {
  const insets = useSafeAreaInsets();
  const { colors, theme } = useTheme();

  if (props.variant === 'bar') {
    return (
      <View
        {...(props.testID !== undefined ? { testID: props.testID } : {})}
        style={stickyBarContainerStyle(insets.bottom, {
          surface: colors.surface,
          lineSoft: colors.lineSoft,
        })}
      >
        {props.amountSlot !== undefined ? (
          <View style={{ marginBottom: 10 }}>{props.amountSlot}</View>
        ) : null}
        {props.children}
      </View>
    );
  }

  return (
    <View
      {...(props.testID !== undefined ? { testID: props.testID } : {})}
      style={stickyFloatingContainerStyle(insets.bottom)}
    >
      {/* Apparition FadeIn — fail-closed par useReduceMotion (préférence non résolue = 0). */}
      <FadeIn index={0}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.accessibilityLabel ?? props.label}
          onPress={props.onPress}
          style={({ pressed }) => [
            stickyFloatingPillStyle({
              pressed,
              ink: theme.ink,
              accentColor: props.accentColor,
            }),
            shadowNative.e3,
          ]}
        >
          <Text style={[font('button'), { fontSize: 15, color: colors.surface }]}>
            {props.label}
          </Text>
          {props.trailingIcon !== undefined ? props.trailingIcon : null}
        </Pressable>
      </FadeIn>
    </View>
  );
}
