import type { ConfigContext, ExpoConfig } from 'expo/config';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Build BDD-only refusé : ${name} est requis.`);
  return value;
}

function assertHttpUrl(name: string, raw: string, release: boolean): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Build BDD-only refusé : ${name} doit être une URL valide.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Build BDD-only refusé : ${name} doit utiliser HTTP ou HTTPS.`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  // Le domaine de démonstration est interdit UNIQUEMENT pour la soumission publique
  // (profil production) : les builds preview de QA interne peuvent porter les URLs
  // légales placeholder tant que le domaine définitif (Nico) n'héberge pas les pages.
  if (url.hostname === 'demo.bobpro.fr' && process.env.EAS_BUILD_PROFILE === 'production') {
    throw new Error(`Build BDD-only refusé : ${name} ne doit pas cibler le domaine de démonstration.`);
  }
  if (release && (url.protocol !== 'https:' || loopback)) {
    throw new Error(`Build BDD-only refusé : ${name} doit cibler une origine HTTPS non locale.`);
  }
}

function assertEmail(name: string, raw: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(raw)) {
    throw new Error(`Build BDD-only refusé : ${name} doit être une adresse email valide.`);
  }
}

/**
 * Garde de build BDD-only (contrat infra, cf. docs/store-readiness.md).
 *
 * Tous les builds, y compris le développement local, exigent API + Supabase. Les fixtures sont
 * réservées aux tests par injection et ne peuvent jamais être activées dans le binaire.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  if (process.env.EXPO_PUBLIC_DEMO_MODE !== undefined) {
    throw new Error('Build BDD-only refusé : EXPO_PUBLIC_DEMO_MODE est interdit dans le binaire.');
  }
  if (process.env.EXPO_PUBLIC_API_TOKEN) {
    throw new Error('Build BDD-only refusé : EXPO_PUBLIC_API_TOKEN ne doit jamais être embarqué.');
  }
  const apiUrl = required('EXPO_PUBLIC_API_URL');
  const supabaseUrl = required('EXPO_PUBLIC_SUPABASE_URL');
  required('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  const termsUrl = required('EXPO_PUBLIC_TERMS_URL');
  const privacyUrl = required('EXPO_PUBLIC_PRIVACY_URL');
  const supportEmail = required('EXPO_PUBLIC_SUPPORT_EMAIL');
  const release = process.env.EAS_BUILD_PROFILE !== undefined
    && process.env.EAS_BUILD_PROFILE !== 'development';
  assertHttpUrl('EXPO_PUBLIC_API_URL', apiUrl, release);
  assertHttpUrl('EXPO_PUBLIC_SUPABASE_URL', supabaseUrl, release);
  assertHttpUrl('EXPO_PUBLIC_TERMS_URL', termsUrl, release);
  assertHttpUrl('EXPO_PUBLIC_PRIVACY_URL', privacyUrl, release);
  assertEmail('EXPO_PUBLIC_SUPPORT_EMAIL', supportEmail);
  return config as ExpoConfig;
};
