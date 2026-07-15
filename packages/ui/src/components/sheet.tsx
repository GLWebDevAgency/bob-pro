/**
 * Sheet — bottom sheet maison (COMPONENT_SPECS.md §16, décision contrat : PAS de @gorhom).
 * Modal transparent + Animated (translateY entrée/sortie ~220 ms).
 * Scrim overlays.scrim (Pressable qui ferme), feuille surface borderTopRadius 26,
 * poignée 36×5 controls.sheetHandle centrée, padding 18–20.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  findNodeHandle,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { useTheme } from '../theme';
import { resolveSheetGeometry } from './sheet.logic';

const DURATION_MS = 220;
/** Course d'entrée/sortie (dp) — couvre la hauteur usuelle d'une feuille du proto. */
const SLIDE_DISTANCE = 480;

export interface SheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** Libellé annoncé à l'ouverture (i18n fourni par l'appelant si nécessaire). */
  readonly accessibilityLabel?: string;
  /** Libellé du bouton de fermeture visible. */
  readonly closeAccessibilityLabel?: string;
}

export function Sheet({
  visible,
  onClose,
  children,
  accessibilityLabel = 'Fenêtre d’options',
  closeAccessibilityLabel = 'Fermer',
}: SheetProps) {
  const { colors, controls, overlays, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const headingRef = useRef<View>(null);
  // Ref (pas le state directement) : lu dans l'effet [visible, progress] SANS le redéclencher
  // si la préférence système change en cours d'animation — le hook partagé reste la SEULE
  // source de vérité, cette ref n'est qu'un pont vers l'API impérative Animated.
  const reduceMotion = useReduceMotion();
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  const modalShownRef = useRef(false);
  const openingCompleteRef = useRef(false);
  const focusFrameRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const geometry = resolveSheetGeometry(windowHeight, insets);

  useEffect(() => {
    if (visible) {
      modalShownRef.current = false;
      openingCompleteRef.current = false;
      setMounted(true);
      Animated.timing(progress, {
        toValue: 1,
        duration: reduceMotionRef.current ? 0 : DURATION_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) return;
        openingCompleteRef.current = true;
        scheduleInitialFocus();
      });
      return;
    }
    modalShownRef.current = false;
    openingCompleteRef.current = false;
    Animated.timing(progress, {
      toValue: 0,
      duration: reduceMotionRef.current ? 0 : DURATION_MS,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, progress]);

  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    },
    [],
  );

  if (!mounted) return null;

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [SLIDE_DISTANCE, 0],
  });

  function scheduleInitialFocus(): void {
    if (!visibleRef.current || !modalShownRef.current || !openingCompleteRef.current) return;
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (!visibleRef.current) return;
      const nativeTag = findNodeHandle(headingRef.current);
      if (nativeTag !== null) AccessibilityInfo.setAccessibilityFocus(nativeTag);
    });
  }

  const handleModalShow = (): void => {
    modalShownRef.current = true;
    scheduleInitialFocus();
  };

  return (
    <Modal
      transparent
      visible
      animationType="none"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onShow={handleModalShow}
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
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
            onPress={onClose}
            style={{ flex: 1 }}
          />
        </Animated.View>
        <Animated.View
          accessible={false}
          role="dialog"
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: 26,
            borderTopRightRadius: 26,
            maxHeight: geometry.maxHeight,
            paddingLeft: geometry.paddingLeft,
            paddingRight: geometry.paddingRight,
            transform: [{ translateY }],
          }}
        >
          <View
            style={{
              height: 48,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View
              ref={headingRef}
              collapsable={false}
              accessible
              accessibilityRole="header"
              accessibilityLabel={accessibilityLabel}
              style={{ minWidth: 44, minHeight: 24, alignItems: 'center', justifyContent: 'center' }}
            >
              <View
                importantForAccessibility="no"
                style={{
                  width: 36,
                  height: 5,
                  borderRadius: radius.pill,
                  backgroundColor: controls.sheetHandle,
                }}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={closeAccessibilityLabel}
              accessibilityHint="Ferme cette fenêtre sans appliquer d’autre changement."
              hitSlop={4}
              onPress={onClose}
              style={({ pressed }) => ({
                position: 'absolute',
                right: 0,
                top: 2,
                width: 44,
                height: 44,
                borderRadius: radius.pill,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? controls.segmentedTrack : colors.surface,
              })}
            >
              <Text
                accessible={false}
                allowFontScaling={false}
                style={{ color: colors.slate500, fontSize: 28, fontWeight: '500', lineHeight: 30 }}
              >
                ×
              </Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flexGrow: 0, maxHeight: geometry.contentMaxHeight }}
            contentContainerStyle={{ paddingBottom: geometry.paddingBottom }}
            bounces={false}
            contentInsetAdjustmentBehavior="never"
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            overScrollMode="auto"
            showsVerticalScrollIndicator
          >
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}
