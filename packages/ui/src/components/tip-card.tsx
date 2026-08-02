/**
 * TipCard — le coach-mark « première fois » (Lot 1, plan DA 01/08) : carte centrée sur scrim,
 * voix de Bob (eyebrow ai + auteur), dismiss par scrim / « Passer » / CTA. Promu du
 * FirstTimeTip local d'argent.tsx — la persistance du dismiss (SecureStore) reste à l'écran.
 * Reduce-motion FAIL-CLOSED (kit Lot 0) : préférence non résolue = aucun fondu de Modal.
 * Titre au cran sheetTitle (arbitrage typo : le 19 inline s'arrondit au cran, jamais tokenisé).
 */
import type { ReactNode } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { shadowNative } from '@bob/tokens';
import { font, useTheme } from '../theme';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { Button } from './button';

export interface TipCardProps {
  readonly visible: boolean;
  /** Eyebrow indigo (« LE CONSEIL DE BOB ») — i18n côté écran. */
  readonly eyebrow: string;
  /** Ligne d'auteur sous l'eyebrow (« par Bob »). */
  readonly author: string;
  readonly title: string;
  readonly body: string;
  readonly ctaLabel: string;
  /** Libellé du lien discret de dismiss (« Passer ») — aussi le label a11y du scrim. */
  readonly skipLabel: string;
  readonly onDismiss: () => void;
  /** Icône injectée de la tuile indigo (aucune lib d'icônes dans @bob/ui). */
  readonly icon?: ReactNode;
}

export function TipCard({
  visible,
  eyebrow,
  author,
  title,
  body,
  ctaLabel,
  skipLabel,
  onDismiss,
  icon,
}: TipCardProps) {
  const { colors, semantic, overlays } = useTheme();
  const reduceMotion = useReduceMotion();
  if (!visible) return null;
  return (
    <Modal
      transparent
      visible
      animationType={reduceMotion ? 'none' : 'fade'}
      statusBarTranslucent
      onRequestClose={onDismiss}
    >
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={skipLabel}
          onPress={onDismiss}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: overlays.scrim,
          }}
        />
        <View
          style={{
            width: '100%',
            maxWidth: 318,
            backgroundColor: colors.surface,
            borderRadius: 22,
            paddingTop: 22,
            paddingHorizontal: 20,
            paddingBottom: 18,
            ...shadowNative.e3,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 13 }}>
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 13,
                backgroundColor: semantic.ai,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {icon}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[font('eyebrow'), { color: semantic.ai }]}>{eyebrow}</Text>
              <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>{author}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={skipLabel}
              onPress={onDismiss}
              hitSlop={10}
            >
              <Text style={[font('meta'), { color: colors.slate400 }]}>{skipLabel}</Text>
            </Pressable>
          </View>
          <Text style={[font('sheetTitle'), { color: colors.ink800 }]}>{title}</Text>
          <Text
            style={[
              font('body'),
              { color: colors.slate500, lineHeight: 21, marginTop: 6, marginBottom: 15 },
            ]}
          >
            {body}
          </Text>
          <Button title={ctaLabel} variant="primary" onPress={onDismiss} />
        </View>
      </View>
    </Modal>
  );
}
