/**
 * TrendBars — la dataviz du kit (Lot 5, plan DA 01/08) : groupe de barres horizontales sur
 * piste `lineSoft`, remplissage au token sémantique passé par l'écran, largeur animée 0→n%
 * (400 ms ease-out) UNIQUEMENT si la préférence reduce-motion est résolue à 'inactive'
 * (useReduceMotionPreference tri-état).
 *
 * FAIL-CLOSED PAR CONSTRUCTION :
 * · préférence `unknown` ou `active` → la barre est un View STATIQUE à `n%` dès la première
 *   frame (l'information est LÀ sans le mouvement — dataviz honnête, doctrine tab bar v2) ;
 * · la poussée 0→n% ne s'engage QUE quand la préférence est résolue à 'inactive' (en
 *   pratique : dans la frame qui suit le montage — la lecture AccessibilityInfo est native) ;
 * · une bascule `inactive` → `active` en vol coupe l'animation : retour au statique, état
 *   final identique au pixel dans les trois états.
 * Consommateurs (Lot 5) : pilotage (série facturé/encaissé, parts des top clients).
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { useReduceMotionPreference } from '../hooks/use-accessibility-preference';
import {
  TREND_BAR_DEFAULT_HEIGHT,
  TREND_BAR_DEFAULT_RADIUS,
  TREND_BARS_DEFAULT_GAP,
  clampTrendBarPct,
  resolveTrendBarsMotion,
} from './trend-bars.logic';

export interface TrendBarSpec {
  /** Part en % [0, 100], DÉJÀ dérivée par l'écran (le kit ne calcule aucun agrégat métier). */
  readonly pct: number;
  /** Teinte de remplissage — un token sémantique de l'écran, jamais un hex local. */
  readonly color: string;
}

export interface TrendBarsProps {
  /** Une ou plusieurs barres empilées (gap 3) — série facturé/encaissé, part client seule… */
  readonly bars: readonly TrendBarSpec[];
  /** Hauteur de piste (défaut 7 — barres de série ; 4 pour les parts de classement). */
  readonly height?: number;
  readonly radius?: number;
  /** Piste (défaut colors.lineSoft). */
  readonly trackColor?: string;
  readonly style?: StyleProp<ViewStyle>;
}

function TrendBarFill({
  pct,
  color,
  radius,
  animated,
  durationMs,
}: {
  readonly pct: number;
  readonly color: string;
  readonly radius: number;
  readonly animated: boolean;
  readonly durationMs: number;
}) {
  const target = clampTrendBarPct(pct);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!animated) {
      // Statique : aucun timer — et une bascule en vol coupe l'animation en cours.
      progress.stopAnimation();
      return;
    }
    Animated.timing(progress, {
      toValue: target,
      duration: durationMs,
      easing: Easing.out(Easing.cubic),
      // width en % = prop de layout — pas de driver natif.
      useNativeDriver: false,
    }).start();
  }, [animated, durationMs, progress, target]);

  if (!animated) {
    // L'état FINAL, au pixel, dès la première frame — sans Animated.
    return (
      <View
        style={{ height: '100%', width: `${target}%`, borderRadius: radius, backgroundColor: color }}
      />
    );
  }
  const width = progress.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });
  return (
    <Animated.View
      style={{ height: '100%', width, borderRadius: radius, backgroundColor: color }}
    />
  );
}

export function TrendBars({
  bars,
  height = TREND_BAR_DEFAULT_HEIGHT,
  radius = TREND_BAR_DEFAULT_RADIUS,
  trackColor,
  style,
}: TrendBarsProps) {
  const { colors } = useTheme();
  const preference = useReduceMotionPreference();
  const motion = resolveTrendBarsMotion(preference);

  return (
    <View style={[{ gap: TREND_BARS_DEFAULT_GAP }, style]}>
      {bars.map((bar, index) => (
        <View
          key={index}
          style={{
            height,
            borderRadius: radius,
            backgroundColor: trackColor ?? colors.lineSoft,
            overflow: 'hidden',
          }}
        >
          <TrendBarFill
            pct={bar.pct}
            color={bar.color}
            radius={radius}
            animated={motion.animated}
            durationMs={motion.durationMs}
          />
        </View>
      ))}
    </View>
  );
}
