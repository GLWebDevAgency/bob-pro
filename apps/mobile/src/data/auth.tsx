import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthError, Session } from '@supabase/supabase-js';
import { supabase, supabaseEnabled, getAccessToken } from './supabase';

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
  if (error.name === 'AuthRetryableFetchError' || /network|fetch/i.test(error.message)) return 'network';
  if (error.status === 429) return 'rate_limited';
  return 'unknown';
}

export interface SignUpInput {
  email: string;
  password: string;
  firstName: string;
  fullName: string;
  /**
   * Instantané entreprise du lookup SIRET (C24) — posé en user_metadata à l'inscription.
   * POST /onboarding/company exige une session (guard JWT) ET un tenant provisionné
   * (app_metadata.company_id) : impossible AVANT confirmation email. L'instantané garde
   * l'info côté compte ; le provisioning serveur la consommera (TODO serveur documenté).
   */
  company?: { siret: string; name: string } | undefined;
}

interface AuthValue {
  enabled: boolean;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: AuthErrorCode | null }>;
  /**
   * Inscription réelle Supabase — pose user_metadata.first_name/full_name (source useIdentity).
   * `needsConfirmation` = true si la confirmation email est active (pas de session immédiate).
   */
  signUp: (input: SignUpInput) => Promise<{ error: AuthErrorCode | null; needsConfirmation: boolean }>;
  /**
   * Reset réel (resetPasswordForEmail). Sans emailRedirectTo : aucun deep link/universal link
   * n'est configuré pour le flux recovery — le mail Supabase utilise le Site URL du projet.
   */
  resetPassword: (email: string) => Promise<{ error: AuthErrorCode | null }>;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(supabaseEnabled);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    const sb = supabase;
    let active = true;
    void sb.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // Anti-fuite inter-utilisateur : on vide le cache des données à la déconnexion.
      if (event === 'SIGNED_OUT') queryClient.clear();
    });
    // En RN, le refresh auto du token doit être piloté par l'état de l'app (requis par Supabase).
    if (AppState.currentState === 'active') sb.auth.startAutoRefresh();
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') sb.auth.startAutoRefresh();
      else sb.auth.stopAutoRefresh();
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
      appSub.remove();
    };
  }, [queryClient]);

  const value = useMemo<AuthValue>(
    () => ({
      enabled: supabaseEnabled,
      session,
      loading,
      signIn: async (email, password) => {
        if (!supabase) return { error: 'disabled' };
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error: mapAuthError(error) };
      },
      signUp: async ({ email, password, firstName, fullName, company }) => {
        if (!supabase) return { error: 'disabled', needsConfirmation: false };
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              first_name: firstName,
              full_name: fullName,
              ...(company ? { company_siret: company.siret, company_name: company.name } : {}),
            },
          },
        });
        const mapped = mapAuthError(error);
        if (mapped) return { error: mapped, needsConfirmation: false };
        // Confirmation email active → user créé SANS session ; sinon session immédiate.
        return { error: null, needsConfirmation: data.session === null };
      },
      resetPassword: async (email) => {
        if (!supabase) return { error: 'disabled' };
        const { error } = await supabase.auth.resetPasswordForEmail(email);
        return { error: mapAuthError(error) };
      },
      signOut: async () => {
        await supabase?.auth.signOut();
      },
      getToken: getAccessToken,
    }),
    [session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans un AuthProvider');
  return ctx;
}
