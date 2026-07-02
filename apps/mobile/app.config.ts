import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Garde de release store (contrat infra, cf. docs/store-readiness.md) :
 * sans EXPO_PUBLIC_API_URL, l'app démarre en LocalBobClient (fixtures démo) — une build
 * de production l'embarquerait silencieusement. On refuse donc de builder.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  if (process.env.EAS_BUILD_PROFILE === 'production') {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? '';
    const isRealHttps =
      apiUrl.startsWith('https://') && !apiUrl.includes('localhost') && !apiUrl.includes('127.0.0.1');
    if (!isRealHttps) {
      throw new Error(
        "Build production refusée : EXPO_PUBLIC_API_URL doit pointer l'API HTTPS déployée, sinon la build store embarque le client démo hors-ligne.",
      );
    }
    if (process.env.EXPO_PUBLIC_API_TOKEN) {
      throw new Error(
        'Build production refusée : EXPO_PUBLIC_API_TOKEN (jeton statique de dev) ne doit jamais être embarqué dans une build store.',
      );
    }
    if (!process.env.EXPO_PUBLIC_SUPABASE_URL || !process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY) {
      throw new Error(
        "Build production refusée : EXPO_PUBLIC_SUPABASE_URL et EXPO_PUBLIC_SUPABASE_ANON_KEY sont requis pour l'auth réelle.",
      );
    }
  }
  return config as ExpoConfig;
};
