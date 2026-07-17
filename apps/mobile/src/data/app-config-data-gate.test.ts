import { afterEach, describe, expect, it, vi } from 'vitest';
import resolveConfig from '../../app.config';

const context = { config: { name: 'Bob Pro', slug: 'bob-pro' } } as Parameters<
  typeof resolveConfig
>[0];

function liveLocalEnv(): void {
  vi.stubEnv('EXPO_PUBLIC_API_URL', 'http://127.0.0.1:3000');
  vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY', 'anon-test-key');
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

  it('exige HTTPS et interdit le loopback dans une build EAS distribuée', () => {
    liveLocalEnv();
    vi.stubEnv('EAS_BUILD_PROFILE', 'preview');
    expect(() => resolveConfig(context)).toThrow(/origine HTTPS non locale/u);

    vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://api.bob.example');
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'https://tenant.supabase.co');
    expect(resolveConfig(context)).toEqual(context.config);
  });
});
