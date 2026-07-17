import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { createURL } from 'expo-linking';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthError, Session } from '@supabase/supabase-js';
import type { CompanyLookupResult } from '@bob/core';
import { supabase, supabaseEnabled, getAccessToken } from './supabase';
import { loadAuthBootstrapWithTimeout } from './auth-bootstrap';
import { AuthRequestTimeoutError, runAuthRequestWithTimeout } from '../auth-recovery/auth-request';
import { runBeforeSignOutCleanups } from './session-cleanup';
import {
  publishAuthSessionWithCacheFence,
  type AuthSessionCacheIdentity,
} from './auth-session-cache-policy';
import {
  initialPasswordRecoveryState,
  parsePasswordRecoveryUrl,
  passwordRecoveryReducer,
  PASSWORD_RECOVERY_ROUTE,
  PASSWORD_RECOVERY_SCHEME,
  type PasswordRecoveryErrorCode,
  type PasswordRecoveryState,
} from '../auth-recovery/password-recovery';

/**
 * Erreurs d'auth TYPÉES (C24) : la couche data traduit les erreurs Supabase (anglais,
 * formats variables) en codes stables — l'écran choisit la copy voix Bob (@bob/i18n).
 * Aucun message brut Supabase ne remonte à l'UI.
 */
export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'user_exists'
  | 'weak_password'
  | 'invalid_email'
  | 'rate_limited'
  | 'network'
  | 'disabled'
  | 'unknown';

function mapAuthError(error: AuthError | null): AuthErrorCode | null {
  if (!error) return null;
  // supabase-js v2 : `code` est posé par l'API GoTrue (AuthApiError) — source la plus fiable.
  const code = (error as { code?: string }).code;
  switch (code) {
    case 'invalid_credentials':
      return 'invalid_credentials';
    case 'email_not_confirmed':
      return 'email_not_confirmed';
    case 'user_already_exists':
    case 'email_exists':
      return 'user_exists';
    case 'weak_password':
      return 'weak_password';
    case 'validation_failed':
    case 'email_address_invalid':
      return 'invalid_email';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'rate_limited';
    default:
      break;
  }
  // Repli : erreurs réseau (fetch) n'ont pas de code API.
  if (error.name === 'AuthRetryableFetchError' || /network|fetch/i.test(error.message))
    return 'network';
  if (error.status === 429) return 'rate_limited';
  return 'unknown';
}

function mapThrownAuthError(error: unknown): AuthErrorCode {
  if (error instanceof AuthRequestTimeoutError) return 'network';
  if (error && typeof error === 'object' && 'message' in error && 'name' in error) {
    return mapAuthError(error as AuthError) ?? 'unknown';
  }
  return 'unknown';
}

function mapPasswordRecoveryError(error: AuthError | null): PasswordRecoveryErrorCode | null {
  if (!error) return null;
  const code = (error as { code?: string }).code;
  switch (code) {
    case 'otp_expired':
    case 'otp_disabled':
    case 'bad_jwt':
    case 'session_not_found':
      return 'expired_link';
    case 'weak_password':
      return 'weak_password';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'rate_limited';
    default:
      break;
  }
  if (error.status === 429) return 'rate_limited';
  if (error.name === 'AuthRetryableFetchError' || /network|fetch/i.test(error.message)) {
    return 'network';
  }
  return 'unknown';
}

function mapThrownPasswordRecoveryError(error: unknown): PasswordRecoveryErrorCode {
  if (error instanceof AuthRequestTimeoutError) return 'network';
  if (error && typeof error === 'object' && 'message' in error && 'name' in error) {
    return mapPasswordRecoveryError(error as AuthError) ?? 'unknown';
  }
  return 'unknown';
}

export interface SignUpInput {
  email: string;
  password: string;
  firstName: string;
  fullName: string;
  /**
   * Fiche entreprise COMPLÈTE du lookup SIRET (C24b) — posée en user_metadata à l'inscription
   * (snapshot JSON ~400 octets : très en deçà de toute limite du raw_user_meta_data jsonb).
   * POST /onboarding/company exige une session (guard JWT) : impossible AVANT confirmation
   * email. Le ProvisioningScreen relit ce snapshot après le premier login et l'envoie tel quel
   * à registerCompany — TOUTES les infos officielles (dénomination, NAF, forme juridique,
   * adresse, TVA, date de création) finissent en base.
   */
  company?: CompanyLookupResult | undefined;
}

