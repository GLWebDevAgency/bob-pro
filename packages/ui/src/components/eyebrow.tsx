/**
 * Eyebrow — sur-titre (échelle `eyebrow` : 12/700, uppercase, tracking 0.4).
 * Couleur par défaut slate400 (redlines §3).
 */
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { useTheme, font } from '../theme';

export interface EyebrowProps {
  children: ReactNode;
  /** Couleur alternative (ex. overlays.white66 sur navy). */
  color?: string;
}

export function Eyebrow({ children, color }: EyebrowProps) {
  const { colors } = useTheme();
  return (
    <Text style={[font('eyebrow'), { color: color ?? colors.slate400 }]}>{children}</Text>
  );
}
