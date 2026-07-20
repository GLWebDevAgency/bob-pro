import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { CABINET_INVITATION_COOKIE } from '../../../../src/cabinet/invitation';

function clearInvitation(response: NextResponse) {
  response.cookies.set(CABINET_INVITATION_COOKIE, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/auth/invitation',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function serverConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const apiValue = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!supabaseUrl || !anonKey || !apiValue) return null;
  try {
    const api = new URL(apiValue);
    if (api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname))) return null;
    return { supabaseUrl, anonKey, apiUrl: api.toString().replace(/\/$/, '') };
  } catch {
    return null;
  }
}

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === request.nextUrl.origin;
}

function errorCode(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.code === 'string') return record.code;
  return errorCode(record.error);
}

async function upstreamErrorCode(response: Response): Promise<string | null> {
  try {
    return errorCode(await response.json());
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ accepted: false }, { status: 403 });
  const rawToken = request.cookies.get(CABINET_INVITATION_COOKIE)?.value;
  if (!rawToken) return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

  const config = serverConfig();
  if (config === null) return NextResponse.json({ accepted: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  const supabase = createServerClient(config.supabaseUrl, config.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      // Le proxy Next rafraîchit la session avant cette route. Cette lecture n'émet pas de session.
      setAll: () => undefined,
    },
  });
  const { error: userError } = await supabase.auth.getUser();
  const { data, error: sessionError } = await supabase.auth.getSession();
  if (userError || sessionError || data.session === null) {
    return NextResponse.json({ accepted: false }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  const upstream = await fetch(`${config.apiUrl}/cabinet/v1/invitations/accept`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token: rawToken }),
  });
  if (!upstream.ok) {
    const code = await upstreamErrorCode(upstream);
    const retryable = code === 'CABINET_FEATURE_DISABLED'
      || upstream.status >= 500
      || upstream.status === 401
      || upstream.status === 403
      || upstream.status === 429;
    const failure = NextResponse.json({ accepted: false }, { status: upstream.status, headers: { 'Cache-Control': 'no-store' } });
    return retryable ? failure : clearInvitation(failure);
  }
  return clearInvitation(NextResponse.json({ accepted: true }));
}
