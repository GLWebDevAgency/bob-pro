import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBobClient } from './http-client';
import type { ApiErrorReport } from './error-report';

/**
 * CONTRAT D'ERREUR DES CHEMINS DE REQUÊTE (SPEC_SYSTEME_ERREUR §3-§4) : corrélation envoyée et
 * reprise, code court attaché, rapport développeur émis, 502 non-JSON distingué d'une coupure
 * réseau, sentinelles de timeout INCHANGÉES.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('corrélation bout-en-bout côté client', () => {
  it('envoie x-correlation-id (UUID v4) et privilégie le correlationId RACINE du corps d’erreur', async () => {
    let sent: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = headerOf(init, 'x-correlation-id');
      return jsonResponse(
        {
          ok: false,
          error: { kind: 'not_found', entity: 'company', id: '91300380500017' },
          correlationId: 'corr-du-serveur-1234',
        },
        404,
        { 'x-request-id': 'corr-du-serveur-1234' },
      );
    }));
    const reports: ApiErrorReport[] = [];
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'c1',
      onError: (report) => reports.push(report),
    });

    const r = await client.lookupCompany('91300380500017');

    expect(sent).toMatch(UUID_V4);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({
      kind: 'not_found',
      entity: 'company',
      id: '91300380500017',
      code: 'BOB-SIRET-404',
      correlationId: 'corr-du-serveur-1234',
    });
    // Rapport développeur : chemin EXPURGÉ (le SIRET de la query ne sort jamais), statut, durée.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      method: 'GET',
      path: '/company/lookup',
      status: 404,
      code: 'BOB-SIRET-404',
    });
    expect(reports[0]?.path).not.toContain('siret');
    expect(reports[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ANCIEN serveur (corps sans correlationId) : reprend le header x-request-id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse(
        { ok: false, error: { kind: 'forbidden', reason: 'offre' } },
        403,
        { 'x-request-id': 'ancien-serveur-9876' },
      ),
    ));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'c1' });

    const r = await client.getSubscription();

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.correlationId).toBe('ancien-serveur-9876');
    expect(r.error.code).toBe('BOB-API-403');
  });

  it('coupure réseau : l’erreur porte l’identifiant GÉNÉRÉ LOCALEMENT (celui envoyé au fil)', async () => {
    let sent: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = headerOf(init, 'x-correlation-id');
      throw new TypeError('Network request failed');
    }));
    const reports: ApiErrorReport[] = [];
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'c1',
      onError: (report) => reports.push(report),
    });

    const r = await client.getSubscription();

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      kind: 'dependency',
      port: 'api',
      cause: 'Network request failed',
      correlationId: sent,
    });
    expect(reports[0]).toMatchObject({ status: null, code: 'BOB-API-502' });
  });
});

describe('vérité du statut face aux corps illisibles', () => {
  it('502 au corps HTML (edge Railway) : « HTTP 502 (réponse non JSON). » — plus jamais « réseau »', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html', 'x-request-id': 'edge-502-corr-1' },
      }),
    ));
    const reports: ApiErrorReport[] = [];
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'c1',
      onError: (report) => reports.push(report),
    });

    const r = await client.getSubscription();

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      kind: 'dependency',
      port: 'api',
      cause: 'HTTP 502 (réponse non JSON).',
      correlationId: 'edge-502-corr-1',
      code: 'BOB-API-502',
    });
    expect(reports[0]).toMatchObject({ status: 502 });
  });

  it('200 au decode() nul (cas « SIRET servi mais vu en échec ») : api-contract AVEC corrélation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ inattendu: true }, 200, { 'x-request-id': 'contract-corr-42' }),
    ));
    const reports: ApiErrorReport[] = [];
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'c1',
      onError: (report) => reports.push(report),
    });

    const r = await client.lookupCompany('91300380500017');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      kind: 'dependency',
      port: 'api-contract',
      correlationId: 'contract-corr-42',
      code: 'BOB-SIRET-502',
    });
    expect(reports[0]).toMatchObject({ status: 200, path: '/company/lookup' });
  });

  it('le timeout local garde son message EXACT (contrat isRealtimeBootstrapTimeoutError) et se rapporte', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => undefined)));
    const reports: ApiErrorReport[] = [];
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'c1',
      onError: (report) => reports.push(report),
    });

    const pending = client.getCurrentQuoteAgentMissionResume();
    await vi.advanceTimersByTimeAsync(12_001);
    const r = await pending;

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      kind: 'dependency',
      cause: 'Délai réseau dépassé après 12000 ms.',
    });
    expect(r.error.correlationId).toMatch(UUID_V4);
    expect(reports[0]).toMatchObject({ status: null });
  });
});

describe('observateur onError', () => {
  it('un observateur qui jette n’empêche jamais le Result d’erreur de sortir', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ ok: false, error: { kind: 'forbidden', reason: 'offre' } }, 403),
    ));
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'c1',
      onError: () => {
        throw new Error('journal plein');
      },
    });

    const r = await client.getSubscription();

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('forbidden');
  });

  it('aucun rapport sur un succès', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ plan: 'demo' })));
    const reports: ApiErrorReport[] = [];
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'c1',
      onError: (report) => reports.push(report),
    });

    const r = await client.getSubscription();

    expect(r.ok).toBe(true);
    expect(reports).toHaveLength(0);
  });
});

describe('reqText — même contrat de corrélation', () => {
  it('un échec FEC porte code + correlationId et envoie le header de corrélation', async () => {
    const sentByUrl = new Map<string, string | undefined>();
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      sentByUrl.set(target, headerOf(init, 'x-correlation-id'));
      if (target.includes('/accounting/fec-metadata')) {
        return jsonResponse({ filename: 'fec.txt', descriptionFilename: 'desc.txt' });
      }
      return jsonResponse(
        {
          ok: false,
          error: { kind: 'unavailable', service: 'accounting-export' },
          correlationId: 'fec-corr-777',
        },
        503,
      );
    }));
    const reports: ApiErrorReport[] = [];
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'c1',
      onError: (report) => reports.push(report),
    });

    const r = await client.exportFec({ from: '2026-01-01', to: '2026-06-30' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      kind: 'unavailable',
      service: 'accounting-export',
      correlationId: 'fec-corr-777',
      code: 'BOB-API-503',
    });
    const fecCall = [...sentByUrl.entries()].find(([url]) => url.includes('/accounting/fec?'));
    expect(fecCall?.[1]).toMatch(UUID_V4);
    expect(reports.at(-1)).toMatchObject({ method: 'GET', path: '/accounting/fec', status: 503 });
  });
});