interface AuthValue {
  enabled: boolean;
  session: Session | null;
  loading: boolean;
  initializationError: boolean;
  retryInitialization: () => void;
  signIn: (email: string, password: string) => Promise<{ error: AuthErrorCode | null }>;
  /**
   * Inscription réelle Supabase — pose user_metadata.first_name/full_name (source useIdentity).
   * `needsConfirmation` = true si la confirmation email est active (pas de session immédiate).
   */
  signUp: (
    input: SignUpInput,
  ) => Promise<{ error: AuthErrorCode | null; needsConfirmation: boolean }>;
  /**
   * Reset réel : le lien revient sur la route native dédiée et sa preuve est consommée une fois.
   */
  resetPassword: (email: string) => Promise<{ error: AuthErrorCode | null }>;
  resendSignupConfirmation: (email: string) => Promise<{ error: AuthErrorCode | null }>;
  passwordRecovery: PasswordRecoveryState;
  beginPasswordRecovery: (url: string) => Promise<void>;
  updateRecoveredPassword: (
    password: string,
  ) => Promise<{ error: PasswordRecoveryErrorCode | null }>;
  finishPasswordRecovery: () => void;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthValue | null>(null);
const AUTH_BOOTSTRAP_TIMEOUT_MS = 8_000;
const AUTH_REQUEST_TIMEOUT_MS = 12_000;
const PASSWORD_RECOVERY_REDIRECT_URL = createURL(PASSWORD_RECOVERY_ROUTE.slice(1), {
  scheme: PASSWORD_RECOVERY_SCHEME,
  isTripleSlashed: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(supabaseEnabled);
  const [initializationError, setInitializationError] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [passwordRecovery, dispatchPasswordRecovery] = useReducer(
    passwordRecoveryReducer,
    initialPasswordRecoveryState,
  );
  // A session event can legitimately win the race against getSession() (deep link, refresh,
  // sign-in). The revision fences the late bootstrap result so it cannot overwrite fresher auth.
  const authRevision = useRef(0);
  const passwordRecoveryAttempt = useRef(0);
  // Capabilité locale distincte d'une session Supabase ordinaire : updateUser(password) ne doit
  // être exposé par ce flux qu'après consommation réussie d'une preuve de récupération.
  const passwordRecoveryAuthorized = useRef(false);
  const passwordRecoveryExchangeExpected = useRef(false);
  const queryClient = useQueryClient();
  const publishedCacheIdentity = useRef<AuthSessionCacheIdentity | null>(null);
  const publishSession = useCallback(
    (nextSession: Session | null): void => {
      publishedCacheIdentity.current = publishAuthSessionWithCacheFence({
        previousIdentity: publishedCacheIdentity.current,
        nextSession,
        clearCache: () => queryClient.clear(),
        publishSession: setSession,
      });
    },
    [queryClient],
  );
  const retryInitialization = useCallback(() => setBootstrapAttempt((attempt) => attempt + 1), []);

  const beginPasswordRecovery = useCallback(async (url: string): Promise<void> => {
    const parsed = parsePasswordRecoveryUrl(url);
    const attempt = ++passwordRecoveryAttempt.current;
    passwordRecoveryAuthorized.current = false;
    passwordRecoveryExchangeExpected.current = false;
    if (!parsed.ok) {
      dispatchPasswordRecovery({
        type: 'link_failed',
        error: parsed.reason === 'expired_link' ? 'expired_link' : 'invalid_link',
      });
      return;
    }
    const sb = supabase;
    if (!sb) {
      dispatchPasswordRecovery({ type: 'link_failed', error: 'not_ready' });
      return;
    }

    passwordRecoveryExchangeExpected.current = true;
    dispatchPasswordRecovery({ type: 'link_started' });
    try {
      const proof = parsed.proof;
      const { data, error } = await runAuthRequestWithTimeout(
        () =>
          proof.kind === 'pkce'
            ? sb.auth.exchangeCodeForSession(proof.code)
            : sb.auth.setSession({
                access_token: proof.accessToken,
                refresh_token: proof.refreshToken,
              }),
        AUTH_REQUEST_TIMEOUT_MS,
      );
      if (attempt !== passwordRecoveryAttempt.current) return;
      passwordRecoveryExchangeExpected.current = false;
      const mapped = mapPasswordRecoveryError(error);
      if (mapped || !data.session) {
        dispatchPasswordRecovery({
          type: 'link_failed',
          error: mapped ?? 'invalid_link',
        });
        return;
      }
      publishSession(data.session);
      passwordRecoveryAuthorized.current = true;
      dispatchPasswordRecovery({ type: 'session_ready' });
    } catch (error: unknown) {
      if (attempt !== passwordRecoveryAttempt.current) return;
      passwordRecoveryExchangeExpected.current = false;
      dispatchPasswordRecovery({
        type: 'link_failed',
        error: mapThrownPasswordRecoveryError(error),
      });
    }
  }, [publishSession]);

  const updateRecoveredPassword = useCallback(
    async (password: string): Promise<{ error: PasswordRecoveryErrorCode | null }> => {
      const sb = supabase;
      if (!sb || !passwordRecoveryAuthorized.current) {
        dispatchPasswordRecovery({ type: 'link_failed', error: 'not_ready' });
        return { error: 'not_ready' };
      }
      dispatchPasswordRecovery({ type: 'update_started' });
      try {
        const { error } = await runAuthRequestWithTimeout(
          () => sb.auth.updateUser({ password }),
          AUTH_REQUEST_TIMEOUT_MS,
        );
        const mapped = mapPasswordRecoveryError(error);
        if (mapped) {
          if (mapped === 'expired_link' || mapped === 'invalid_link' || mapped === 'not_ready') {
            passwordRecoveryAuthorized.current = false;
          }
          dispatchPasswordRecovery({ type: 'update_failed', error: mapped });
          return { error: mapped };
        }
        passwordRecoveryAuthorized.current = false;
        dispatchPasswordRecovery({ type: 'update_succeeded' });
        return { error: null };
      } catch (error: unknown) {
        const mapped = mapThrownPasswordRecoveryError(error);
        if (mapped === 'expired_link' || mapped === 'invalid_link' || mapped === 'not_ready') {
          passwordRecoveryAuthorized.current = false;
        }
        dispatchPasswordRecovery({ type: 'update_failed', error: mapped });
        return { error: mapped };
      }
    },
    [],
  );

  const finishPasswordRecovery = useCallback((): void => {
    passwordRecoveryAttempt.current += 1;
    passwordRecoveryAuthorized.current = false;
    passwordRecoveryExchangeExpected.current = false;
    dispatchPasswordRecovery({ type: 'reset' });
  }, []);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      setInitializationError(false);
      return;
    }
    const sb = supabase;
    const bootstrapRevision = ++authRevision.current;
    let active = true;
    setLoading(true);
    setInitializationError(false);
    void loadAuthBootstrapWithTimeout(() => sb.auth.getSession(), AUTH_BOOTSTRAP_TIMEOUT_MS)
      .then(({ data, error }) => {
        if (!active || authRevision.current !== bootstrapRevision) return;
        if (error) {
          setInitializationError(true);
        } else {
          publishSession(data.session);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!active || authRevision.current !== bootstrapRevision) return;
        setInitializationError(true);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bootstrapAttempt, publishSession]);

  useEffect(() => {
    if (!supabase) return;
    const sb = supabase;
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      authRevision.current += 1;
      publishSession(s);
      setInitializationError(false);
      setLoading(false);
      if (event === 'PASSWORD_RECOVERY' && s && passwordRecoveryExchangeExpected.current) {
        passwordRecoveryAuthorized.current = true;
        dispatchPasswordRecovery({ type: 'session_ready' });
      }
      // Anti-fuite inter-utilisateur : on vide le cache des données à la déconnexion.
      if (event === 'SIGNED_OUT') {
        passwordRecoveryAuthorized.current = false;
        passwordRecoveryExchangeExpected.current = false;
        dispatchPasswordRecovery({ type: 'reset' });
      }
    });
    // En RN, le refresh auto du token doit être piloté par l'état de l'app (requis par Supabase).
    if (AppState.currentState === 'active') sb.auth.startAutoRefresh();
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') sb.auth.startAutoRefresh();
      else sb.auth.stopAutoRefresh();
    });
    return () => {
      sub.subscription.unsubscribe();
      appSub.remove();
    };
  }, [publishSession]);

  const value = useMemo<AuthValue>(
    () => ({
      enabled: supabaseEnabled,
      session,
      loading,
      initializationError,
      retryInitialization,
      signIn: async (email, password) => {
        const sb = supabase;
        if (!sb) return { error: 'disabled' };
        try {
          const { error } = await runAuthRequestWithTimeout(
            () => sb.auth.signInWithPassword({ email, password }),
            AUTH_REQUEST_TIMEOUT_MS,
          );
          return { error: mapAuthError(error) };
        } catch (error: unknown) {
          return { error: mapThrownAuthError(error) };
        }
      },
      signUp: async ({ email, password, firstName, fullName, company }) => {
        const sb = supabase;
        if (!sb) return { error: 'disabled', needsConfirmation: false };
        try {
          const { data, error } = await runAuthRequestWithTimeout(
            () =>
              sb.auth.signUp({
                email,
                password,
                options: {
                  data: {
                    first_name: firstName,
                    full_name: fullName,
                    // siret/name à plat (lisibles dans le dashboard) + snapshot complet pour le provisioning.
                    ...(company
                      ? {
                          company_siret: company.siret,
                          company_name: company.denomination,
                          company_snapshot: company,
                        }
                      : {}),
                  },
                },
              }),
            AUTH_REQUEST_TIMEOUT_MS,
          );
          const mapped = mapAuthError(error);
          if (mapped) return { error: mapped, needsConfirmation: false };
          // Confirmation email active → user créé SANS session ; sinon session immédiate.
          return { error: null, needsConfirmation: data.session === null };
        } catch (error: unknown) {
          return { error: mapThrownAuthError(error), needsConfirmation: false };
        }
      },
      resetPassword: async (email) => {
        const sb = supabase;
        if (!sb) return { error: 'disabled' };
        try {
          const { error } = await runAuthRequestWithTimeout(
            () =>
              sb.auth.resetPasswordForEmail(email, {
                redirectTo: PASSWORD_RECOVERY_REDIRECT_URL,
              }),
            AUTH_REQUEST_TIMEOUT_MS,
          );
          return { error: mapAuthError(error) };
        } catch (error: unknown) {
          return { error: mapThrownAuthError(error) };
        }
      },
      resendSignupConfirmation: async (email) => {
        const sb = supabase;
        if (!sb) return { error: 'disabled' };
        try {
          const { error } = await runAuthRequestWithTimeout(
            () =>
              sb.auth.resend({
                type: 'signup',
                email,
              }),
            AUTH_REQUEST_TIMEOUT_MS,
          );
          return { error: mapAuthError(error) };
        } catch (error: unknown) {
          return { error: mapThrownAuthError(error) };
        }
      },
      passwordRecovery,
      beginPasswordRecovery,
      updateRecoveredPassword,
      finishPasswordRecovery,
      signOut: async () => {
        // Les adapters qui ont besoin du JWT courant (notamment la révocation push) passent avant
        // Supabase signOut. Best-effort et borné : un réseau en panne ne bloque jamais la sortie.
        await runBeforeSignOutCleanups();
        // La gouvernance de pression est PAR COMPTE : les compteurs de sourdine ne suivent
        // jamais un autre utilisateur sur le même appareil (review 14/07, P2).
        try {
          const keys = await AsyncStorage.getAllKeys();
          const pressure = keys.filter((key) => key.startsWith('bob.paywall.pressure.'));
          if (pressure.length > 0) await AsyncStorage.multiRemove(pressure);
        } catch {
          // la purge ne bloque jamais une déconnexion
        }
        await supabase?.auth.signOut();
      },
      getToken: getAccessToken,
    }),
    [
      session,
      loading,
      initializationError,
      retryInitialization,
      passwordRecovery,
      beginPasswordRecovery,
      updateRecoveredPassword,
      finishPasswordRecovery,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans un AuthProvider');
  return ctx;
}
