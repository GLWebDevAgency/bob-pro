import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { GET } from '../../app/auth/callback/route';

describe('callback Supabase cabinet', () => {
  it('rejette les destinations absolues déguisées avec un antislash', async () => {
    const request = new NextRequest(
      'https://cabinet.bob.test/auth/callback?next=%2F%5Cevil.test',
    );

    const response = await GET(request);

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin).toBe('https://cabinet.bob.test');
    expect(location.pathname).toBe('/cabinet');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('conserve une destination interne et ses paramètres', async () => {
    const request = new NextRequest(
      'https://cabinet.bob.test/auth/callback?next=%2Fcabinet%3Ftab%3Dteam',
    );

    const response = await GET(request);

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin).toBe('https://cabinet.bob.test');
    expect(location.pathname).toBe('/cabinet');
    expect(location.searchParams.get('tab')).toBe('team');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
