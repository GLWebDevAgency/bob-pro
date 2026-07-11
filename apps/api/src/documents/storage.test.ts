import { describe, expect, it } from 'vitest';
import { InMemoryDocumentStorage, SupabaseDocumentStorage } from './storage';

const BYTES = new Uint8Array([1, 2, 3]);
const SHA = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';

describe('InMemoryDocumentStorage', () => {
  it('stocke sans écraser et retourne le sha256 réel', async () => {
    const storage = new InMemoryDocumentStorage();
    const key = `companies/co-1/documents/doc-1/v1/${SHA}.bin`;

    const stored = await storage.put({ companyId: 'co-1', key, bytes: BYTES, contentType: 'application/octet-stream' });

    expect(stored).toEqual({ key, sizeBytes: 3, sha256: SHA });
    await expect(storage.put({ companyId: 'co-1', key, bytes: BYTES, contentType: 'application/octet-stream' })).rejects.toThrow(
      'already exists',
    );
  });

  it('refuse une clé hors périmètre tenant', async () => {
    const storage = new InMemoryDocumentStorage();

    await expect(
      storage.put({
        companyId: 'co-1',
        key: `companies/co-2/documents/doc-1/v1/${SHA}.bin`,
        bytes: BYTES,
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow('outside tenant scope');
  });
});

// ── SupabaseDocumentStorage : le « 400 not_found » de Supabase Storage (constaté en prod) ──
// L'API Storage renvoie HTTP 400 avec un corps {"statusCode":"404","error":"not_found"} pour un
// objet INEXISTANT (jamais un vrai 404). Le stat/get doivent le traiter comme une absence — le
// HEAD aveugle historique faisait échouer TOUT premier upload (xmlDocumentId null, C-EXP6b).
describe('SupabaseDocumentStorage — 400 not_found = absence, pas une erreur', () => {
  const NOT_FOUND_BODY = JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' });
  const KEY = `companies/co-1/documents/doc-1/v1/${SHA}.bin`;

  function makeStorage(fetchImpl: typeof fetch): SupabaseDocumentStorage {
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    const storage = new SupabaseDocumentStorage({ url: 'https://stub.supabase.co', serviceRoleKey: 'srk' });
    // restauré par le test appelant après usage
    (storage as unknown as { __restore: () => void }).__restore = () => {
      globalThis.fetch = original;
    };
    return storage;
  }

  it('stat sur un objet inexistant (400 + corps not_found) → null, sans throw', async () => {
    const storage = makeStorage((async () =>
      new Response(NOT_FOUND_BODY, { status: 400 })) as typeof fetch);
    try {
      await expect(storage.stat('co-1', KEY)).resolves.toBeNull();
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('put : le pré-stat 400 not_found ne bloque plus le PREMIER upload (objet uploadé)', async () => {
    const calls: string[] = [];
    const storage = makeStorage((async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.includes('/object/info/')) return new Response(NOT_FOUND_BODY, { status: 400 });
      return new Response('{}', { status: 200 }); // l'upload POST réussit
    }) as typeof fetch);
    try {
      const stored = await storage.put({ companyId: 'co-1', key: KEY, bytes: BYTES, contentType: 'application/xml' });
      expect(stored.sha256).toBe(SHA);
      expect(calls.some((c) => c.startsWith('POST') && c.includes('/object/bob-documents/'))).toBe(true);
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('stat sur un objet existant lit size/content_type du corps info', async () => {
    const storage = makeStorage((async () =>
      new Response(JSON.stringify({ size: 10, content_type: 'text/plain' }), { status: 200 })) as typeof fetch);
    try {
      await expect(storage.stat('co-1', KEY)).resolves.toEqual({ sizeBytes: 10, contentType: 'text/plain' });
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('une VRAIE erreur (500) continue de throw — jamais un null menteur', async () => {
    const storage = makeStorage((async () => new Response('boom', { status: 500 })) as typeof fetch);
    try {
      await expect(storage.stat('co-1', KEY)).rejects.toThrow('stat failed: 500');
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });
});
