/**
 * PressableScale — LE press feedback standard des surfaces interactives (tuiles, lignes,
 * cartes). Scale 0.98 + opacité 0.9 animés en natif (90 ms in / 150 ms out), cible ≥ 44 pt.
 * Reduced-motion : durée 0 — le feedback reste perceptible, le mouvement disparaît.
 * Ne remplace PAS le scale 0.94 instantané des boutons pleins (Button/FAB) : il couvre
 * tout ce qui n'est pas un bouton — QuickAction, ClientRow, KpiTile, lignes de listes…
 */
import { useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import {
  PRESSABLE_SCALE_MIN_TARGET,
  PRESSABLE_SCALE_OPACITY_PRESSED,
  PRESSABLE_SCALE_PRESSED,
  resolvePressMotion,
} from './pressable-scale.logic';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressableScaleProps extends Omit<PressableProps, 'style'> {
  /** Style STATIQUE (pas de fonction ({pressed}) — le feedback est géré ici). */
  style?: StyleProp<ViewStyle>;
  /** Enfoncement pressé (défaut 0.98). */
  pressedScale?: number;
  /** Opacité pressée (défaut 0.9). */
  pressedOpacity?: number;
}

export function PressableScale({
  style,
  pressedScale = PRESSABLE_SCALE_PRESSED,
  pressedOpacity = PRESSABLE_SCALE_OPACITY_PRESSED,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: PressableScaleProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();

  const animate = (pressed: boolean) => {
    const motion = resolvePressMotion(pressed, reduceMotion);
    Animated.timing(progress, {
      toValue: motion.toValue,
      duration: motion.duration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };

  return (
    <AnimatedPressable
      disabled={disabled ?? false}
      {...rest}
      onPressIn={(event: GestureResponderEvent) => {
        animate(true);
        onPressIn?.(event);
      }}
      onPressOut={(event: GestureResponderEvent) => {
        animate(false);
        onPressOut?.(event);
      }}
      style={[
        { minHeight: PRESSABLE_SCALE_MIN_TARGET, minWidth: PRESSABLE_SCALE_MIN_TARGET },
        style,
        {
          opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, pressedOpacity] }),
          transform: [
            { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, pressedScale] }) },
          ],
        },
      ]}
    />
  );
}
