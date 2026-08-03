/**
 * AuthCta — LE CTA blanc-sur-navy de la famille auth (vague hors-lots, audit 03/08).
 * Remplace 4 duplications (PrimaryCta de LoginScreen, cta() de ProvisioningScreen,
 * RecoveryButton, ConfirmationButton) qui portaient 3 grammaires de feedback divergentes.
 * Grammaire unique : minHeight 52, radius 15, busy = ActivityIndicator (JAMAIS un texte
 * « … » sur le chemin critique de connexion) + accessibilityState {disabled, busy},
 * press scale 0.97 gaté reduce-motion (fail-closed via useReduceMotion kit).
 * Local à src/components/auth : le kit Button n'a pas de variant on-dark — candidat à une
 * promotion « Button variant onDark » si le web en a besoin (déclaré au plan).
 */
import { ActivityIndicator, Pressable, Text } from 'react-native';
import { font, useReduceMotion, useTheme } from '@bob/ui';
import {
  AUTH_CTA_MIN_HEIGHT,
  AUTH_FIELD_RADIUS,
  authCtaOpacity,
  authCtaPressedScale,
} from './auth-primitives.logic';

export interface AuthCtaProps {
  readonly label: string;
  readonly busy?: boolean;
  readonly onPress: () => void;
}

export function AuthCta({ label, busy = false, onPress }: AuthCtaProps) {
  const { colors } = useTheme();
  const reduceMotion = useReduceMotion();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: AUTH_CTA_MIN_HEIGHT,
        borderRadius: AUTH_FIELD_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.surface,
        opacity: authCtaOpacity(busy),
        transform: [{ scale: authCtaPressedScale(pressed, busy, reduceMotion) }],
      })}
    >
      {busy ? (
        <ActivityIndicator color={colors.ink900} />
      ) : (
        <Text style={[font('button'), { color: colors.ink900 }]}>{label}</Text>
      )}
    </Pressable>
  );
}
