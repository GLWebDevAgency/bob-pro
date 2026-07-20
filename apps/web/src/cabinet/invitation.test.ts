import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as stash } from '../../app/auth/invitation/stash/route';
import { acceptStashedInvitation, invitationFromFragment, stashInvitation } from './invitation';

afterEach(() => vi.unstubAllGlobals());

describe('invitation cabinet web', () => {
  it('extrait uniquement un jeton borné depuis le fragment', () => {
    expect(invitationFromFragment('#invitation=12345678901234567890')).toBe('12345678901234567890');
    expect(invitationFromFragment('#invitation=court')).toBeNull();
    expect(invitationFromFragment('#autre=12345678901234567890')).toBeNull();
  });

  it('transfère le secret par POST same-origin vers un cookie HttpOnly court', async () => {
    const request = new NextRequest('https://cabinet.bob.test/auth/invitation/stash', {
      method: 'POST',
      headers: { Origin: 'https://cabinet.bob.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '12345678901234567890' }),
    });
    const response = await stash(request);

    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('bob_cabinet_invitation=12345678901234567890');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=lax');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Path=/auth/invitation');
    expect(cookie).toContain('Secure');
  });

  it('refuse de stasher un secret cross-origin', async () => {
    const response = await stash(new NextRequest('https://cabinet.bob.test/auth/invitation/stash', {
      method: 'POST',
      headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '12345678901234567890' }),
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('n’insère jamais le jeton dans l’URL des appels navigateur', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(stashInvitation('invitation-secret-value')).resolves.toBe(true);
    await expect(acceptStashedInvitation()).resolves.toBe('accepted');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/auth/invitation/stash',
      '/auth/invitation/accept',
    ]);
  });
});
