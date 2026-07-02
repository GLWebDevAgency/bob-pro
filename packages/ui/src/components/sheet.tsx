/**
 * Sheet — bottom sheet maison (COMPONENT_SPECS.md §16, décision contrat : PAS de @gorhom).
 * Modal transparent + Animated (translateY entrée/sortie ~220 ms).
 * Scrim overlays.scrim (Pressable qui ferme), feuille surface borderTopRadius 26,
 * poignée 36×5 controls.sheetHandle centrée, padding 18–20.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Modal, Pressable, View } from 'react-native';
import { useTheme } from '../theme';

const DURATION_MS = 220;
/** Course d'entrée/sortie (dp) — couvre la hauteur usuelle d'une feuille du proto. */
const SLIDE_DISTANCE = 480;

export interface SheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function Sheet({ visible, onClose, children }: SheetProps) {
  const { colors, controls, overlays, radius } = useTheme();
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(progress, {
        toValue: 1,
        duration: DURATION_MS,
        useNativeDriver: true,
      }).start();
      return;
    }
    Animated.timing(progress, {
      toValue: 0,
      duration: DURATION_MS,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, progress]);

  if (!mounted) return null;

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [SLIDE_DISTANCE, 0],
  });

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: overlays.scrim,
            opacity: progress,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fermer la feuille"
            onPress={onClose}
            style={{ flex: 1, minHeight: 44 }}
          />
        </Animated.View>
        <Animated.View
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: 26,
            borderTopRightRadius: 26,
            paddingTop: 10,
            paddingHorizontal: 20,
            paddingBottom: 18,
            transform: [{ translateY }],
          }}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 36,
              height: 5,
              borderRadius: radius.pill,
              backgroundColor: controls.sheetHandle,
              marginBottom: 14,
            }}
          />
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}
