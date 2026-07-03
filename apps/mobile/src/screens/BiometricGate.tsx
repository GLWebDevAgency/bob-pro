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
 * · matériel absent / rien d'enrôlé (simulateur, Expo Go) → on n'affiche RIEN et on
 *   ne bloque RIEN (authenticateBiometric rend ok+degraded) — dégradé honnête.
 * L'opt-in refusé est persisté (pas de nag au boot). TODO(C24→réglages) : bascule
 * d'activation dans /compte pour revenir sur ce choix.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { themes } from '@bob/tokens';
import { t } from '@bob/i18n';
import { Button, Sheet, Toast, font, useTheme } from '@bob/ui';
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

type Phase = 'checking' | 'locked' | 'open';

export function BiometricGate({ children }: { children: ReactNode }) {
  const { colors, overlays, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const { enabled, session, signOut } = useAuth();

  const [phase, setPhase] = useState<Phase>('checking');
  const [support, setSupport] = useState<BiometricSupport | null>(null);
  const [proposalVisible, setProposalVisible] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);

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
      setProposalVisible(false);
      return;
    }
    let active = true;
    void (async () => {
      const [sup, optIn] = await Promise.all([getBiometricSupport(), readBiometricOptIn()]);
      if (!active) return;
      setSupport(sup);
      if (consumeFreshLogin()) {
        // Vient de se connecter au mot de passe : jamais de re-verrouillage ; proposition
        // d'opt-in uniquement si jamais répondu ET biométrie réellement disponible.
        setPhase('open');
        if (optIn === null && sup.available) setProposalVisible(true);
        return;
      }
      setPhase(optIn === true && sup.available ? 'locked' : 'open');
    })();
    return () => {
      active = false;
    };
  }, [enabled, userId]);

  const unlock = useCallback(async (): Promise<void> => {
    setLockError(null);
    const res = await authenticateBiometric(say('auth.bioPrompt'));
    if (res.ok) {
      setPhase('open');
      return;
    }
    setLockError(say('auth.bioFailed'));
  }, [say]);

  // Verrouillé → on lance l'authentification d'office (le proto ouvre Face ID direct).
  useEffect(() => {
    if (phase === 'locked') void unlock();
  }, [phase, unlock]);

  async function acceptOptIn(): Promise<void> {
    setSheetError(null);
    const res = await authenticateBiometric(say('auth.bioPrompt'));
    if (!res.ok) {
      setSheetError(say('auth.bioFailed'));
      return;
    }
    await writeBiometricOptIn(true);
    setProposalVisible(false);
    setToastVisible(true);
  }

  async function declineOptIn(): Promise<void> {
    await writeBiometricOptIn(false);
    setProposalVisible(false);
  }

  if (phase === 'checking') {
    // Décision en cours (lecture SecureStore + matériel) : fond navy muet, sans données.
    return <View style={{ flex: 1, backgroundColor: themes.marine.d1 }} />;
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
            <Text style={[font('screenH1'), { fontSize: 26, color: colors.surface, textAlign: 'center' }]}>
              {say('auth.lockTitle')}
            </Text>
            <Text
              style={[
                font('body'),
                { fontSize: 15, lineHeight: 22, maxWidth: 280, textAlign: 'center', color: overlays.white66 },
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
            onPress={() => void unlock()}
            style={({ pressed }) => ({
              backgroundColor: colors.surface,
              borderRadius: 15,
              paddingVertical: 16,
              alignItems: 'center',
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <Text style={[font('button'), { color: colors.ink900 }]}>{say('auth.lockCta')}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={say('auth.lockFallback')}
            onPress={() => void signOut()}
            style={{ paddingVertical: 12, alignItems: 'center' }}
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
            <Button title={say('auth.bioLater')} variant="secondary" onPress={() => void declineOptIn()} />
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
