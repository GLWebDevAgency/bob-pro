import { describe, expect, it } from 'vitest';
import {
  MobileDataConfigurationError,
  resolveMobileDataMode,
} from './mobile-data-mode';

const REMOTE = {
  demoMode: 'false',
  apiUrl: 'https://api.bob.example',
  supabaseUrl: 'https://tenant.supabase.co',
  supabaseAnonKey: 'public-anon-key',
} as const;

describe('resolveMobileDataMode', () => {
  it('choisit le backend distant seulement avec API et auth complètes', () => {
    expect(resolveMobileDataMode(REMOTE)).toEqual({
      kind: 'remote',
      apiUrl: 'https://api.bob.example',
    });
    expect(
      resolveMobileDataMode({
        ...REMOTE,
        apiUrl: 'http://127.0.0.1:3000',
        supabaseUrl: 'http://127.0.0.1:54321',
      }),
    ).toEqual({ kind: 'remote', apiUrl: 'http://127.0.0.1:3000' });
  });

  it.each([
    {},
    { demoMode: 'false' },
    { demoMode: 'false', apiUrl: REMOTE.apiUrl },
    { ...REMOTE, supabaseAnonKey: '' },
  ])('refuse une configuration absente ou partielle au lieu de charger les fixtures', (env) => {
    expect(() => resolveMobileDataMode(env)).toThrow(
      new MobileDataConfigurationError('remote_configuration_incomplete'),
    );
  });

  it.each([undefined, 'development', 'preview', 'production', 'internal', 'staging'])(
    'interdit toute fixture dans le runtime app (profil %s)',
    (easBuildProfile) => {
      expect(() => resolveMobileDataMode({ demoMode: 'true', easBuildProfile })).toThrow(
        new MobileDataConfigurationError('demo_forbidden'),
      );
    },
  );

  it('exige HTTPS hors profils de développement', () => {
    expect(() =>
      resolveMobileDataMode({
        ...REMOTE,
        apiUrl: 'http://127.0.0.1:3000',
        easBuildProfile: 'preview',
      }),
    ).toThrow(new MobileDataConfigurationError('insecure_release_url'));
    expect(() =>
      resolveMobileDataMode({
        ...REMOTE,
        supabaseUrl: 'http://tenant.supabase.local',
        easBuildProfile: 'production',
      }),
    ).toThrow(new MobileDataConfigurationError('insecure_release_url'));
  });

  it('refuse un jeton API statique dans toutes les apps utilisateur connectées', () => {
    expect(() => resolveMobileDataMode({ ...REMOTE, apiToken: 'shared-secret' })).toThrow(
      new MobileDataConfigurationError('static_token_forbidden'),
    );
  });

  it('refuse les valeurs de flag ambiguës', () => {
    expect(() => resolveMobileDataMode({ ...REMOTE, demoMode: 'yes' })).toThrow(
      new MobileDataConfigurationError('invalid_demo_flag'),
    );
  });
});
