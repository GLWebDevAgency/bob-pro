/**
 * Récupération de mot de passe (deep link Supabase) — l'écran consomme l'URL, la nettoie de
 * la navigation, délègue la preuve à la couche data, puis fait saisir le nouveau mot de passe.
 *
 * Vague hors-lots (audit 03/08) : AuthField/AuthCta partagés (fin des RecoveryField/
 * RecoveryButton dupliqués), ligne d'erreur en encre danger on-dark certifiée
 * (surfaceTint.dark.danger.ink — dangerVivid ≈4,3:1 échouait l'AA sur marine.d1),
 * H1 au cran screenH1, corps white80 / détails white70, fade-through fail-closed
 * entre les phases, coche verte pour le succès (SparkIcon = canal exclusif de Bob).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { addEventListener, clearInitialURL, getInitialURL } from 'expo-linking';
import { useRouter, type Href } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { surfaceTint, themes } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import { FadeIn, font, useTheme } from '@bob/ui';
import { CheckIcon, LockIcon } from '../components/icons';
import { AuthCta } from '../components/auth/AuthCta';
import { AuthField } from '../components/auth/AuthField';
import { useAuth } from '../data/auth';
import {
  isPasswordRecoveryUrl,
  PASSWORD_RECOVERY_ROUTE,
  validateRecoveryPassword,
  type PasswordRecoveryErrorCode,
} from '../auth-recovery/password-recovery';

const RECOVERY_ERROR_KEY: Record<PasswordRecoveryErrorCode, I18nKey> = {
  invalid_link: 'auth.recoveryInvalidBody',
  expired_link: 'auth.recoveryExpiredBody',
  weak_password: 'auth.errWeakPassword',
  network: 'auth.errNetwork',
  rate_limited: 'auth.errRateLimited',
  not_ready: 'auth.recoveryInvalidBody',
  unknown: 'auth.errUnknown',
};

export function PasswordRecoveryScreen() {
  const { colors, overlays, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    passwordRecovery,
    beginPasswordRecovery,
    updateRecoveredPassword,
    finishPasswordRecovery,
  } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [validationError, setValidationError] = useState<I18nKey | null>(null);
  // Booléens uniquement : l'URL (qui peut contenir les jetons) n'est jamais conservée dans React.
  const initialLinkHandled = useRef(false);
  const linkProcessing = useRef(false);

  const say = (key: I18nKey): string => t(key, { personality });

  const consumeLink = useCallback(
    async (candidate: string): Promise<void> => {
      if (linkProcessing.current || !isPasswordRecoveryUrl(candidate)) return;
      linkProcessing.current = true;
      try {
        // beginPasswordRecovery parse la preuve avant son premier await. On nettoie donc l'URL
        // immédiatement après, sans attendre le réseau ni laisser les tokens dans l'historique.
        const consumption =
          passwordRecovery.phase === 'idle' || passwordRecovery.phase === 'error'
            ? beginPasswordRecovery(candidate)
            : Promise.resolve();
        clearInitialURL();
        router.replace(PASSWORD_RECOVERY_ROUTE as Href);
        await consumption;
      } finally {
        linkProcessing.current = false;
      }
    },
    [beginPasswordRecovery, passwordRecovery.phase, router],
  );

  useEffect(() => {
    const subscription = addEventListener('url', ({ url }) => {
      initialLinkHandled.current = true;
      void consumeLink(url);
    });
    return () => subscription.remove();
  }, [consumeLink]);

  useEffect(() => {
    if (initialLinkHandled.current) return;
    let active = true;
    void (async () => {
      const candidate = await getInitialURL();
      if (!active || initialLinkHandled.current) return;
      initialLinkHandled.current = true;
      if (candidate && isPasswordRecoveryUrl(candidate)) {
        await consumeLink(candidate);
      } else if (passwordRecovery.phase === 'idle') {
        await beginPasswordRecovery('');
      }
    })();
    return () => {
      active = false;
    };
  }, [beginPasswordRecovery, consumeLink, passwordRecovery.phase]);

  async function submit(): Promise<void> {
    if (passwordRecovery.phase !== 'ready') return;
    const validation = validateRecoveryPassword(password, confirmation);
    if (!validation.ok) {
      setValidationError(
        validation.reason === 'mismatch'
          ? 'auth.recoveryMismatch'
          : validation.reason === 'too_long'
            ? 'auth.recoveryTooLong'
            : validation.reason === 'required'
              ? 'auth.recoveryRequired'
              : 'auth.errWeakPassword',
      );
      return;
    }
    setValidationError(null);
    await updateRecoveredPassword(password);
  }

  function continueToApp(): void {
    setPassword('');
    setConfirmation('');
    finishPasswordRecovery();
    router.replace('/');
  }

  const establishing =
    passwordRecovery.phase === 'idle' || passwordRecovery.phase === 'establishing';
  const linkError = passwordRecovery.phase === 'error';
  const success = passwordRecovery.phase === 'success';
  const updating = passwordRecovery.phase === 'updating';
  const formError = validationError
    ? say(validationError)
    : passwordRecovery.error
      ? say(RECOVERY_ERROR_KEY[passwordRecovery.error])
      : null;
  const linkErrorIsProof =
    passwordRecovery.error === 'invalid_link' || passwordRecovery.error === 'expired_link';
  const fieldError = validationError !== null || passwordRecovery.error === 'weak_password';
  const phaseKey = establishing ? 'establishing' : linkError ? 'error' : success ? 'success' : 'ready';
  // Encre danger on-dark CERTIFIÉE (≥8:1) du kit matière — dangerVivid échouait l'AA ici.
  const dangerOnDark = surfaceTint.dark.danger.ink;

  return (
    <View style={{ flex: 1, backgroundColor: themes.marine.d1 }}>
      <LinearGradient
        pointerEvents="none"
        colors={[themes.marine.d1, themes.graphite.d1]}
        start={{ x: 0.45, y: 0 }}
        end={{ x: 0.55, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            paddingTop: insets.top + 28,
            paddingHorizontal: 24,
            paddingBottom: insets.bottom + 28,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={{ gap: 18 }}>
            <View
              accessible
              accessibilityLabel="Bob Pro"
              style={{
                width: 60,
                height: 60,
                borderRadius: 19,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {success ? (
                // La coche verte dit le succès — SparkIcon reste le glyphe exclusif de Bob.
                <CheckIcon color={semantic.success} size={31} strokeWidth={2.4} />
              ) : (
                <LockIcon color={colors.ink900} size={29} strokeWidth={1.9} />
              )}
            </View>

            {/* Fade-through fail-closed entre les phases (annonces préservées). */}
            <FadeIn key={phaseKey}>
            {establishing ? (
              <View
                accessibilityLiveRegion="polite"
                accessibilityRole="progressbar"
                style={{ gap: 12 }}
              >
                <Text
                  style={[
                    font('screenH1'),
                    { lineHeight: 32, color: colors.surface },
                  ]}
                >
                  {say('auth.recoveryCheckingTitle')}
                </Text>
                <Text
                  style={[font('body'), { lineHeight: 22, color: overlays.white80 }]}
                >
                  {say('auth.recoveryCheckingBody')}
                </Text>
                <ActivityIndicator color={colors.surface} style={{ alignSelf: 'flex-start' }} />
              </View>
            ) : linkError ? (
              <View style={{ gap: 14 }}>
                <Text
                  accessibilityRole="header"
                  style={[
                    font('screenH1'),
                    { lineHeight: 32, color: colors.surface },
                  ]}
                >
                  {say(
                    passwordRecovery.error === 'expired_link'
                      ? 'auth.recoveryExpiredTitle'
                      : linkErrorIsProof
                        ? 'auth.recoveryInvalidTitle'
                        : 'auth.recoveryCheckFailedTitle',
                  )}
                </Text>
                <Text
                  accessibilityRole="alert"
                  style={[font('body'), { lineHeight: 22, color: overlays.white80 }]}
                >
                  {say(
                    passwordRecovery.error
                      ? RECOVERY_ERROR_KEY[passwordRecovery.error]
                      : 'auth.recoveryInvalidBody',
                  )}
                </Text>
                <AuthCta label={say('auth.recoveryBack')} onPress={continueToApp} />
              </View>
            ) : success ? (
              <View accessibilityLiveRegion="polite" style={{ gap: 14 }}>
                <Text
                  accessibilityRole="header"
                  style={[
                    font('screenH1'),
                    { lineHeight: 32, color: colors.surface },
                  ]}
                >
                  {say('auth.recoverySuccessTitle')}
                </Text>
                <Text
                  style={[font('body'), { lineHeight: 22, color: overlays.white80 }]}
                >
                  {say('auth.recoverySuccessBody')}
                </Text>
                <AuthCta label={say('auth.recoverySuccessCta')} onPress={continueToApp} />
              </View>
            ) : (
              <View style={{ gap: 14 }}>
                <View style={{ gap: 6, marginBottom: 2 }}>
                  <Text
                    accessibilityRole="header"
                    style={[
                      font('screenH1'),
                      { lineHeight: 32, color: colors.surface },
                    ]}
                  >
                    {say('auth.recoveryTitle')}
                  </Text>
                  <Text
                    style={[
                      font('body'),
                      { lineHeight: 22, color: overlays.white80 },
                    ]}
                  >
                    {say('auth.recoveryBody')}
                  </Text>
                </View>
                <AuthField
                  label={say('auth.recoveryNewPassword')}
                  value={password}
                  onChangeText={(value) => {
                    setPassword(value);
                    setValidationError(null);
                  }}
                  placeholder="••••••••"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="new-password"
                  textContentType="newPassword"
                  accessibilityHint={say('auth.passwordHint')}
                  secureToggle
                  error={fieldError}
                />
                <AuthField
                  label={say('auth.recoveryConfirmPassword')}
                  value={confirmation}
                  onChangeText={(value) => {
                    setConfirmation(value);
                    setValidationError(null);
                  }}
                  placeholder="••••••••"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="new-password"
                  textContentType="newPassword"
                  accessibilityHint={say('auth.passwordHint')}
                  secureToggle
                  error={fieldError}
                  returnKeyType="go"
                  onSubmitEditing={() => void submit()}
                />
                <Text style={[font('meta'), { color: overlays.white70 }]}>
                  {say('auth.passwordHint')}
                </Text>
                {formError ? (
                  <Text
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={[font('sub'), { color: dangerOnDark }]}
                  >
                    {formError}
                  </Text>
                ) : null}
                <AuthCta
                  label={say('auth.recoveryCta')}
                  busy={updating}
                  onPress={() => void submit()}
                />
              </View>
            )}
            </FadeIn>

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
              }}
            >
              <LockIcon color={overlays.white70} size={13} strokeWidth={2} />
              <Text style={[font('meta'), { color: overlays.white70 }]}>
                {say('auth.footerSecure')}
              </Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
