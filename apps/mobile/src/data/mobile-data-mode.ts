export type MobileDataMode = { readonly kind: 'remote'; readonly apiUrl: string };

export type MobileDataConfigurationErrorCode =
  | 'invalid_demo_flag'
  | 'demo_forbidden'
  | 'remote_configuration_incomplete'
  | 'insecure_release_url'
  | 'static_token_forbidden';

export class MobileDataConfigurationError extends Error {
  constructor(readonly code: MobileDataConfigurationErrorCode) {
    super(`mobile_data_${code}`);
    this.name = 'MobileDataConfigurationError';
  }
}

export interface MobileDataEnvironment {
  readonly demoMode?: string;
  readonly apiUrl?: string;
  readonly supabaseUrl?: string;
  readonly supabaseAnonKey?: string;
  readonly apiToken?: string;
  readonly easBuildProfile?: string;
}

const LOCAL_ONLY_PROFILES = new Set(['development']);

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function isReleaseProfile(profile: string | undefined): boolean {
  return profile !== undefined && !LOCAL_ONLY_PROFILES.has(profile);
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function assertRemoteUrl(raw: string, release: boolean): void {
  const url = parseUrl(raw);
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new MobileDataConfigurationError('remote_configuration_incomplete');
  }
  if (release && (url.protocol !== 'https:' || isLoopback(url.hostname))) {
    throw new MobileDataConfigurationError('insecure_release_url');
  }
  if (url.hostname === 'demo.bobpro.fr') {
    throw new MobileDataConfigurationError('demo_forbidden');
  }
}

/**
 * Autorité unique du mode data mobile.
 *
 * Le runtime de l'application principale est exclusivement branché sur l'API et l'auth réelles.
 * Les doubles de données restent injectables dans les tests, mais aucun flag d'environnement ne
 * peut transformer un binaire Bob en application à fixtures.
 */
export function resolveMobileDataMode(env: MobileDataEnvironment): MobileDataMode {
  if (env.demoMode !== undefined && env.demoMode !== 'true' && env.demoMode !== 'false') {
    throw new MobileDataConfigurationError('invalid_demo_flag');
  }
  if (env.demoMode === 'true') {
    throw new MobileDataConfigurationError('demo_forbidden');
  }

  const release = isReleaseProfile(env.easBuildProfile);
  if (present(env.apiToken)) {
    // Une app utilisateur ne doit jamais embarquer une identité statique partagée, même en preview.
    throw new MobileDataConfigurationError('static_token_forbidden');
  }
  if (!present(env.apiUrl) || !present(env.supabaseUrl) || !present(env.supabaseAnonKey)) {
    throw new MobileDataConfigurationError('remote_configuration_incomplete');
  }
  const apiUrl = env.apiUrl!.trim();
  assertRemoteUrl(apiUrl, release);
  assertRemoteUrl(env.supabaseUrl!.trim(), release);
  return { kind: 'remote', apiUrl };
}

export function mobileDataEnvironmentFromProcess(): MobileDataEnvironment {
  return {
    ...(process.env.EXPO_PUBLIC_DEMO_MODE === undefined
      ? {}
      : { demoMode: process.env.EXPO_PUBLIC_DEMO_MODE }),
    ...(process.env.EXPO_PUBLIC_API_URL === undefined
      ? {}
      : { apiUrl: process.env.EXPO_PUBLIC_API_URL }),
    ...(process.env.EXPO_PUBLIC_SUPABASE_URL === undefined
      ? {}
      : { supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL }),
    ...(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY === undefined
      ? {}
      : { supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY }),
    ...(process.env.EXPO_PUBLIC_API_TOKEN === undefined
      ? {}
      : { apiToken: process.env.EXPO_PUBLIC_API_TOKEN }),
    ...(process.env.EAS_BUILD_PROFILE === undefined
      ? {}
      : { easBuildProfile: process.env.EAS_BUILD_PROFILE }),
  };
}
