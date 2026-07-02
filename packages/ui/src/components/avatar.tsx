/**
 * Avatar — redlines §8. Squircle radius 14 (client) ou rond (user), tailles 34–44.
 * Fond : dégradé du thème (user) ou pastel sémantique (prop tone).
 * Initiales Schibsted 700 blanches (font('cardTitle')).
 */
import { Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme, font, parseGradient } from '../theme';
import { statusBadgeColors, type StatusBadgeVariant } from './status-badge.logic';
import { useStatusBadgePalette } from './status-badge';

/** Initiales : 2 premières lettres des 2 premiers mots. */
export function initialsFromName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

export interface AvatarProps {
  name: string;
  /** 34–44 (redlines §8). */
  size?: number;
  /** squircle = client (radius 14) · circle = user (rond). */
  shape?: 'squircle' | 'circle';
  /** Pastel sémantique — sinon dégradé du thème (user). */
  tone?: StatusBadgeVariant;
}

export function Avatar({ name, size = 44, shape = 'squircle', tone }: AvatarProps) {
  const { colors, radius, grad } = useTheme();
  const badgePalette = useStatusBadgePalette();
  const borderRadius = shape === 'circle' ? size / 2 : radius.squircle;
  const frame = {
    width: size,
    height: size,
    borderRadius,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
  };

  if (tone) {
    // Sur pastel, les initiales prennent la teinte pleine assortie (lisibilité).
    const toneColors = statusBadgeColors(tone, badgePalette);
    return (
      <View
        accessibilityRole="image"
        accessibilityLabel={name}
        style={[frame, { backgroundColor: toneColors.bg }]}
      >
        <Text style={[font('cardTitle'), { color: toneColors.fg }]}>{initialsFromName(name)}</Text>
      </View>
    );
  }

  const initials = (
    <Text style={[font('cardTitle'), { color: colors.surface }]}>{initialsFromName(name)}</Text>
  );

  const g = parseGradient(grad.cta);
  return (
    <View accessibilityRole="image" accessibilityLabel={name} style={frame}>
      <LinearGradient
        colors={g.colors}
        start={g.start}
        end={g.end}
        style={{
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {initials}
      </LinearGradient>
    </View>
  );
}
