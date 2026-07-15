import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { addEventListener, clearInitialURL, getInitialURL } from 'expo-linking';
import { useRouter, type Href } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { themes } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import { font, useTheme } from '@bob/ui';
import { LockIcon, SparkIcon } from '../components/icons';
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

function RecoveryField({
  label,
  visible,
  onToggleVisibility,
  error,
  ...input
}: {
  label: string;
  visible: boolean;
  onToggleVisibility: () => void;
  error: boolean;
} & ComponentProps<typeof TextInput>) {
  const { colors, overlays, semantic, personality } = useTheme();
  const visibilityLabel = t(visible ? 'auth.recoveryHidePassword' : 'auth.recoveryShowPassword', {
    personality,
  });
  return (
    <View style={{ gap: 7 }}>
      <Text style={[font('label', 600), { fontSize: 12, color: overlays.white60 }]}>{label}</Text>
      <View
        style={{
          minHeight: 54,
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: overlays.white07,
          borderWidth: 1,
          borderColor: error ? semantic.dangerVivid : overlays.white16,
          borderRadius: 15,
        }}
      >
        <TextInput
          accessibilityLabel={label}
          accessibilityHint={t('auth.passwordHint', { personality })}
          placeholder="••••••••"
          placeholderTextColor={overlays.white50}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          style={[
            font('body'),
            {
              flex: 1,
              minHeight: 52,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 15,
              color: colors.surface,
            },
          ]}
          {...input}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visibilityLabel}
          onPress={onToggleVisibility}
          hitSlop={4}
          style={{ minWidth: 72, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={[font('label', 600), { fontSize: 12.5, color: overlays.white70 }]}>
            {visible
              ? t('auth.recoveryHide', { personality })
              : t('auth.recoveryShow', { personality })}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function RecoveryButton({
  label,
  busy = false,
  onPress,
}: {
  label: string;
  busy?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        borderRadius: 15,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.surface,
        opacity: busy ? 0.68 : pressed ? 0.88 : 1,
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
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmationVisible, setConfirmationVisible] = useState(false);
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
                <SparkIcon color={semantic.success} size={31} strokeWidth={2} />
              ) : (
                <LockIcon color={colors.ink900} size={29} strokeWidth={1.9} />
              )}
            </View>

            {establishing ? (
              <View
                accessibilityLiveRegion="polite"
                accessibilityRole="progressbar"
                style={{ gap: 12 }}
              >
                <Text
                  style={[
                    font('screenH1'),
                    { fontSize: 28, lineHeight: 32, color: colors.surface },
                  ]}
                >
                  {say('auth.recoveryCheckingTitle')}
                </Text>
                <Text
                  style={[font('body'), { fontSize: 15, lineHeight: 22, color: overlays.white66 }]}
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
                    { fontSize: 28, lineHeight: 32, color: colors.surface },
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
                  style={[font('body'), { fontSize: 15, lineHeight: 22, color: overlays.white66 }]}
                >
                  {say(
                    passwordRecovery.error
                      ? RECOVERY_ERROR_KEY[passwordRecovery.error]
                      : 'auth.recoveryInvalidBody',
                  )}
                </Text>
                <RecoveryButton label={say('auth.recoveryBack')} onPress={continueToApp} />
              </View>
            ) : success ? (
              <View accessibilityLiveRegion="polite" style={{ gap: 14 }}>
                <Text
                  accessibilityRole="header"
                  style={[
                    font('screenH1'),
                    { fontSize: 28, lineHeight: 32, color: colors.surface },
                  ]}
                >
                  {say('auth.recoverySuccessTitle')}
                </Text>
                <Text
                  style={[font('body'), { fontSize: 15, lineHeight: 22, color: overlays.white66 }]}
                >
                  {say('auth.recoverySuccessBody')}
                </Text>
                <RecoveryButton label={say('auth.recoverySuccessCta')} onPress={continueToApp} />
              </View>
            ) : (
              <View style={{ gap: 14 }}>
                <View style={{ gap: 6, marginBottom: 2 }}>
                  <Text
                    accessibilityRole="header"
                    style={[
                      font('screenH1'),
                      { fontSize: 28, lineHeight: 32, color: colors.surface },
                    ]}
                  >
                    {say('auth.recoveryTitle')}
                  </Text>
                  <Text
                    style={[
                      font('body'),
                      { fontSize: 15, lineHeight: 22, color: overlays.white66 },
                    ]}
                  >
                    {say('auth.recoveryBody')}
                  </Text>
                </View>
                <RecoveryField
                  label={say('auth.recoveryNewPassword')}
                  value={password}
                  onChangeText={(value) => {
                    setPassword(value);
                    setValidationError(null);
                  }}
                  visible={passwordVisible}
                  onToggleVisibility={() => setPasswordVisible((visible) => !visible)}
                  error={fieldError}
                />
                <RecoveryField
                  label={say('auth.recoveryConfirmPassword')}
                  value={confirmation}
                  onChangeText={(value) => {
                    setConfirmation(value);
                    setValidationError(null);
                  }}
                  visible={confirmationVisible}
                  onToggleVisibility={() => setConfirmationVisible((visible) => !visible)}
                  error={fieldError}
                  returnKeyType="go"
                  onSubmitEditing={() => void submit()}
                />
                <Text style={[font('meta'), { fontSize: 12, color: overlays.white50 }]}>
                  {say('auth.passwordHint')}
                </Text>
                {formError ? (
                  <Text
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={[font('sub'), { fontSize: 13.5, color: semantic.dangerVivid }]}
                  >
                    {formError}
                  </Text>
                ) : null}
                <RecoveryButton
                  label={say('auth.recoveryCta')}
                  busy={updating}
                  onPress={() => void submit()}
                />
              </View>
            )}

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
              }}
            >
              <LockIcon color={overlays.white50} size={13} strokeWidth={2} />
              <Text style={[font('meta'), { fontSize: 11.5, color: overlays.white50 }]}>
                {say('auth.footerSecure')}
              </Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
