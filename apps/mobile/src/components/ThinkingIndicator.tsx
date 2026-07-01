import { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, Easing } from 'react-native';
import { useTheme } from '../theme';
import { font } from './ui';

// Phases décoratives qui défilent (façon Claude Code / Codex). AUCUN token/usage n'est affiché (choix produit).
const PHASES = ['Bob réfléchit', 'Je prépare', "J'analyse", 'Presque prêt'];

/**
 * Indicateur de réflexion de Bob — classe mondiale, 100 % natif (Animated + useNativeDriver, aucune dépendance) :
 * l'étoile de Bob tourne, le libellé de phase défile, trois points ondulent. Palette IA (indigo).
 * Monté uniquement pendant que Bob travaille ; se nettoie tout seul au démontage.
 */
export function ThinkingIndicator() {
  const { semantic } = useTheme();
  const [phase, setPhase] = useState(0);
  const spin = useRef(new Animated.Value(0)).current;
  const dots = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;

  useEffect(() => {
    const spinLoop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 2600, easing: Easing.linear, useNativeDriver: true }),
    );
    spinLoop.start();

    const dotLoops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(v, { toValue: 1, duration: 380, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 380, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.delay((dots.length - 1 - i) * 150),
        ]),
      ),
    );
    dotLoops.forEach((l) => l.start());

    const id = setInterval(() => setPhase((p) => (p + 1) % PHASES.length), 1500);
    return () => {
      spinLoop.stop();
      dotLoops.forEach((l) => l.stop());
      clearInterval(id);
    };
  }, [spin, dots]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: semantic.aiBg,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 16,
      }}
      accessibilityRole="progressbar"
      accessibilityLabel="Bob réfléchit"
    >
      <Animated.Text style={{ color: semantic.ai, fontSize: 16, transform: [{ rotate }] }}>✳</Animated.Text>
      <Text style={[font('sub'), { color: semantic.aiInk }]}>{PHASES[phase]}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3 }}>
        {dots.map((v, i) => (
          <Animated.View
            key={i}
            style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: semantic.ai,
              opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }),
              transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) }],
            }}
          />
        ))}
      </View>
    </View>
  );
}
