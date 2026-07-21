import { describe, expect, it } from 'vitest';
import { extractHttpsLinks, invitationTokenFromLink, isSupabaseMagicLink } from './links';

describe('Cabinet staging email links', () => {
  it('extracts structured and text HTTPS links without accepting another scheme', () => {
    const links = extractHttpsLinks({
      html: { links: [{ href: 'https://cabinet.test/cabinet#invitation=secret' }, { href: 'javascript:alert(1)' }] },
      text: { body: 'Open https://auth.test/auth/v1/verify?token=x now.' },
    });

    expect(links.map((link) => link.protocol)).toEqual(['https:', 'https:']);
  });

  it('accepts only a same-origin Cabinet invitation fragment', () => {
    const token = 'a'.repeat(32);
    expect(invitationTokenFromLink(new URL(`https://cabinet.test/cabinet#invitation=${token}`), 'https://cabinet.test')).toBe(token);
    expect(invitationTokenFromLink(new URL(`https://evil.test/cabinet#invitation=${token}`), 'https://cabinet.test')).toBeNull();
  });

  it('accepts only a Supabase verify link redirecting to the Cabinet callback', () => {
    const good = new URL('https://auth.test/auth/v1/verify?redirect_to=https%3A%2F%2Fcabinet.test%2Fauth%2Fcallback%3Fnext%3D%2Fcabinet');
    const bad = new URL('https://auth.test/auth/v1/verify?redirect_to=https%3A%2F%2Fevil.test%2Fauth%2Fcallback');
    expect(isSupabaseMagicLink(good, 'https://auth.test', 'https://cabinet.test')).toBe(true);
    expect(isSupabaseMagicLink(bad, 'https://auth.test', 'https://cabinet.test')).toBe(false);
  });
});
