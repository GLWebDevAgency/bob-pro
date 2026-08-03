/**
 * AuthField — LE champ de formulaire on-dark de la famille auth (vague hors-lots, audit
 * 03/08). Remplace 3 duplications (NavyField de LoginScreen, RecoveryField, TextInput inline
 * de ProvisioningScreen) : label meta 12 white70 (détail ≥ white70, doctrine Lot 0) + input
 * navy (white07 / bord white16, dangerVivid en erreur — graphique) + toggle de visibilité
 * OPTIONNEL du mot de passe (parité d'affordance : l'œil existait en récupération mais pas à
 * la connexion — même famille, même champ, même geste).
 */
import { useState, type ComponentProps } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { t } from '@bob/i18n';
import { font, useTheme } from '@bob/ui';
import { AUTH_FIELD_RADIUS, authFieldBorderColor } from './auth-primitives.logic';

export interface AuthFieldOwnProps {
  readonly label: string;
  readonly error?: boolean;
  /** Champ mot de passe avec bouton afficher/masquer (cible 48×72, i18n auth.recovery*). */
  readonly secureToggle?: boolean;
}

export type AuthFieldProps = AuthFieldOwnProps & ComponentProps<typeof TextInput>;

export function AuthField({ label, error = false, secureToggle = false, ...input }: AuthFieldProps) {
  const { colors, overlays, semantic, personality } = useTheme();
  const [visible, setVisible] = useState(false);
  const secureTextEntry = secureToggle ? !visible : input.secureTextEntry;
  const visibilityLabel = t(visible ? 'auth.recoveryHidePassword' : 'auth.recoveryShowPassword', {
    personality,
  });
  return (
    <View style={{ gap: 7 }}>
      <Text style={[font('meta'), { color: overlays.white70 }]}>{label}</Text>
      <View
        style={{
          minHeight: 54,
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: overlays.white07,
          borderWidth: 1,
          borderColor: authFieldBorderColor(error, {
            danger: semantic.dangerVivid,
            idle: overlays.white16,
          }),
          borderRadius: AUTH_FIELD_RADIUS,
        }}
      >
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={overlays.white50}
          {...input}
          secureTextEntry={secureTextEntry}
          style={[
            font('body'),
            {
              flex: 1,
              minHeight: 52,
              paddingHorizontal: 16,
              paddingVertical: 14,
              color: colors.surface,
            },
          ]}
        />
        {secureToggle ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={visibilityLabel}
            onPress={() => setVisible((current) => !current)}
            hitSlop={4}
            style={{ minWidth: 72, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={[font('label', 600), { color: overlays.white70 }]}>
              {visible
                ? t('auth.recoveryHide', { personality })
                : t('auth.recoveryShow', { personality })}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
