/**
 * Biométrie (C24) — déverrouillage de la session persistée par Face ID / Touch ID.
 *
 * RÈGLES (contrat C24, dégradé honnête) :
 * · opt-in explicite, persisté en SecureStore ('yes'/'no' — null = jamais proposé) ;
 * · avant opt-in, le matériel absent ne déclenche aucune proposition ; après opt-in, une
 *   indisponibilité ne devient JAMAIS un bypass : le mot de passe reste la sortie sûre ;
 * · la couche est PURE data (aucune UI) — l'écran (BiometricGate) porte la présentation.
 */
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const OPT_IN_KEY = 'bob.biometric.optin';

export type BiometricMethod = 'faceid' | 'touchid' | 'generic';

export interface BiometricSupport {
  /** Matériel présent ET une biométrie enrôlée — sinon le flux se dégrade sans bloquer. */
  available: boolean;
  method: BiometricMethod;
}

/** Libellé humain de la méthode — pour la copy ({method} dans les clés auth.bio*). */
export function biometricMethodLabel(method: BiometricMethod): string {
  switch (method) {
    case 'faceid':
      return 'Face ID';
    case 'touchid':
      return 'Touch ID';
    default:
      return 'la biométrie';
  }
}

export async function getBiometricSupport(): Promise<BiometricSupport> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  if (!hasHardware) return { available: false, method: 'generic' };
  const enrolled = await LocalAuthentication.isEnrolledAsync();
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  const method: BiometricMethod = types.includes(
    LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
  )
    ? 'faceid'
    : types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)
      ? 'touchid'
      : 'generic';
  return { available: enrolled, method };
}

/** null = l'utilisateur n'a jamais répondu à la proposition d'opt-in. */
export async function readBiometricOptIn(): Promise<boolean | null> {
  const raw = await SecureStore.getItemAsync(OPT_IN_KEY);
  return raw === 'yes' ? true : raw === 'no' ? false : null;
}

export async function writeBiometricOptIn(value: boolean): Promise<void> {
  await SecureStore.setItemAsync(OPT_IN_KEY, value ? 'yes' : 'no');
}

export interface BiometricAuthResult {
  ok: boolean;
  /** true = matériel/enrollment absent : on est passé SANS vérifier (jamais bloquant). */
  degraded: boolean;
}

export async function authenticateBiometric(promptMessage: string): Promise<BiometricAuthResult> {
  try {
    const support = await getBiometricSupport();
    if (!support.available) return { ok: false, degraded: true };
    const result = await LocalAuthentication.authenticateAsync({ promptMessage });
    return { ok: result.success, degraded: false };
  } catch {
    // Après opt-in, une panne native ne vaut jamais preuve d'identité.
    return { ok: false, degraded: true };
  }
}

/**
 * Drapeau mémoire « login interactif à l'instant » (jamais persisté) :
 * · posé par LoginScreen après un signIn/signUp réussi ;
 * · consommé par BiometricGate pour (1) ne pas re-verrouiller juste après un login
 *   au mot de passe et (2) proposer l'opt-in au bon moment (premier login réussi).
 */
let freshLogin = false;

export function markFreshLogin(): void {
  freshLogin = true;
}

export function consumeFreshLogin(): boolean {
  const value = freshLogin;
  freshLogin = false;
  return value;
}
