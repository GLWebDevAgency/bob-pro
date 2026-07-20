import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getSupabasePublicConfig } from '../../../src/cabinet/supabase';

function safeDestination(request: NextRequest): URL {
  const fallback = new URL('/cabinet', request.nextUrl.origin);
  const value = request.nextUrl.searchParams.get('next');
  if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  try {
    const destination = new URL(value, request.nextUrl.origin);
    return destination.origin === request.nextUrl.origin ? destination : fallback;
  } catch {
    return fallback;
  }
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const destination = safeDestination(request);
  const response = NextResponse.redirect(destination);
  const config = getSupabasePublicConfig();

  if (!code || config === null) {
    destination.searchParams.set('auth_error', 'configuration');
    return noStore(NextResponse.redirect(destination));
  }

  const supabase = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    destination.searchParams.set('auth_error', 'callback');
    return noStore(NextResponse.redirect(destination));
  }
  return noStore(response);
}
