/**
 * Toast — confirmation éphémère (COMPONENT_SPECS.md §17).
 * Fond theme.ink, texte surface 13.5/600, radius 12, padding 12/16, icône injectée 16.
 * Absolu bottom 122 (au-dessus de la tab bar), centré. Entrée translateY+opacity,
 * auto-dismiss 2 400 ms (timer nettoyé au démontage / changement de visibilité).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Text, View } from 'react-native';
import { font, useTheme } from '../theme';

const ENTER_MS = 200;
const EXIT_MS = 180;
const AUTO_DISMISS_MS = 2400;
const ICON_SIZE = 16;

export interface ToastProps {
  readonly message: string;
  readonly visible: boolean;
  readonly onHide: () => void;
  /** Icône injectée 16 (check par défaut côté appelant) — aucune lib d'icônes. */
  readonly icon?: ReactNode;
}

export function Toast({ message, visible, onHide, icon }: ToastProps) {
  const { theme, colors } = useTheme();
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;

  useEffect(() => {
    if (!visible) {
      Animated.timing(progress, {
        toValue: 0,
        duration: EXIT_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
      return;
    }
    setMounted(true);
    Animated.timing(progress, {
      toValue: 1,
      duration: ENTER_MS,
      useNativeDriver: true,
    }).start();
    const timer = setTimeout(() => {
      Animated.timing(progress, {
        toValue: 0,
        duration: EXIT_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          setMounted(false);
          onHideRef.current();
        }
      });
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [visible, progress]);

  if (!mounted) return null;

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });

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
        {icon ? (
          <View
            style={{
              width: ICON_SIZE,
              height: ICON_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {icon}
          </View>
        ) : null}
        <Text style={[font('sub'), { color: colors.surface, fontWeight: '600' }]}>{message}</Text>
      </View>
    </Animated.View>
  );
}
