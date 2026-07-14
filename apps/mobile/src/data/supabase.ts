import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, processLock, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/** Auth réelle activée seulement si l'URL + la clé anon Supabase sont fournies (sinon : démo hors-ligne). */
export const supabaseEnabled = Boolean(url && anon);

export const supabase: SupabaseClient | null = supabaseEnabled
  ? createClient(url as string, anon as string, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        // Le reset reçoit un code à usage unique plutôt que les jetons de session dans l'URL.
        // Le parseur recovery conserve le support implicite pour les emails déjà émis.
        flowType: 'pkce',
        // Recommandation officielle RN : sérialise refresh, échange PKCE et updateUser.
        lock: processLock,
      },
    })
  : null;

/**
 * Source unique du jeton d'accès pour HttpBobClient :
 * - session Supabase si configurée ;
 * - sinon jeton statique EXPO_PUBLIC_API_TOKEN (pratique en dev contre le backend démo) ;
 * - sinon null (mode démo hors-ligne).
 */
export async function getAccessToken(): Promise<string | null> {
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }
  return process.env.EXPO_PUBLIC_API_TOKEN ?? null;
}
