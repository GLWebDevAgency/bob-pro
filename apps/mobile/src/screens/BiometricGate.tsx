/**
 * BiometricGate (C24) — verrou Face ID / Touch ID de la session persistée.
 *
 * COMPORTEMENT (contrat C24, opt-in, dégradé honnête) :
 * · session absente ou Supabase non configuré → passe-plat (aucune UI) ;
 * · login interactif à l'instant (markFreshLogin) → JAMAIS re-verrouillé, et si
 *   l'utilisateur n'a pas encore répondu, on PROPOSE l'opt-in (Sheet « Déverrouille
 *   avec Face ID ») — accepter déclenche une vraie authentification de confirmation ;
 * · boot avec session persistée + opt-in accepté + biométrie dispo → écran verrouillé
 *   navy, authentification lancée d'office, réessai possible, repli « Utiliser mon
 *   mot de passe » (signOut → LoginScreen) ;
 * · après opt-in, matériel absent / rien d'enrôlé / panne native → aucun bypass : la
 *   session reste verrouillée et le repli sûr demande une nouvelle connexion par mot de passe.
 * L'opt-in refusé est persisté (pas de nag au boot). TODO(C24→réglages) : bascule
 * d'activation dans /compte pour revenir sur ce choix.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { themes } from '@bob/tokens';
import { t } from '@bob/i18n';
import { Button, Sheet, Toast, font, useReduceMotion, useTheme } from '@bob/ui';
import { useAuth } from '../data/auth';
import {
  authenticateBiometric,
  biometricMethodLabel,
  consumeFreshLogin,
  getBiometricSupport,
  readBiometricOptIn,
  writeBiometricOptIn,
  type BiometricSupport,
} from '../data/biometric';
import { CheckIcon, LockIcon } from '../components/icons';
import {
  decideBiometricGate,
  isBiometricDecisionCurrent,
  shouldRelockBiometricSession,
} from '../data/biometric-policy';
import { loadAuthBootstrapWithTimeout } from '../data/auth-bootstrap';

type Phase = 'checking' | 'locked' | 'open';
const BIOMETRIC_PROBE_TIMEOUT_MS = 8_000;
const BIOMETRIC_PROMPT_TIMEOUT_MS = 60_000;
const BIOMETRIC_RELOCK_GRACE_MS = 30_000;

export function BiometricGate({ children }: { children: ReactNode }) {
  const { colors, overlays, semantic, personality } = useTheme();
  const reduceMotion = useReduceMotion();
  const insets = useSafeAreaInsets();
  const { enabled, session, signOut } = useAuth();

  const [phase, setPhase] = useState<Phase>('checking');
  const [resolvedUserId, setResolvedUserId] = useState<string | null>(null);
  const [support, setSupport] = useState<BiometricSupport | null>(null);
  const [proposalVisible, setProposalVisible] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const unlockingRef = useRef(false);
  const [protectionEnabled, setProtectionEnabled] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const protectionEnabledRef = useRef(protectionEnabled);
  protectionEnabledRef.current = protectionEnabled;
  const backgroundedAtRef = useRef<number | null>(null);

  // Dépendre de l'UTILISATEUR (pas de l'objet session : le refresh de jeton change
  // l'identité de l'objet et re-verrouillerait l'app en pleine utilisation).
  const userId = session?.user.id ?? null;

  const method = biometricMethodLabel(support?.method ?? 'generic');
  const say = useCallback(
    (key: Parameters<typeof t>[0], params?: Readonly<Record<string, string | number>>): string =>
      t(key, params ? { personality, params } : { personality }),
    [personality],
  );

  useEffect(() => {
    if (!enabled || userId === null) {
      setPhase('open');
      setResolvedUserId(null);
      setProtectionEnabled(false);
      backgroundedAtRef.current = null;
      setProposalVisible(false);
      return;
    }
    setPhase('checking');
    setResolvedUserId(null);
    setProposalVisible(false);
    setLockError(null);
    const freshPasswordLogin = consumeFreshLogin();
    let active = true;
    void (async () => {
      try {
        const [sup, optIn] = await loadAuthBootstrapWithTimeout(
          () => Promise.all([getBiometricSupport(), readBiometricOptIn()]),
          BIOMETRIC_PROBE_TIMEOUT_MS,
        );
        if (!active) return;
        setSupport(sup);
        const decision = decideBiometricGate({
          freshPasswordLogin,
          optIn,
          supportAvailable: sup.available,
        });
        setProtectionEnabled(optIn === true);
        setPhase(decision === 'locked' ? 'locked' : 'open');
        setProposalVisible(decision === 'offer');
        setResolvedUserId(userId);
      } catch {
        if (!active) return;
        setSupport({ available: false, method: 'generic' });
        // Le mot de passe vient d'être vérifié : il reste une preuve valide. Au boot d'une
        // session persistée, l'état SecureStore inconnu reste verrouillé (fail-closed).
        if (freshPasswordLogin) setPhase('open');
        else {
          setLockError(say('auth.bioUnavailable'));
          setPhase('locked');
        }
        setResolvedUserId(userId);
      }
    })();
    return () => {
      active = false;
    };
  }, [enabled, say, userId]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        backgroundedAtRef.current ??= Date.now();
        return;
      }
      if (nextState !== 'active') return;
      const shouldLock = shouldRelockBiometricSession({
        protectionEnabled: protectionEnabledRef.current,
        backgroundedAtMs: backgroundedAtRef.current,
        resumedAtMs: Date.now(),
        thresholdMs: BIOMETRIC_RELOCK_GRACE_MS,
      });
      backgroundedAtRef.current = null;
      if (shouldLock && phaseRef.current === 'open') setPhase('locked');
    });
    return () => subscription.remove();
  }, []);

  const unlock = useCallback(async (): Promise<void> => {
    if (unlockingRef.current) return;
    unlockingRef.current = true;
    setUnlocking(true);
    setLockError(null);
    try {
      const res = await loadAuthBootstrapWithTimeout(
        () => authenticateBiometric(say('auth.bioPrompt')),
        BIOMETRIC_PROMPT_TIMEOUT_MS,
      );
      if (res.ok) {
        setPhase('open');
        return;
      }
      setLockError(say(res.degraded ? 'auth.bioUnavailable' : 'auth.bioFailed'));
    } catch {
      setLockError(say('auth.bioUnavailable'));
    } finally {
      unlockingRef.current = false;
      setUnlocking(false);
    }
  }, [say]);

  // Verrouillé → on lance l'authentification d'office (le proto ouvre Face ID direct).
  useEffect(() => {
    if (phase === 'locked') void unlock();
  }, [phase, unlock]);

  async function acceptOptIn(): Promise<void> {
    setSheetError(null);
    try {
      const res = await loadAuthBootstrapWithTimeout(
        () => authenticateBiometric(say('auth.bioPrompt')),
        BIOMETRIC_PROMPT_TIMEOUT_MS,
      );
      if (!res.ok) {
        setSheetError(say(res.degraded ? 'auth.bioUnavailable' : 'auth.bioFailed'));
        return;
      }
      await loadAuthBootstrapWithTimeout(
        () => writeBiometricOptIn(true),
        BIOMETRIC_PROBE_TIMEOUT_MS,
      );
      setProtectionEnabled(true);
      setProposalVisible(false);
      setToastVisible(true);
    } catch {
      setSheetError(say('auth.bioPreferenceError'));
    }
  }

  async function declineOptIn(): Promise<void> {
    try {
      await loadAuthBootstrapWithTimeout(
        () => writeBiometricOptIn(false),
        BIOMETRIC_PROBE_TIMEOUT_MS,
      );
      setProtectionEnabled(false);
      setProposalVisible(false);
    } catch {
      setSheetError(say('auth.bioPreferenceError'));
    }
  }

  // Une identité de session différente ne doit jamais hériter, même pendant une frame, de
  // la décision « open » prise pour l'utilisateur précédent.
  const decisionCurrent = isBiometricDecisionCurrent({
    authEnabled: enabled,
    userId,
    resolvedUserId,
  });
  if (phase === 'checking' || !decisionCurrent) {
    return (
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={say('auth.bioChecking')}
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          backgroundColor: themes.marine.d1,
        }}
      >
        <LockIcon color={colors.surface} size={32} strokeWidth={1.9} />
        <ActivityIndicator color={colors.surface} />
        <Text style={[font('sub'), { color: overlays.white66 }]}>{say('auth.bioChecking')}</Text>
      </View>
    );
  }

  if (phase === 'locked') {
    return (
      <View style={{ flex: 1, backgroundColor: themes.marine.d1 }}>
        <LinearGradient
          pointerEvents="none"
          colors={[themes.marine.d1, themes.graphite.d1]}
          start={{ x: 0.45, y: 0 }}
          end={{ x: 0.55, y: 1 }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <View
          style={{
            flex: 1,
            paddingTop: insets.top + 10,
            paddingHorizontal: 24,
            paddingBottom: insets.bottom + 20,
          }}
        >
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }}>
            <View
              style={{
                width: 78,
                height: 78,
                borderRadius: 24,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 10,
              }}
            >
              <LockIcon color={colors.ink900} size={34} strokeWidth={1.9} />
            </View>
            <Text
              style={[
                font('screenH1'),
                { fontSize: 26, color: colors.surface, textAlign: 'center' },
              ]}
            >
              {say('auth.lockTitle')}
            </Text>
            <Text
              style={[
                font('body'),
                {
                  fontSize: 15,
                  lineHeight: 22,
                  maxWidth: 280,
                  textAlign: 'center',
                  color: overlays.white66,
                },
              ]}
            >
              {say('auth.lockBody', { method })}
            </Text>
            {lockError ? (
              <Text
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={[font('sub'), { fontSize: 13.5, color: semantic.dangerVivid }]}
              >
                {lockError}
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={say('auth.lockCta')}
            accessibilityState={{ disabled: unlocking, busy: unlocking }}
            disabled={unlocking}
            onPress={() => void unlock()}
            style={({ pressed }) => ({
              minHeight: 52,
              backgroundColor: colors.surface,
              borderRadius: 15,
              paddingVertical: 16,
              justifyContent: 'center',
              alignItems: 'center',
              opacity: unlocking ? 0.7 : 1,
              transform: [{ scale: pressed && !reduceMotion ? 0.97 : 1 }],
            })}
          >
            <Text style={[font('button'), { color: colors.ink900 }]}>{say('auth.lockCta')}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={say('auth.lockFallback')}
            onPress={() => void signOut()}
            style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center' }}
          >
            <Text style={[font('label', 600), { fontSize: 14.5, color: overlays.white60 }]}>
              {say('auth.lockFallback')}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <>
      {children}
      {/* Proposition d'opt-in après le premier login réussi (Sheet @bob/ui) */}
      <Sheet visible={proposalVisible} onClose={() => void declineOptIn()}>
        <View style={{ gap: 10, paddingBottom: 6 }}>
          <Text style={[font('cardTitle'), { fontSize: 19, color: colors.ink900 }]}>
            {say('auth.bioTitle', { method })}
          </Text>
          <Text style={[font('body'), { fontSize: 14.5, lineHeight: 21, color: colors.slate500 }]}>
            {say('auth.bioBody')}
          </Text>
          {sheetError ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[font('sub'), { fontSize: 13.5, color: semantic.danger }]}
            >
              {sheetError}
            </Text>
          ) : null}
          <View style={{ gap: 8, marginTop: 8 }}>
            <Button title={say('auth.bioAccept', { method })} onPress={() => void acceptOptIn()} />
            <Button
              title={say('auth.bioLater')}
              variant="secondary"
              onPress={() => void declineOptIn()}
            />
          </View>
        </View>
      </Sheet>
      <Toast
        message={say('auth.bioEnabled', { method })}
        visible={toastVisible}
        onHide={() => setToastVisible(false)}
        icon={<CheckIcon color={colors.surface} size={16} strokeWidth={2.6} />}
      />
    </>
  );
}
