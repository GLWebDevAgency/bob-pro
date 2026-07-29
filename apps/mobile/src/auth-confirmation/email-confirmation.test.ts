import { describe, expect, it } from 'vitest';
import {
  EMAIL_CONFIRMATION_DEEP_LINK,
  emailConfirmationWebRelayUrl,
  isEmailConfirmationUrl,
  parseEmailConfirmationUrl,
} from './email-confirmation';

describe('parseEmailConfirmationUrl', () => {
  it('publie la cible double-slash canonique acceptée par Supabase', () => {
    expect(EMAIL_CONFIRMATION_DEEP_LINK).toBe('bobpro://auth/callback');
  });

  it('accepte le code PKCE (forme triple-slash et forme double-slash Expo)', () => {
    expect(parseEmailConfirmationUrl('bobpro:///auth/callback?code=one-time-code')).toEqual({
      ok: true,
      proof: { kind: 'pkce', code: 'one-time-code' },
    });
    expect(parseEmailConfirmationUrl('bobpro://auth/callback?code=one-time-code')).toEqual({
      ok: true,
      proof: { kind: 'pkce', code: 'one-time-code' },
    });
    expect(isEmailConfirmationUrl('bobpro://auth/callback?code=one-time-code')).toBe(true);
  });

  it('accepte le retour implicite signup sans exposer de message provider', () => {
    expect(
      parseEmailConfirmationUrl(
        'bobpro:///auth/callback#access_token=access.jwt&refresh_token=refresh-token&type=signup',
      ),
    ).toEqual({
      ok: true,
      proof: { kind: 'implicit', accessToken: 'access.jwt', refreshToken: 'refresh-token' },
    });
  });

  it('traite un retour vérifié SANS preuve comme « confirmé, connexion manuelle »', () => {
    expect(parseEmailConfirmationUrl('bobpro:///auth/callback')).toEqual({
      ok: true,
      proof: null,
    });
    expect(parseEmailConfirmationUrl('bobpro:///auth/callback?type=signup')).toEqual({
      ok: true,
      proof: null,
    });
  });

  it('rejette une route voisine, un autre type et les preuves ambiguës', () => {
    expect(parseEmailConfirmationUrl('bobpro:///auth/recovery?code=abc')).toEqual({
      ok: false,
      reason: 'not_confirmation_route',
    });
    expect(parseEmailConfirmationUrl('bobpro:///auth/callback?code=abc&type=recovery')).toEqual({
      ok: false,
      reason: 'invalid_link',
    });
    expect(
      parseEmailConfirmationUrl(
        'bobpro:///auth/callback?code=abc#access_token=a&refresh_token=b&type=signup',
      ),
    ).toEqual({ ok: false, reason: 'invalid_link' });
    expect(parseEmailConfirmationUrl('bobpro:///auth/callback?code=first&code=second')).toEqual({
      ok: false,
      reason: 'invalid_link',
    });
    expect(
      parseEmailConfirmationUrl('bobpro:///auth/callback#access_token=a&type=signup'),
    ).toEqual({ ok: false, reason: 'invalid_link' });
    expect(parseEmailConfirmationUrl('https://example.test/auth/callback?code=abc')).toEqual({
      ok: false,
      reason: 'not_confirmation_route',
    });
  });

  it('classe un lien expiré sans recopier error_description', () => {
    expect(
      parseEmailConfirmationUrl(
        'bobpro:///auth/callback?error=access_denied&error_code=otp_expired&error_description=secret',
      ),
    ).toEqual({ ok: false, reason: 'expired_link' });
  });
});

describe('emailConfirmationWebRelayUrl', () => {
  it('absente → null (repli deep link) ; valide → URL canonique conservée', () => {
    expect(emailConfirmationWebRelayUrl(undefined)).toBeNull();
    expect(emailConfirmationWebRelayUrl('   ')).toBeNull();
    expect(
      emailConfirmationWebRelayUrl('https://bob-pro-sign-web.vercel.app/auth/confirme'),
    ).toBe('https://bob-pro-sign-web.vercel.app/auth/confirme');
  });

  it('refuse http, localhost, démo, credentials, query et fragment — jamais de repli silencieux', () => {
    for (const invalid of [
      'http://bob-pro-sign-web.vercel.app/auth/confirme',
      'https://localhost/auth/confirme',
      'https://127.0.0.1/auth/confirme',
      'https://demo.bobpro.fr/auth/confirme',
      'https://user:pass@bob-pro-sign-web.vercel.app/auth/confirme',
      'https://bob-pro-sign-web.vercel.app/auth/confirme?next=x',
      'https://bob-pro-sign-web.vercel.app/auth/confirme#frag',
      'pas-une-url',
    ]) {
      expect(() => emailConfirmationWebRelayUrl(invalid)).toThrow();
    }
  });
});
