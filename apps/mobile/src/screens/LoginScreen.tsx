/**
 * Auth — connexion + inscription (claim C24, proto dc.html §auth, adapté à l'auth réelle Supabase).
 *
 * FLUX (contrat C24) :
 *   LOGIN (proto auth0+auth1 fusionnés : email+mdp sur un écran — le vrai signIn Supabase
 *   n'a pas d'étape intermédiaire) · « Mot de passe oublié » → resetPasswordForEmail réel,
 *   toast HONNÊTE (« si un compte existe ») · « Pas encore de compte ? Créer » →
 *   INSCRIPTION 3 étapes (Stepper) : SIRET → lookupCompany RÉEL (GET /company/lookup,
 *   Recherche d'entreprises) → récap officiel pré-rempli → compte (prénom+email+mdp) →
 *   signUp réel (user_metadata.first_name/full_name → useIdentity) → « Vérifie tes mails ».
 *
 * ORDRE signUp / POST company (C24b) : POST /onboarding/company exige une session (guard JWT),
 * impossible AVANT la confirmation email → on ne l'appelle PAS ici. La fiche entreprise
 * COMPLÈTE du lookup (dénomination, NAF, forme juridique, adresse, TVA, date de création)
 * part en user_metadata.company_snapshot au signUp ; après le premier login, le
 * ProvisioningScreen la relit et provisionne le tenant (registerCompany → app_metadata.company_id).
 *
 * Écarts assumés vs proto §auth :
 * · SSO Google/Apple et « lien magique » non câblés → non affichés (pas de bouton fantôme) ;
 * · 2FA (auth2) inexistante côté Supabase ici → étape absente et « 2FA » retiré du footer ;
 * · « Continuer avec Face ID » (auth0) devient l'opt-in réel post-login + verrou au boot
 *   (BiometricGate) — la biométrie ne REMPLACE pas le premier login par mot de passe ;
 * · l'écran succès (auth3) est omis : la session réelle bascule l'app immédiatement.
 * · fond 172° navy→nuit : même rampe tokens que l'onboarding C22 (marine.d1 → graphite.d1).
 */
import { useEffect, useState, type ComponentProps } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Siret, type CompanyLookupResult } from '@bob/core';
import { themes } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import { Card, Stepper, font, useTheme } from '@bob/ui';
import { useAuth, type AuthErrorCode } from '../data/auth';
import { markFreshLogin } from '../data/biometric';
import { useLookupCompany } from '../data/hooks';
import {
  discriminateSiretLookupError,
  type SiretLookupFailureReason,
} from '../lib/siret-lookup-error';
import { CompanyFicheCard, formatSiret } from '../components/CompanyFicheCard';
import { ChevronLeftIcon, LockIcon, MailIcon, SparkIcon } from '../components/icons';

type Step = 'login' | 'siret' | 'company' | 'account' | 'verify';

/** Codes typés de la couche data → copy voix Bob (aucun message brut Supabase à l'écran). */
const AUTH_ERR_KEY: Record<AuthErrorCode, I18nKey> = {
  invalid_credentials: 'auth.errCredentials',
  email_not_confirmed: 'auth.errEmailNotConfirmed',
  user_exists: 'auth.errUserExists',
  weak_password: 'auth.errWeakPassword',
  invalid_email: 'auth.errEmailInvalid',
  rate_limited: 'auth.errRateLimited',
  network: 'auth.errNetwork',
  disabled: 'auth.errUnknown',
  unknown: 'auth.errUnknown',
};

/**
 * Motif du discriminateur PARTAGÉ (`lib/siret-lookup-error`) → copy auth. `contract` et
 * `lookup_down` partagent une copy car l'ACTION est identique à cette étape (réessayer ou
 * passer) — règle spec §8 : deux motifs peuvent partager une copy, jamais un booléen.
 */
const AUTH_SIRET_ERROR_KEY: Record<SiretLookupFailureReason, I18nKey> = {
  invalid: 'auth.errSiretInvalid',
  not_found: 'auth.errSiretNotFound',
  rate_limited: 'auth.errRateLimited',
  contract: 'auth.errLookupDown',
  lookup_down: 'auth.errLookupDown',
  unknown: 'auth.errUnknown',
};

const lookupErrorKey = (error: unknown): I18nKey =>
  AUTH_SIRET_ERROR_KEY[discriminateSiretLookupError(error).reason];

const MIN_PASSWORD_LENGTH = 8;

