import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, processLock, type SupabaseClient } from '@supabase/supabase-js';

function requiredPublicEnv(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Configuration mobile incomplète : ${name} est requis.`);
  return normalized;
}

const url = requiredPublicEnv('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL);
const anon = requiredPublicEnv(
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
);

/** Le binaire n'a qu'un mode : authentification Supabase réelle, requise par le garde Expo. */
export const supabaseEnabled = true;

export const supabase: SupabaseClient = createClient(url, anon, {
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
});

/**
 * Source unique du jeton d'accès pour HttpBobClient : la session Supabase authentifiée.
 * Un utilisateur déconnecté rend `null`; aucun jeton statique partagé ne peut prendre le relais.
 */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
