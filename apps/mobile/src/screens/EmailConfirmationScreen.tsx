/**
 * Retour du lien de confirmation d'inscription (deep link `bobpro://auth/callback`, atteint
 * directement ou via la page relais sign-web `/auth/confirme`). Miroir architectural de
 * PasswordRecoveryScreen : l'écran consomme l'URL (initiale ou événement), la nettoie
 * immédiatement de la navigation, puis délègue l'échange de preuve à la couche data (auth.tsx).
 *
 * Issues honnêtes :
 * · preuve échangée → session publiée, l'app entre toute seule (AuthGate) ;
 * · compte confirmé sans session possible (autre appareil, code déjà servi) → « connecte-toi » ;
 * · lien expiré/invalide → copy dédiée, retour connexion (le login propose le renvoi d'email).
 *
 * Vague hors-lots (audit 03/08) : AuthCta partagé (fin du ConfirmationButton dupliqué),
 * CheckIcon vert pour le succès (SparkIcon reste le glyphe EXCLUSIF de Bob), H1 au cran
 * screenH1, corps white80 / détails white70 (doctrine on-dark), fade-through fail-closed
 * entre les phases (FadeIn kit — coupé net sous reduce-motion).
 */
import { useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { addEventListener, clearInitialURL, getInitialURL } from 'expo-linking';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { themes } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import { FadeIn, font, useTheme } from '@bob/ui';
import { CheckIcon, LockIcon, MailIcon } from '../components/icons';
import { AuthCta } from '../components/auth/AuthCta';
import { useAuth } from '../data/auth';
import { markFreshLogin } from '../data/biometric';
import {
  EMAIL_CONFIRMATION_DEEP_LINK,
  EMAIL_CONFIRMATION_ROUTE,
  isEmailConfirmationUrl,
  type EmailConfirmationErrorCode,
} from '../auth-confirmation/email-confirmation';

const CONFIRMATION_ERROR_TITLE_KEY: Record<EmailConfirmationErrorCode, I18nKey> = {
  invalid_link: 'auth.confirmInvalidTitle',
  expired_link: 'auth.confirmExpiredTitle',
  network: 'auth.confirmCheckFailedTitle',
  rate_limited: 'auth.confirmCheckFailedTitle',
  unknown: 'auth.confirmCheckFailedTitle',
};

const CONFIRMATION_ERROR_BODY_KEY: Record<EmailConfirmationErrorCode, I18nKey> = {
  invalid_link: 'auth.confirmInvalidBody',
  expired_link: 'auth.confirmExpiredBody',
  network: 'auth.errNetwork',
  rate_limited: 'auth.errRateLimited',
  unknown: 'auth.errUnknown',
};

/** Paramètres GoTrue transmis par expo-router quand le deep link a navigué sans URL brute. */
const FORWARDED_PARAM_NAMES = [
  'code',
  'access_token',
  'refresh_token',
  'type',
  'error',
  'error_code',
  'error_description',
] as const;

export function EmailConfirmationScreen() {
  const { colors, overlays, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { emailConfirmation, beginEmailConfirmation, finishEmailConfirmation } = useAuth();
  const params = useLocalSearchParams();
  // Booléens uniquement : l'URL (qui peut contenir la preuve) n'est jamais conservée dans React.
  const initialLinkHandled = useRef(false);
  const linkProcessing = useRef(false);

  const say = (key: I18nKey): string => t(key, { personality });

  const consumeLink = useCallback(
    async (candidate: string): Promise<void> => {
      if (linkProcessing.current || !isEmailConfirmationUrl(candidate)) return;
      linkProcessing.current = true;
      try {
        // L'échange peut publier une session PENDANT l'appel : le BiometricGate doit savoir
        // que ce login est interactif (même précaution que LoginScreen.submitLogin).
        markFreshLogin();
        // beginEmailConfirmation parse la preuve avant son premier await. On nettoie donc
        // l'URL immédiatement après, sans laisser le code dans l'historique de navigation.
        const consumption =
          emailConfirmation.phase === 'idle' || emailConfirmation.phase === 'error'
            ? beginEmailConfirmation(candidate)
            : Promise.resolve();
        clearInitialURL();
        router.replace(EMAIL_CONFIRMATION_ROUTE as Href);
        await consumption;
      } finally {
        linkProcessing.current = false;
      }
    },
    [beginEmailConfirmation, emailConfirmation.phase, router],
  );

  useEffect(() => {
    const subscription = addEventListener('url', ({ url }) => {
      initialLinkHandled.current = true;
      void consumeLink(url);
    });
    return () => subscription.remove();
  }, [consumeLink]);

  useEffect(() => {
    if (initialLinkHandled.current || emailConfirmation.phase !== 'idle') return;
    let active = true;
    void (async () => {
      const candidate = await getInitialURL();
      if (!active || initialLinkHandled.current) return;
      initialLinkHandled.current = true;
      if (candidate && isEmailConfirmationUrl(candidate)) {
        await consumeLink(candidate);
        return;
      }
      // App déjà ouverte : expo-router a navigué et absorbé l'URL — on la reconstruit depuis
      // les paramètres de route (le fragment implicite n'y survit pas, le PKCE si).
      const forwarded = new URLSearchParams();
      for (const name of FORWARDED_PARAM_NAMES) {
        const value = params[name];
        if (typeof value === 'string') forwarded.append(name, value);
        else if (Array.isArray(value)) for (const item of value) forwarded.append(name, item);
      }
      if ([...forwarded.keys()].length > 0) {
        await consumeLink(`${EMAIL_CONFIRMATION_DEEP_LINK}?${forwarded.toString()}`);
      } else {
        await beginEmailConfirmation('');
      }
    })();
    return () => {
      active = false;
    };
  }, [beginEmailConfirmation, consumeLink, emailConfirmation.phase, params]);

  const continueToLogin = useCallback((): void => {
    finishEmailConfirmation();
    router.replace('/');
  }, [finishEmailConfirmation, router]);

  // Session établie par l'échange : l'écran s'efface tout seul, AuthGate fait entrer l'app.
  useEffect(() => {
    if (emailConfirmation.phase !== 'signed_in') return;
    const timer = setTimeout(continueToLogin, 900);
    return () => clearTimeout(timer);
  }, [continueToLogin, emailConfirmation.phase]);

  const checking = emailConfirmation.phase === 'idle' || emailConfirmation.phase === 'confirming';
  const signedIn = emailConfirmation.phase === 'signed_in';
  const confirmed = emailConfirmation.phase === 'confirmed';
  const error = emailConfirmation.phase === 'error' ? (emailConfirmation.error ?? 'unknown') : null;
  const phaseKey = checking ? 'checking' : signedIn ? 'signed_in' : confirmed ? 'confirmed' : 'error';

  return (
    <View style={{ flex: 1, backgroundColor: themes.marine.d1 }}>
      <LinearGradient
        pointerEvents="none"
        colors={[themes.marine.d1, themes.graphite.d1]}
        start={{ x: 0.45, y: 0 }}
        end={{ x: 0.55, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
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
            {signedIn || confirmed ? (
              // Le vert-récompense a son glyphe : la COCHE. SparkIcon reste réservé au
              // logo/canal de Bob (doctrine L2 — l'étincelle ne dit jamais « succès »).
              <CheckIcon color={semantic.success} size={31} strokeWidth={2.4} />
            ) : (
              <MailIcon color={colors.ink900} size={29} strokeWidth={1.9} />
            )}
          </View>

          {/* Fade-through fail-closed entre les phases — annonces/focus préservés (les
              liveRegions restent sur les blocs), coupé net sous reduce-motion. */}
          <FadeIn key={phaseKey}>
          {checking ? (
            <View
              accessibilityLiveRegion="polite"
              accessibilityRole="progressbar"
              style={{ gap: 12 }}
            >
              <Text
                style={[font('screenH1'), { lineHeight: 32, color: colors.surface }]}
              >
                {say('auth.confirmCheckingTitle')}
              </Text>
              <Text
                style={[font('body'), { lineHeight: 22, color: overlays.white80 }]}
              >
                {say('auth.confirmCheckingBody')}
              </Text>
              <ActivityIndicator color={colors.surface} style={{ alignSelf: 'flex-start' }} />
            </View>
          ) : signedIn ? (
            <View accessibilityLiveRegion="polite" style={{ gap: 12 }}>
              <Text
                accessibilityRole="header"
                style={[font('screenH1'), { lineHeight: 32, color: colors.surface }]}
              >
                {say('auth.confirmSignedInTitle')}
              </Text>
              <Text
                style={[font('body'), { lineHeight: 22, color: overlays.white80 }]}
              >
                {say('auth.confirmSignedInBody')}
              </Text>
              <ActivityIndicator color={colors.surface} style={{ alignSelf: 'flex-start' }} />
            </View>
          ) : confirmed ? (
            <View accessibilityLiveRegion="polite" style={{ gap: 14 }}>
              <Text
                accessibilityRole="header"
                style={[font('screenH1'), { lineHeight: 32, color: colors.surface }]}
              >
                {say('auth.confirmDoneTitle')}
              </Text>
              <Text
                style={[font('body'), { lineHeight: 22, color: overlays.white80 }]}
              >
                {say('auth.confirmDoneBody')}
              </Text>
              <AuthCta label={say('auth.confirmDoneCta')} onPress={continueToLogin} />
            </View>
          ) : (
            <View style={{ gap: 14 }}>
              <Text
                accessibilityRole="header"
                style={[font('screenH1'), { lineHeight: 32, color: colors.surface }]}
              >
                {say(CONFIRMATION_ERROR_TITLE_KEY[error ?? 'unknown'])}
              </Text>
              <Text
                accessibilityRole="alert"
                style={[font('body'), { lineHeight: 22, color: overlays.white80 }]}
              >
                {say(CONFIRMATION_ERROR_BODY_KEY[error ?? 'unknown'])}
              </Text>
              <AuthCta label={say('auth.confirmBack')} onPress={continueToLogin} />
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
    </View>
  );
}
