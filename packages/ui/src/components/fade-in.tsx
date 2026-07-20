/**
 * FadeIn — apparition d'une section : fondu + 6 px de translation (transform only,
 * zéro layout shift), délai en cascade par `index` (40 ms/rang, cap 8).
 * StaggeredList — applique la cascade à une suite de sections enfants.
 * L'animation ne joue qu'AU MONTAGE : un refetch qui re-rend le contenu déjà affiché
 * ne refait jamais fondre l'écran. Reduced-motion : apparition immédiate.
 */
import { Children, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { resolveFadeInMotion } from './fade-in.logic';

export interface FadeInProps {
  /** Rang dans la cascade (0 = immédiat) — délai staggerDelayMs(index). */
  index?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

export function FadeIn({ index = 0, style, children }: FadeInProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const started = useRef(false);
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const motion = resolveFadeInMotion(index, reduceMotion);
    if (motion.duration === 0) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, {
      toValue: 1,
      duration: motion.duration,
      delay: motion.delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [index, progress, reduceMotion]);

  const translate = resolveFadeInMotion(index, reduceMotion).translate;
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [translate, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

export interface StaggeredListProps {
  children: ReactNode;
  /** Style appliqué à CHAQUE rang enveloppé (ex. marginBottom d'une liste sans gap). */
  itemStyle?: StyleProp<ViewStyle>;
}

/** Cascade sobre : chaque enfant direct fond en entrant, décalé de 40 ms (cap 8 rangs). */
export function StaggeredList({ children, itemStyle }: StaggeredListProps) {
  const items = Children.toArray(children);
  return (
    <>
      {items.map((child, index) => (
        <FadeIn
          key={(typeof child === 'object' && child !== null && 'key' in child && child.key !== null
            ? child.key
            : index
          ).toString()}
          index={index}
          {...(itemStyle !== undefined ? { style: itemStyle } : {})}
        >
          {child}
        </FadeIn>
      ))}
    </>
  );
}
