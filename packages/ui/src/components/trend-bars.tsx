/**
 * TrendBars — la dataviz du kit (Lot 5, plan DA 01/08) : groupe de barres horizontales sur
 * piste `lineSoft`, remplissage au token sémantique passé par l'écran, largeur animée 0→n%
 * (400 ms ease-out) UNIQUEMENT si la préférence reduce-motion est résolue à 'inactive'
 * (useReduceMotionPreference tri-état).
 *
 * FAIL-CLOSED PAR CONSTRUCTION — et FIGÉ AU MONTAGE (verdict Lot 5, P1) :
 * · préférence `unknown` ou `active` → la barre est un View STATIQUE à `n%` dès la première
 *   frame (l'information est LÀ sans le mouvement — dataviz honnête, doctrine tab bar v2) ;
 * · la décision d'animer est prise UNE FOIS, à la première frame (ratchetTrendBarsMotion,
 *   même garde que le `started` de FadeIn) : une résolution TARDIVE à 'inactive' ne fait
 *   JAMAIS retomber la largeur déjà peinte pour rejouer la poussée depuis 0 — la valeur
 *   vraie affichée est irréversible (sonde du verdict : FRAME1 42 % → FRAME2 0, corrigé) ;
 * · une bascule `active` en vol coupe l'animation, définitivement pour ce montage ;
 * · ceinture ET bretelles : l'Animated.Value démarre à `target`, jamais à 0 — même le
 *   premier pixel animé est la valeur vraie.
 * Coût assumé (arbitrage FAIL-CLOSED MOTION, Lot 0) : un montage ouvert pendant la fenêtre
 * d'ignorance reste statique — l'état final est identique au pixel dans tous les cas.
 * Consommateurs (Lot 5) : pilotage (série facturé/encaissé, parts des top clients).
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { useReduceMotionPreference } from '../hooks/use-accessibility-preference';
import {
  TREND_BARS_ANIMATION_MS,
  TREND_BAR_DEFAULT_HEIGHT,
  TREND_BAR_DEFAULT_RADIUS,
  TREND_BARS_DEFAULT_GAP,
  clampTrendBarPct,
  ratchetTrendBarsMotion,
  type TrendBarsMotion,
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
  // Démarre à la VALEUR VRAIE, jamais à 0 (verdict Lot 5) : si la bascule statique →
  // animé devait survenir, le premier pixel animé serait déjà la largeur honnête.
  const progress = useRef(new Animated.Value(target)).current;
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
  // Décision FIGÉE au montage (ratchet une seule direction) : une première frame statique
  // est définitive — la largeur peinte ne retombe jamais ; 'active' en vol coupe, sans retour.
  const grantedRef = useRef<boolean | null>(null);
  grantedRef.current = ratchetTrendBarsMotion(grantedRef.current, preference);
  const motion: TrendBarsMotion = grantedRef.current
    ? { animated: true, durationMs: TREND_BARS_ANIMATION_MS }
    : { animated: false, durationMs: 0 };

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