/** Champ de saisie sur navy — voile blanc 7 %, bord 16 %, texte surface (proto §auth). */
function NavyField({
  label,
  error,
  ...input
}: {
  label: string;
  error?: boolean;
} & ComponentProps<typeof TextInput>) {
  const { colors, overlays, semantic } = useTheme();
  return (
    <View style={{ gap: 7 }}>
      <Text style={[font('label', 600), { fontSize: 12, color: overlays.white60 }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={overlays.white50}
        style={[
          font('body'),
          {
            backgroundColor: overlays.white07,
            borderWidth: 1,
            borderColor: error ? semantic.dangerVivid : overlays.white16,
            borderRadius: 15,
            paddingHorizontal: 16,
            paddingVertical: 15,
            fontSize: 15,
            color: colors.surface,
          },
        ]}
        {...input}
      />
    </View>
  );
}

/** CTA blanc plein du proto (Se connecter / Continuer / Créer mon compte). */
function PrimaryCta({
  label,
  busy,
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
      accessibilityState={{ disabled: busy === true, busy: busy === true }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: colors.surface,
        borderRadius: 15,
        minHeight: 52,
        justifyContent: 'center',
        alignItems: 'center',
        opacity: busy ? 0.7 : 1,
        transform: [{ scale: pressed && !busy ? 0.97 : 1 }],
      })}
    >
      <Text style={[font('button'), { color: colors.ink900 }]}>{busy ? '…' : label}</Text>
    </Pressable>
  );
}

/** Lien texte discret sur navy (mdp oublié, bascule login/inscription, passer l'étape). */
function GhostLink({
  label,
  onPress,
  align,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  align?: 'center' | 'right';
  disabled?: boolean;
}) {
  const { overlays } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        alignSelf: align === 'right' ? 'flex-end' : 'center',
        minHeight: 44,
        justifyContent: 'center',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <Text style={[font('label', 600), { fontSize: 13.5, color: overlays.white70 }]}>{label}</Text>
    </Pressable>
  );
}

/** Message d'erreur voix Bob, annoncé aux lecteurs d'écran. */
function ErrorLine({ message }: { message: string | null }) {
  const { semantic } = useTheme();
  if (!message) return null;
  return (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[font('sub'), { fontSize: 13.5, color: semantic.dangerVivid }]}
    >
      {message}
    </Text>
  );
}

