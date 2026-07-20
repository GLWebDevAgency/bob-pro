import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
  getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'verified-access-token' } }, error: null }),
}));

vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth }) }));

import { POST } from '../../app/auth/invitation/accept/route';

function request(origin = 'https://cabinet.bob.test', withCookie = true): NextRequest {
  return new NextRequest('https://cabinet.bob.test/auth/invitation/accept', {
    method: 'POST',
    headers: {
      Origin: origin,
      ...(withCookie ? { Cookie: 'bob_cabinet_invitation=invitation-secret-value' } : {}),
    },
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-public-key');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.bob.test');
  auth.getUser.mockClear();
  auth.getSession.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('BFF acceptation invitation', () => {
  it('refuse le POST cross-origin avant de lire le secret', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(request('https://evil.test'));
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retourne 204 quand aucun cookie temporaire n’est présent', async () => {
    const response = await POST(request('https://cabinet.bob.test', false));
    expect(response.status).toBe(204);
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it('transmet le secret en body avec le Bearer vérifié puis efface le cookie au succès', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('https://api.bob.test/cabinet/v1/invitations/accept', expect.objectContaining({
      body: JSON.stringify({ token: 'invitation-secret-value' }),
      headers: expect.objectContaining({ Authorization: 'Bearer verified-access-token' }),
    }));
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('set-cookie')).toContain('Path=/auth/invitation');
  });

  it('efface le cookie sur erreur métier terminale', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 422 })));
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('conserve le cookie sur panne temporaire pour permettre un retry dans le TTL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('conserve le cookie si le kill-switch cabinet rend le 404 temporaire', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'CABINET_FEATURE_DISABLED' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )));
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('efface le cookie sur un 404 invitation invalide réellement terminal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'CABINET_INVITATION_INVALID' } }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )));
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
