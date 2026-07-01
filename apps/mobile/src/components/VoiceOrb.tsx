import { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme, parseGradient } from '../theme';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * Orbe vocale de Bob (mode mains-libres, façon Jarvis). 100 % Animated natif (useNativeDriver) :
 * l'orbe « respire » en continu, et émet des anneaux d'onde quand Bob écoute ou parle. Gradient signature (DA).
 */
export function VoiceOrb({ state, size = 176 }: { state: OrbState; size?: number }) {
  const { grad, semantic } = useTheme();
  const active = state === 'listening' || state === 'speaking';
  const breathe = useRef(new Animated.Value(0)).current;
  const rings = useRef([new Animated.Value(0), new Animated.Value(0)]).current;

  useEffect(() => {
    const b = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    b.start();
    return () => b.stop();
  }, [breathe]);

  useEffect(() => {
    if (!active) {
      rings.forEach((r) => r.setValue(0));
      return;
    }
    const loops = rings.map((r, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 900),
          Animated.timing(r, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [active, rings]);

  const scale = breathe.interpolate({ inputRange: [0, 1], outputRange: active ? [1, 1.08] : [0.97, 1.02] });
  const g = parseGradient(grad.hero);

  return (
    <View style={{ width: size * 2, height: size * 2, alignItems: 'center', justifyContent: 'center' }}>
      {active
        ? rings.map((r, i) => (
            <Animated.View
              key={i}
              style={{
                position: 'absolute',
                width: size,
                height: size,
                borderRadius: size / 2,
                borderWidth: 2,
                borderColor: semantic.ai,
                opacity: r.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] }),
                transform: [{ scale: r.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }],
              }}
            />
          ))
        : null}
      <Animated.View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          transform: [{ scale }],
          shadowColor: semantic.ai,
          shadowOpacity: 0.5,
          shadowRadius: 30,
          shadowOffset: { width: 0, height: 12 },
          elevation: 16,
        }}
      >
        <LinearGradient
          colors={g.colors}
          start={g.start}
          end={g.end}
          style={{ flex: 1, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: '#fff', fontSize: size * 0.26 }}>✳</Text>
        </LinearGradient>
      </Animated.View>
    </View>
  );
}
