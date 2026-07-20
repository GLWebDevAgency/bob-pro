import { useEffect, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';
import { useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { patterns } from '@bob/tokens';
import { useAgentAccessLayout } from '../agent';
import {
  deriveGlobalBobAccessHorizontalLayout,
  deriveGlobalBobAccessVerticalLayout,
  deriveGlobalBobCollapsedContentInset,
  deriveIosKeyboardViewportOverlap,
  GLOBAL_BOB_ACCESS_INTERACTION_CLEARANCE,
  GLOBAL_BOB_ACCESS_SIZE,
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
  const inTabs = segments[0] === '(tabs)';
  const verticalInput = {
    inTabs,
    safeAreaBottom: insets.bottom,
    tabPaddingTop: patterns.bottomTabBar.padding[0],
    tabMinimumBottom: patterns.bottomTabBar.padding[2],
    bottomAvoidance: layout.bottomAvoidance ?? 0,
  } as const;
  const restingBottom = deriveGlobalBobAccessVerticalLayout({
    ...verticalInput,
    keyboardOverlap: 0,
  }).bottom;
  const restingLeft = deriveGlobalBobAccessHorizontalLayout({
    windowWidth: width,
    safeAreaLeft: insets.left,
    safeAreaRight: insets.right,
  }).left;

  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    const update = (event: {
      endCoordinates: {
        width: number;
        height: number;
        screenX: number;
        screenY: number;
      };
    }): void => {
      setKeyboardOverlap(deriveIosKeyboardViewportOverlap({
        windowWidth: width,
        windowHeight: height,
        frameScreenX: event.endCoordinates.screenX,
        frameScreenY: event.endCoordinates.screenY,
        frameWidth: event.endCoordinates.width,
        frameHeight: event.endCoordinates.height,
        bobLeft: restingLeft,
        bobBottom: restingBottom,
        bobSize: GLOBAL_BOB_ACCESS_SIZE,
        bobClearance: GLOBAL_BOB_ACCESS_INTERACTION_CLEARANCE / 2,
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
  }, [height, restingBottom, restingLeft, width]);

  const bottom = deriveGlobalBobAccessVerticalLayout({
    ...verticalInput,
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
