/**
 * HeaderIconButton — logique PURE (Lot 0, plan DA 01/08, arbitrage : « squircle 44×44,
 * radius 13 — entre le squircle 42 de clients et le rond 44 de chantiers »). Le bouton
 * d'action de header (+, filtre…) : aplat ink du thème, icône injectée, press scale 0.94.
 */
import type { ViewStyle } from 'react-native';

/** L'arbitrage : 44×44 (cible pleine, sans hitSlop de compensation) et radius 13. */
export const HEADER_ICON_BUTTON_SIZE = 44;
export const HEADER_ICON_BUTTON_RADIUS = 13;
export const HEADER_ICON_BUTTON_PRESSED_SCALE = 0.94;
export const HEADER_ICON_BUTTON_DISABLED_OPACITY = 0.45;

export interface HeaderIconButtonInput {
  readonly pressed: boolean;
  readonly disabled: boolean;
  /** theme.ink — l'aplat signature. */
  readonly ink: string;
}

/** Squircle 44×44 radius 13 — désactivé : opacité 0.45 ; pressé (et actif) : scale 0.94. */
export function headerIconButtonStyle(input: HeaderIconButtonInput): ViewStyle {
  return {
    width: HEADER_ICON_BUTTON_SIZE,
    height: HEADER_ICON_BUTTON_SIZE,
    borderRadius: HEADER_ICON_BUTTON_RADIUS,
    backgroundColor: input.ink,
    alignItems: 'center',
    justifyContent: 'center',
    ...(input.disabled ? { opacity: HEADER_ICON_BUTTON_DISABLED_OPACITY } : {}),
    ...(input.pressed && !input.disabled
      ? { transform: [{ scale: HEADER_ICON_BUTTON_PRESSED_SCALE }] }
      : {}),
  };
}
