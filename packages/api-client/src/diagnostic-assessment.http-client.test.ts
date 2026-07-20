import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBobClient } from './http-client';

describe('HttpBobClient — diagnostic persistant', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('préserve l’état never_run sans lui inventer de score', async () => {
    const neverRun = {
      status: 'never_run',
      currentSourceFingerprint: 'a'.repeat(64),
      currentSourceAsOf: '2026-07-17',
      rulesetVersion: 1,
      questions: ['platform', 'accountant'],
      saved: null,
      result: null,
      staleReason: null,
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bob.test/diagnostic/assessment');
      expect(init?.method).toBe('GET');
      return new Response(JSON.stringify(neverRun), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-owner' });

    await expect(client.getDiagnosticAssessment()).resolves.toEqual({ ok: true, value: neverRun });
  });

  it('n’envoie au PUT que réponses, révision et empreinte source', async () => {
    const input = {
      expectedRevision: 0,
      expectedSourceFingerprint: 'b'.repeat(64),
      answers: { platform: 'yes', accountant: 'unknown' },
    } as const;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bob.test/diagnostic/assessment');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return new Response(JSON.stringify({
        status: 'current',
        currentSourceFingerprint: input.expectedSourceFingerprint,
        currentSourceAsOf: '2026-07-17',
        rulesetVersion: 1,
        questions: ['platform', 'accountant'],
        saved: {
          revision: 1,
          answers: input.answers,
          score: 72,
          axes: [
            { id: 'reception', score: 100 },
            { id: 'emission', score: 80 },
            { id: 'donnees', score: 20 },
          ],
          sourceFingerprint: input.expectedSourceFingerprint,
          rulesetVersion: 1,
          sourceAsOf: '2026-07-17',
          createdAt: '2026-07-17T10:00:00.000Z',
          updatedAt: '2026-07-17T10:00:00.000Z',
        },
        result: { score: 72, axes: [], items: [], mix: {}, questions: ['platform', 'accountant'] },
        staleReason: null,
      }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-owner',
      getToken: async () => 'owner-token',
    });

    await expect(client.saveDiagnosticAssessment(input)).resolves.toMatchObject({
      ok: true,
      value: { status: 'current', saved: { revision: 1, score: 72 } },
    });
  });

  it('propage le 409 source_changed sans conserver un faux succès local', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { kind: 'conflict', entity: 'diagnostic_assessment', reason: 'source_changed' },
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-owner' });
    await expect(client.saveDiagnosticAssessment({
      expectedRevision: 1,
      expectedSourceFingerprint: 'c'.repeat(64),
      answers: { platform: 'no', accountant: 'no' },
    })).resolves.toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'diagnostic_assessment', reason: 'source_changed' },
    });
  });
});