export function LoginScreen() {
  const { colors, overlays, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const { signIn, signUp, resetPassword, resendSignupConfirmation } = useAuth();
  const lookup = useLookupCompany();

  const [step, setStep] = useState<Step>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [siret, setSiret] = useState(''); // chiffres bruts (14 max), affiché groupé
  const [company, setCompany] = useState<CompanyLookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Code TYPÉ de la dernière erreur de connexion : `email_not_confirmed` débloque le renvoi
  // de l'email de confirmation (avec la nouvelle cible de redirection) directement depuis ici.
  const [loginErrorCode, setLoginErrorCode] = useState<AuthErrorCode | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // confirmations (reset envoyé)
  const [busy, setBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [resendRemainingSeconds, setResendRemainingSeconds] = useState(0);
  const resendCooldownSeconds = Math.max(
    resendRemainingSeconds,
    Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1_000)),
  );

  const say = (key: I18nKey, params?: Readonly<Record<string, string | number>>): string =>
    t(key, params ? { personality, params } : { personality });

  const goTo = (next: Step): void => {
    setError(null);
    setLoginErrorCode(null);
    setNotice(null);
    setStep(next);
  };

  useEffect(() => {
    if (step !== 'verify' || resendAvailableAt === 0) {
      setResendRemainingSeconds(0);
      return;
    }
    const initialRemaining = Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1_000));
    setResendRemainingSeconds(initialRemaining);
    if (initialRemaining === 0) return;
    const update = (): void => {
      const remaining = Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1_000));
      setResendRemainingSeconds(remaining);
      if (remaining === 0) clearInterval(timer);
    };
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [resendAvailableAt, step]);

  // ── LOGIN — signIn réel, erreurs typées, reset honnête ────────────────────
  async function submitLogin(): Promise<void> {
    if (busy) return;
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      setError(say('auth.errFields'));
      return;
    }
    setBusy(true);
    setError(null);
    setLoginErrorCode(null);
    setNotice(null);
    // AVANT l'await : Supabase notifie SIGNED_IN pendant l'appel — le BiometricGate peut
    // monter avant la fin de cette fonction et doit déjà savoir que le login est interactif
    // (sinon verrou Face ID juste après le mot de passe). Drapeau mémoire, sans effet si échec.
    markFreshLogin();
    const res = await signIn(cleanEmail, password);
    setBusy(false);
    if (res.error) {
      setError(say(AUTH_ERR_KEY[res.error]));
      setLoginErrorCode(res.error);
      return;
    }
    // Session posée → AuthGate bascule l'app ; le gate biométrique proposera l'opt-in.
  }

  async function submitReset(): Promise<void> {
    if (busy) return;
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setError(say('auth.resetNeedEmail'));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await resetPassword(cleanEmail);
    setBusy(false);
    if (res.error) {
      setError(say(AUTH_ERR_KEY[res.error]));
      return;
    }
    // Honnête par conception : Supabase répond pareil que le compte existe ou non —
    // la copy dit « si un compte existe », jamais « compte trouvé ».
    setNotice(say('auth.resetSent', { email: cleanEmail }));
  }

  // ── INSCRIPTION étape 1 — SIRET → lookup RÉEL ─────────────────────────────
  async function submitSiret(): Promise<void> {
    if (busy || lookup.isPending) return;
    const v = Siret.of(siret);
    if (!v.ok) {
      setError(say('auth.errSiretInvalid'));
      return;
    }
    setError(null);
    try {
      const found = await lookup.mutateAsync(v.value.value);
      setCompany(found);
      goTo('company');
    } catch (e) {
      setError(say(lookupErrorKey(e)));
    }
  }

  // ── INSCRIPTION étape 3 — signUp réel (metadata identité + instantané entreprise) ──
  async function submitAccount(): Promise<void> {
    if (busy) return;
    const cleanFirst = firstName.trim();
    const cleanEmail = email.trim();
    if (!cleanFirst) {
      setError(say('auth.errFirstName'));
      return;
    }
    if (!cleanEmail || !password) {
      setError(say('auth.errFields'));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(say('auth.errWeakPassword'));
      return;
    }
    setBusy(true);
    setError(null);
    // Même précaution que submitLogin : si la confirmation email est désactivée, la session
    // arrive PENDANT l'await — le drapeau doit être posé avant (voir commentaire submitLogin).
    markFreshLogin();
    const res = await signUp({
      email: cleanEmail,
      password,
      firstName: cleanFirst,
      fullName: cleanFirst,
      // C24b : snapshot COMPLET de la fiche annuaire — le provisioning l'enverra tel quel en base.
      company: company ?? undefined,
    });
    setBusy(false);
    if (res.error) {
      setError(say(AUTH_ERR_KEY[res.error]));
      return;
    }
    if (res.needsConfirmation) {
      // L'email initial vient de partir : même garde que Supabase pour éviter les doubles taps
      // et donner un retour temporel explicite à l'utilisateur.
      setResendAvailableAt(Date.now() + 60_000);
      goTo('verify');
      return;
    }
    // Confirmation email désactivée côté projet : session immédiate → l'app bascule.
  }

  async function submitVerificationResend(): Promise<void> {
    // Le timestamp ferme aussi la très courte fenêtre avant le premier tick du compteur React.
    if (resendBusy || resendAvailableAt > Date.now()) return;
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setError(say('auth.resetNeedEmail'));
      return;
    }
    setResendBusy(true);
    setError(null);
    setNotice(null);
    const res = await resendSignupConfirmation(cleanEmail);
    setResendBusy(false);
    if (res.error) {
      setError(say(AUTH_ERR_KEY[res.error]));
      return;
    }
    setResendAvailableAt(Date.now() + 60_000);
    setNotice(say('auth.verifyResent'));
  }

  const backTarget: Partial<Record<Step, Step>> = {
    siret: 'login',
    company: 'siret',
    account: company ? 'company' : 'siret',
  };
  const signupStepIndex = step === 'siret' ? 0 : step === 'company' ? 1 : 2;
  const stepLabels = [say('auth.stepSiret'), say('auth.stepCompany'), say('auth.stepAccount')];

  // ── Rendu des étapes ───────────────────────────────────────────────────────
  const loginStep = (
    <View style={{ flex: 1, justifyContent: 'center', gap: 14 }}>
      <View
        style={{
          width: 60,
          height: 60,
          borderRadius: 19,
          backgroundColor: colors.surface,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8,
        }}
      >
        <SparkIcon color={colors.ink900} size={32} strokeWidth={1.9} />
      </View>
      <Text style={[font('screenH1'), { fontSize: 22, color: colors.surface }]}>Bob Pro</Text>
      <View style={{ gap: 6, marginBottom: 6 }}>
        <Text style={[font('screenH1'), { fontSize: 29, lineHeight: 32, color: colors.surface }]}>
          {say('auth.loginTitle')}
        </Text>
        <Text style={[font('body'), { fontSize: 15, lineHeight: 22, color: overlays.white60 }]}>
          {say('auth.loginSub')}
        </Text>
      </View>
      <NavyField
        label={say('auth.emailLabel')}
        value={email}
        onChangeText={setEmail}
        placeholder={say('auth.emailPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
      />
      <NavyField
        label={say('auth.passwordLabel')}
        value={password}
        onChangeText={setPassword}
        placeholder="••••••••"
        secureTextEntry
        autoComplete="current-password"
        returnKeyType="go"
        onSubmitEditing={() => void submitLogin()}
      />
      <GhostLink label={say('auth.forgot')} align="right" onPress={() => void submitReset()} />
      <ErrorLine message={error} />
      {loginErrorCode === 'email_not_confirmed' ? (
        // Compte réel jamais confirmé (ex. ancien email parti vers localhost) : le renvoi part
        // d'ici avec la NOUVELLE cible de redirection — aucun besoin de recréer le compte.
        <GhostLink
          label={say('auth.loginResendConfirm')}
          onPress={() => {
            goTo('verify');
            void submitVerificationResend();
          }}
        />
      ) : null}
      {notice ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[font('sub'), { fontSize: 13.5, color: semantic.successOnDark }]}
        >
          {notice}
        </Text>
      ) : null}
      <PrimaryCta label={say('auth.loginCta')} busy={busy} onPress={() => void submitLogin()} />
      <GhostLink label={say('auth.switchToSignup')} onPress={() => goTo('siret')} />
    </View>
  );

  const siretStep = (
    <View style={{ flex: 1, justifyContent: 'center', gap: 14 }}>
      <View style={{ gap: 6, marginBottom: 6 }}>
        <Text style={[font('screenH1'), { fontSize: 26, lineHeight: 30, color: colors.surface }]}>
          {say('auth.siretTitle')}
        </Text>
        <Text style={[font('body'), { fontSize: 15, lineHeight: 22, color: overlays.white60 }]}>
          {say('auth.siretSub')}
        </Text>
      </View>
      <NavyField
        label={say('auth.stepSiret')}
        value={formatSiret(siret)}
        onChangeText={(raw) => setSiret(raw.replace(/\D/g, '').slice(0, 14))}
        placeholder={say('auth.siretPlaceholder')}
        keyboardType="number-pad"
        returnKeyType="done"
        onSubmitEditing={() => void submitSiret()}
        error={error !== null}
      />
      <ErrorLine message={error} />
      <PrimaryCta
        label={say('auth.siretCta')}
        busy={lookup.isPending}
        onPress={() => void submitSiret()}
      />
      <GhostLink
        label={say('auth.siretSkip')}
        onPress={() => {
          setCompany(null);
          goTo('account');
        }}
      />
    </View>
  );

  const companyStep = company ? (
    <View style={{ flex: 1, justifyContent: 'center', gap: 14 }}>
      <View style={{ gap: 6 }}>
        <Text style={[font('screenH1'), { fontSize: 26, lineHeight: 30, color: colors.surface }]}>
          {say('auth.companyTitle')}
        </Text>
        <Text style={[font('body'), { fontSize: 15, lineHeight: 22, color: overlays.white60 }]}>
          {say('auth.companySub')}
        </Text>
      </View>
      {/* Fiche société COMPLÈTE (C24b) : tout ce que l'annuaire officiel connaît —
          composant partagé avec le ProvisioningScreen (lignes absentes masquées). */}
      <CompanyFicheCard company={company} />
      <PrimaryCta label={say('auth.companyConfirm')} onPress={() => goTo('account')} />
      <GhostLink label={say('auth.companyEdit')} onPress={() => goTo('siret')} />
    </View>
  ) : (
    // Garde : récap sans lookup (impossible via les CTA) — retour à la saisie SIRET.
    siretStep
  );

  const accountStep = (
    <View style={{ flex: 1, justifyContent: 'center', gap: 14 }}>
      <View style={{ gap: 6, marginBottom: 6 }}>
        <Text style={[font('screenH1'), { fontSize: 26, lineHeight: 30, color: colors.surface }]}>
          {say('auth.accountTitle')}
        </Text>
        <Text style={[font('body'), { fontSize: 15, lineHeight: 22, color: overlays.white60 }]}>
          {say('auth.accountSub')}
        </Text>
      </View>
      <NavyField
        label={say('auth.firstNameLabel')}
        value={firstName}
        onChangeText={setFirstName}
        placeholder={say('auth.firstNamePlaceholder')}
        autoComplete="given-name"
        autoCorrect={false}
      />
      <NavyField
        label={say('auth.emailLabel')}
        value={email}
        onChangeText={setEmail}
        placeholder={say('auth.emailPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
      />
      <View style={{ gap: 7 }}>
        <NavyField
          label={say('auth.passwordLabel')}
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          secureTextEntry
          autoComplete="new-password"
          returnKeyType="go"
          onSubmitEditing={() => void submitAccount()}
        />
        <Text style={[font('meta'), { fontSize: 12, color: overlays.white50 }]}>
          {say('auth.passwordHint')}
        </Text>
      </View>
      <ErrorLine message={error} />
      <PrimaryCta label={say('auth.signupCta')} busy={busy} onPress={() => void submitAccount()} />
    </View>
  );

  const verifyStep = (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <View
        style={{
          width: 90,
          height: 90,
          borderRadius: 45,
          backgroundColor: colors.surface,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 10,
        }}
      >
        <MailIcon color={colors.ink900} size={40} strokeWidth={1.9} />
      </View>
      <Text
        style={[font('screenH1'), { fontSize: 26, color: colors.surface, textAlign: 'center' }]}
      >
        {say('auth.verifyTitle')}
      </Text>
      <Text
        style={[
          font('body'),
          {
            fontSize: 15,
            lineHeight: 23,
            maxWidth: 300,
            textAlign: 'center',
            color: overlays.white66,
          },
        ]}
      >
        {say('auth.verifyBody', { email: email.trim() })}
      </Text>
      <View style={{ alignSelf: 'stretch', marginTop: 12 }}>
        <PrimaryCta
          label={say('auth.verifyCta')}
          onPress={() => {
            setPassword('');
            goTo('login');
          }}
        />
      </View>
      <ErrorLine message={error} />
      {notice ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[
            font('sub'),
            { fontSize: 13.5, color: semantic.successOnDark, textAlign: 'center' },
          ]}
        >
          {notice}
        </Text>
      ) : null}
      <GhostLink
        label={
          resendCooldownSeconds > 0
            ? say('auth.verifyResendIn', { seconds: resendCooldownSeconds })
            : resendBusy
              ? say('auth.verifyResending')
              : say('auth.verifyResend')
        }
        disabled={resendBusy || resendCooldownSeconds > 0}
        onPress={() => void submitVerificationResend()}
      />
    </View>
  );

  const content =
    step === 'login'
      ? loginStep
      : step === 'siret'
        ? siretStep
        : step === 'company'
          ? companyStep
          : step === 'account'
            ? accountStep
            : verifyStep;

  const back = backTarget[step];

  return (
    <View style={{ flex: 1, backgroundColor: themes.marine.d1 }}>
      {/* Fond du proto §auth (172° navy → nuit) — même rampe tokens que l'onboarding C22. */}
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
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingTop: insets.top + 10,
            paddingHorizontal: 24,
            paddingBottom: insets.bottom + 20,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* En-tête : retour (inscription) + bascule vers la connexion */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: 34,
            }}
          >
            {back !== undefined ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={say('onboard.back')}
                onPress={() => goTo(back)}
                hitSlop={8}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
              >
                <ChevronLeftIcon color={overlays.white70} size={17} strokeWidth={2.2} />
                <Text style={[font('label', 600), { fontSize: 14.5, color: overlays.white70 }]}>
                  {say('onboard.back')}
                </Text>
              </Pressable>
            ) : (
              <View />
            )}
            {step === 'siret' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={say('auth.switchToLogin')}
                onPress={() => goTo('login')}
                hitSlop={8}
              >
                <Text style={[font('label', 600), { fontSize: 13.5, color: overlays.white60 }]}>
                  {say('auth.switchToLogin')}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {/* Progression de l'inscription — Stepper @bob/ui sur carte surface (pattern C22) */}
          {step === 'siret' || step === 'company' || step === 'account' ? (
            <Card padding={10} radius={14} style={{ marginTop: 10 }}>
              <Stepper total={3} current={signupStepIndex} labels={stepLabels} />
            </Card>
          ) : null}
          {content}
          {/* Pied sécurité du proto (sans « 2FA » — non implémenté, on ne le promet pas) */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              paddingTop: 16,
            }}
          >
            <LockIcon color={overlays.white50} size={13} strokeWidth={2} />
            <Text style={[font('meta'), { fontSize: 11.5, color: overlays.white50 }]}>
              {say('auth.footerSecure')}
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
