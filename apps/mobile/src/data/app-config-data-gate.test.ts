import { afterEach, describe, expect, it, vi } from 'vitest';
import resolveConfig from '../../app.config';

const context = { config: { name: 'Bob Pro', slug: 'bob-pro' } } as Parameters<
  typeof resolveConfig
>[0];

function liveLocalEnv(): void {
  vi.stubEnv('EXPO_PUBLIC_API_URL', 'http://127.0.0.1:3000');
  vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY', 'anon-test-key');
  vi.stubEnv('EXPO_PUBLIC_TERMS_URL', 'http://127.0.0.1:3001/legal/cgu');
  vi.stubEnv('EXPO_PUBLIC_PRIVACY_URL', 'http://127.0.0.1:3001/legal/confidentialite');
  vi.stubEnv('EXPO_PUBLIC_SUPPORT_EMAIL', 'support@bob.example');
  vi.stubEnv('EXPO_PUBLIC_DEMO_MODE', undefined);
  vi.stubEnv('EXPO_PUBLIC_API_TOKEN', undefined);
  vi.stubEnv('EAS_BUILD_PROFILE', undefined);
}

describe('app.config BDD-only gate', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepte le développement contre une vraie API/auth locales', () => {
    liveLocalEnv();
    expect(resolveConfig(context)).toEqual(context.config);
  });

  it('refuse tout mode démo et tout jeton statique embarqué', () => {
    liveLocalEnv();
    vi.stubEnv('EXPO_PUBLIC_DEMO_MODE', 'true');
    expect(() => resolveConfig(context)).toThrow(/EXPO_PUBLIC_DEMO_MODE/u);

    vi.stubEnv('EXPO_PUBLIC_DEMO_MODE', undefined);
    vi.stubEnv('EXPO_PUBLIC_API_TOKEN', 'shared-secret');
    expect(() => resolveConfig(context)).toThrow(/EXPO_PUBLIC_API_TOKEN/u);
  });

  it('refuse une composition distante incomplète', () => {
    liveLocalEnv();
    vi.stubEnv('EXPO_PUBLIC_API_URL', '');
    expect(() => resolveConfig(context)).toThrow(/EXPO_PUBLIC_API_URL est requis/u);
  });

  it('refuse les coordonnées légales absentes, fictives ou invalides', () => {
    liveLocalEnv();
    vi.stubEnv('EXPO_PUBLIC_TERMS_URL', '');
    expect(() => resolveConfig(context)).toThrow(/EXPO_PUBLIC_TERMS_URL est requis/u);

    liveLocalEnv();
    vi.stubEnv('EXPO_PUBLIC_PRIVACY_URL', 'https://demo.bobpro.fr/legal/confidentialite');
    expect(() => resolveConfig(context)).toThrow(/domaine de démonstration/u);

    liveLocalEnv();
    vi.stubEnv('EXPO_PUBLIC_SUPPORT_EMAIL', 'pas-un-email');
    expect(() => resolveConfig(context)).toThrow(/adresse email valide/u);
  });

  it('exige HTTPS et interdit le loopback dans une build EAS distribuée', () => {
    liveLocalEnv();
    vi.stubEnv('EAS_BUILD_PROFILE', 'preview');
    expect(() => resolveConfig(context)).toThrow(/origine HTTPS non locale/u);

    vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://api.bob.example');
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'https://tenant.supabase.co');
    vi.stubEnv('EXPO_PUBLIC_TERMS_URL', 'https://bob.example/legal/cgu');
    vi.stubEnv('EXPO_PUBLIC_PRIVACY_URL', 'https://bob.example/legal/confidentialite');
    expect(resolveConfig(context)).toEqual(context.config);
  });
});
