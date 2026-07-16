import { useEffect, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';
import { useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { patterns } from '@bob/tokens';
import { useAgentAccessLayout } from '../agent';
import {
  deriveGlobalBobAccessVerticalLayout,
  deriveGlobalBobCollapsedContentInset,
  deriveIosKeyboardViewportOverlap,
} from './global-bob-access-layout';

export type BobAwareKeyboardMode = 'automatic' | 'parent' | 'manual';

export interface BobOverlayMetrics {
  readonly bottom: number;
  readonly keyboardOverlap: number;
}

export interface BobAwareScrollInsets {
  readonly paddingBottom: number;
  readonly scrollIndicatorBottom: number;
  readonly automaticallyAdjustKeyboardInsets: boolean;
}

function safeMetric(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

/** Source React unique des mêmes métriques verticales que l'orbe globale. */
export function useBobOverlayMetrics(): BobOverlayMetrics {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const segments = useSegments();
  const layout = useAgentAccessLayout();
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    const update = (event: { endCoordinates: { width: number; height: number } }): void => {
      setKeyboardOverlap(deriveIosKeyboardViewportOverlap({
        windowWidth: width,
        windowHeight: height,
        frameWidth: event.endCoordinates.width,
        frameHeight: event.endCoordinates.height,
      }));
    };
    const shown = Keyboard.addListener('keyboardWillShow', update);
    const changed = Keyboard.addListener('keyboardWillChangeFrame', update);
    const hidden = Keyboard.addListener('keyboardWillHide', () => setKeyboardOverlap(0));
    return () => {
      shown.remove();
      changed.remove();
      hidden.remove();
    };
  }, [height, width]);

  const bottom = deriveGlobalBobAccessVerticalLayout({
    inTabs: segments[0] === '(tabs)',
    safeAreaBottom: insets.bottom,
    tabPaddingTop: patterns.bottomTabBar.padding[0],
    tabMinimumBottom: patterns.bottomTabBar.padding[2],
    bottomAvoidance: layout.bottomAvoidance ?? 0,
    keyboardOverlap,
  }).bottom;
  return { bottom, keyboardOverlap };
}

/** Inset à fusionner dans le `contentContainerStyle` du scroll principal uniquement. */
export function useBobAwareScrollInsets(input: {
  readonly minimumBottom?: number;
  readonly viewportBottomInset?: number;
  readonly keyboardMode?: BobAwareKeyboardMode;
  readonly manualKeyboardInset?: number;
} = {}): BobAwareScrollInsets {
  const metrics = useBobOverlayMetrics();
  const keyboardMode = input.keyboardMode ?? 'automatic';
  const keyboardViewportInset = keyboardMode === 'manual'
    ? safeMetric(input.manualKeyboardInset)
    : metrics.keyboardOverlap;
  const derived = deriveGlobalBobCollapsedContentInset({
    bobBottom: metrics.bottom,
    viewportBottomInset: safeMetric(input.viewportBottomInset),
    keyboardViewportInset,
    minimumBottom: safeMetric(input.minimumBottom),
  });
  return {
    ...derived,
    automaticallyAdjustKeyboardInsets: Platform.OS === 'ios' && keyboardMode === 'automatic',
  };
}
