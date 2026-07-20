import { NextResponse, type NextRequest } from 'next/server';
import { CABINET_INVITATION_COOKIE } from '../../../../src/cabinet/invitation';

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ ok: false }, { status: 403 });
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const token = typeof payload === 'object' && payload !== null && 'token' in payload
    ? (payload as { token?: unknown }).token
    : null;
  if (typeof token !== 'string' || token.length < 20 || token.length > 1_024) {
    return NextResponse.json({ ok: false }, { status: 422 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(CABINET_INVITATION_COOKIE, token, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: '/auth/invitation',
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
