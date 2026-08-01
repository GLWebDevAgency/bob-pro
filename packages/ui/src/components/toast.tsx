/**
 * Toast — confirmation éphémère (COMPONENT_SPECS.md §17).
 * Fond theme.ink, texte surface 13.5/600, radius 12, padding 12/16, icône injectée 16.
 * Absolu bottom 122 (au-dessus de la tab bar), centré. Entrée translateY+opacity,
 * auto-dismiss 2 400 ms (timer nettoyé au démontage / changement de visibilité).
 * Lot 0 (plan DA 01/08) : tone additif success/danger — feedback éphémère NON actionnable
 * (grammaire d'erreur). Sans icône injectée, le tone dessine son glyphe (coche verte /
 * croix danger on-dark) — fin de la coche verte sur un échec. Sans tone : arbre inchangé.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { surfaceTint } from '@bob/tokens';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { font, useTheme } from '../theme';
import { toastToneAccent, type ToastTone } from './toast.logic';

const ENTER_MS = 200;
const EXIT_MS = 180;
const AUTO_DISMISS_MS = 2400;
const ICON_SIZE = 16;

export type { ToastTone };

export interface ToastProps {
  readonly message: string;
  readonly visible: boolean;
  readonly onHide: () => void;
  /** Icône injectée 16 (check par défaut côté appelant) — aucune lib d'icônes. */
  readonly icon?: ReactNode;
  /** Tone du feedback (Lot 0) — dessine coche/croix on-dark quand `icon` est absent. */
  readonly tone?: ToastTone;
}

/** Glyphe du tone — tracés lucide-style 24×24, mêmes traits que icons.tsx (stroke 2.6/2.2). */
function ToneGlyph({ glyph, color }: { glyph: 'check' | 'cross'; color: string }) {
  return (
    <Svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      stroke={color}
      strokeWidth={glyph === 'check' ? 2.6 : 2.2}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {glyph === 'check' ? <Path d="M4 12.5l5 5L20 6.5" /> : <Path d="M6 6l12 12M18 6L6 18" />}
    </Svg>
  );
}

export function Toast({ message, visible, onHide, icon, tone }: ToastProps) {
  const { theme, colors, semantic } = useTheme();
  const reduceMotion = useReduceMotion();
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;

  useEffect(() => {
    if (!visible) {
      Animated.timing(progress, {
        toValue: 0,
        duration: reduceMotion ? 0 : EXIT_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
      return;
    }
    setMounted(true);
    Animated.timing(progress, {
      toValue: 1,
      duration: reduceMotion ? 0 : ENTER_MS,
      useNativeDriver: true,
    }).start();
    const timer = setTimeout(() => {
      Animated.timing(progress, {
        toValue: 0,
        duration: reduceMotion ? 0 : EXIT_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          setMounted(false);
          onHideRef.current();
        }
      });
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [visible, progress, reduceMotion]);

  if (!mounted) return null;

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });
  // Icône injectée PRIORITAIRE (compat totale) ; sinon le tone dessine son glyphe on-dark.
  const accent = toastToneAccent(tone, {
    successOnDark: semantic.successOnDark,
    dangerOnDark: surfaceTint.dark.danger.ink,
  });
  const slot = icon ?? (accent !== undefined ? <ToneGlyph glyph={accent.glyph} color={accent.color} /> : undefined);

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        position: 'absolute',
        bottom: 122,
        left: 0,
        right: 0,
        alignItems: 'center',
        opacity: progress,
        transform: [{ translateY }],
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          backgroundColor: theme.ink,
          borderRadius: 12,
          paddingVertical: 12,
          paddingHorizontal: 16,
        }}
      >
        {slot ? (
          <View
            style={{
              width: ICON_SIZE,
              height: ICON_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {slot}
          </View>
        ) : null}
        <Text style={[font('sub'), { color: colors.surface, fontWeight: '600' }]}>{message}</Text>
      </View>
    </Animated.View>
  );
}
