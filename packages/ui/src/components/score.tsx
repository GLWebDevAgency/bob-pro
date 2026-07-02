/**
 * ScoreBar & ScoreRing — §13 (diagnostic /100, client).
 * Bar : piste lineSoft h8 radius pill, remplissage teinté par tranche, largeur = score %.
 * Ring : SVG r≈52, piste controls.ringTrack, arc strokeDashoffset animé 900 ms,
 * couleur par tranche (<50 danger · 50–75 warning · >75 success), centre bigNum.
 */
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { font, useTheme } from '../theme';
import { clampScore, scoreBand, scoreFillPercent } from './score.logic';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export interface ScoreBarProps {
  score: number;
  accessibilityLabel?: string;
}

export function ScoreBar({ score, accessibilityLabel }: ScoreBarProps) {
  const { colors, semantic, radius } = useTheme();
  const clamped = clampScore(score);
  const fill = `${scoreFillPercent(score)}%` as const;

  return (
    <View
      style={[styles.barTrack, { backgroundColor: colors.lineSoft, borderRadius: radius.pill }]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
      {...(accessibilityLabel !== undefined ? { accessibilityLabel } : {})}
    >
      <View
        style={[
          styles.barFill,
          { width: fill, backgroundColor: semantic[scoreBand(score)], borderRadius: radius.pill },
        ]}
      />
    </View>
  );
}

const RING_RADIUS = 52;
const RING_STROKE = 10;
const RING_VIEWBOX = 120;
const RING_CENTER = RING_VIEWBOX / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export interface ScoreRingProps {
  score: number;
  /** Diamètre rendu (défaut 120 dp, r≈52 dans le viewBox). */
  size?: number;
  accessibilityLabel?: string;
}

export function ScoreRing({ score, size = RING_VIEWBOX, accessibilityLabel }: ScoreRingProps) {
  const { colors, semantic, controls } = useTheme();
  const clamped = clampScore(score);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: clamped,
      duration: 900,
      useNativeDriver: false, // strokeDashoffset (prop SVG) non supporté par le driver natif
    }).start();
  }, [clamped, progress]);

  const dashOffset = progress.interpolate({
    inputRange: [0, 100],
    outputRange: [RING_CIRCUMFERENCE, 0],
  });

  return (
    <View
      style={{ width: size, height: size }}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
      {...(accessibilityLabel !== undefined ? { accessibilityLabel } : {})}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${RING_VIEWBOX} ${RING_VIEWBOX}`}>
        <Circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          stroke={controls.ringTrack}
          strokeWidth={RING_STROKE}
          fill="none"
        />
        <AnimatedCircle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          stroke={semantic[scoreBand(score)]}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
          strokeDashoffset={dashOffset}
          rotation={-90}
          originX={RING_CENTER}
          originY={RING_CENTER}
        />
      </Svg>
      <View style={styles.ringCenter} pointerEvents="none">
        <Text style={[font('bigNum'), styles.ringValue, { color: colors.ink900 }]}>
          {Math.round(clamped)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  barTrack: { height: 8, overflow: 'hidden' },
  barFill: { height: 8 },
  ringCenter: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringValue: { fontVariant: ['tabular-nums'] },
});
