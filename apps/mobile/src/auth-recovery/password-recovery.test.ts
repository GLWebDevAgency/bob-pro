import { describe, expect, it } from 'vitest';
import {
  initialPasswordRecoveryState,
  isPasswordRecoveryUrl,
  parsePasswordRecoveryUrl,
  passwordRecoveryReducer,
  validateRecoveryPassword,
} from './password-recovery';

describe('parsePasswordRecoveryUrl', () => {
  it('accepte le deep-link implicite Supabase sans exposer de message provider', () => {
    expect(
      parsePasswordRecoveryUrl(
        'bobpro:///auth/recovery#access_token=access.jwt&refresh_token=refresh-token&type=recovery',
      ),
    ).toEqual({
      ok: true,
      proof: { kind: 'implicit', accessToken: 'access.jwt', refreshToken: 'refresh-token' },
    });
  });

  it('accepte le code PKCE sur la forme double-slash produite par Expo', () => {
    expect(parsePasswordRecoveryUrl('bobpro://auth/recovery?code=one-time-code')).toEqual({
      ok: true,
      proof: { kind: 'pkce', code: 'one-time-code' },
    });
    expect(isPasswordRecoveryUrl('bobpro://auth/recovery?code=one-time-code')).toBe(true);
  });

  it('rejette une route voisine, un autre type et les preuves ambiguës', () => {
    expect(parsePasswordRecoveryUrl('bobpro:///auth/callback?code=abc')).toEqual({
      ok: false,
      reason: 'not_recovery_route',
    });
    expect(parsePasswordRecoveryUrl('bobpro:///auth/recovery?code=abc&type=signup')).toEqual({
      ok: false,
      reason: 'invalid_link',
    });
    expect(
      parsePasswordRecoveryUrl(
        'bobpro:///auth/recovery?code=abc#access_token=a&refresh_token=b&type=recovery',
      ),
    ).toEqual({ ok: false, reason: 'invalid_link' });
    expect(parsePasswordRecoveryUrl('bobpro:///auth/recovery?code=first&code=second')).toEqual({
      ok: false,
      reason: 'invalid_link',
    });
    expect(parsePasswordRecoveryUrl('https://example.test/auth/recovery?code=abc')).toEqual({
      ok: false,
      reason: 'not_recovery_route',
    });
  });

  it('classe un lien expiré sans recopier error_description', () => {
    expect(
      parsePasswordRecoveryUrl(
        'bobpro:///auth/recovery?error=access_denied&error_code=otp_expired&error_description=secret',
      ),
    ).toEqual({ ok: false, reason: 'expired_link' });
  });
});

describe('validateRecoveryPassword', () => {
  it('valide la présence, la longueur, la borne et la confirmation', () => {
    expect(validateRecoveryPassword('', '')).toEqual({ ok: false, reason: 'required' });
    expect(validateRecoveryPassword('1234567', '1234567')).toEqual({
      ok: false,
      reason: 'too_short',
    });
    expect(validateRecoveryPassword('a'.repeat(257), 'a'.repeat(257))).toEqual({
      ok: false,
      reason: 'too_long',
    });
    expect(validateRecoveryPassword('correct horse', 'correct house')).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(validateRecoveryPassword('correct horse', 'correct horse')).toEqual({ ok: true });
  });
});

describe('passwordRecoveryReducer', () => {
  it('modélise un parcours nominal sans autoriser un succès hors mise à jour', () => {
    const establishing = passwordRecoveryReducer(initialPasswordRecoveryState, {
      type: 'link_started',
    });
    const ready = passwordRecoveryReducer(establishing, { type: 'session_ready' });
    expect(passwordRecoveryReducer(ready, { type: 'update_succeeded' })).toBe(ready);
    const updating = passwordRecoveryReducer(ready, { type: 'update_started' });
    expect(passwordRecoveryReducer(updating, { type: 'update_succeeded' })).toEqual({
      phase: 'success',
      error: null,
    });
  });

  it('refuse de lancer une mise à jour sans session de récupération prête', () => {
    const invalidLink = { phase: 'error', error: 'invalid_link' } as const;
    expect(passwordRecoveryReducer(invalidLink, { type: 'update_started' })).toBe(invalidLink);
    expect(passwordRecoveryReducer(initialPasswordRecoveryState, { type: 'update_started' })).toBe(
      initialPasswordRecoveryState,
    );
  });

  it('revient à ready après une erreur de mise à jour pour permettre un retry', () => {
    const updating = { phase: 'updating', error: null } as const;
    expect(passwordRecoveryReducer(updating, { type: 'update_failed', error: 'network' })).toEqual({
      phase: 'ready',
      error: 'network',
    });
    expect(
      passwordRecoveryReducer(updating, { type: 'update_failed', error: 'expired_link' }),
    ).toEqual({ phase: 'error', error: 'expired_link' });
  });
});
