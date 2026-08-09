import { describe, expect, it } from 'vitest';
import { SupabaseDocumentStorage } from './storage';
import { InMemoryDocumentStorage } from './storage.testing';
import type { RequestDeadlineRuntime } from './supabase-object-info';

const BYTES = new Uint8Array([1, 2, 3]);
const SHA = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';

describe('InMemoryDocumentStorage', () => {
  it('stocke sans écraser et retourne le sha256 réel', async () => {
    const storage = new InMemoryDocumentStorage();
    const key = `companies/co-1/documents/doc-1/v1/${SHA}.bin`;

    const stored = await storage.put({
      companyId: 'co-1',
      key,
      bytes: BYTES,
      contentType: 'application/octet-stream',
    });

    expect(stored).toEqual({
      key,
      sizeBytes: 3,
      sha256: SHA,
      contentType: 'application/octet-stream',
      created: true,
    });
    await expect(storage.put({
      companyId: 'co-1',
      key,
      bytes: BYTES,
      contentType: 'application/octet-stream; charset=binary',
    })).resolves.toMatchObject({ created: false, sha256: SHA });
    await expect(storage.put({
      companyId: 'co-1',
      key,
      bytes: new Uint8Array([1, 2, 4]),
      contentType: 'application/octet-stream',
    })).rejects.toThrow('collision');
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
  const NOT_FOUND_BODY = JSON.stringify({
    statusCode: '404',
    error: 'not_found',
    message: 'Object not found',
  });
  const KEY = `companies/co-1/documents/doc-1/v1/${SHA}.bin`;

  function infoResponse(
    contentType = 'application/xml',
    size = BYTES.byteLength,
  ): Response {
    return new Response(JSON.stringify({ size, content_type: contentType }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function makeStorage(
    fetchImpl: typeof fetch,
    requestRuntime: RequestDeadlineRuntime = {},
  ): SupabaseDocumentStorage {
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    const storage = new SupabaseDocumentStorage({
      url: 'https://stub.supabase.co',
      serviceRoleKey: 'srk',
    }, requestRuntime);
    // restauré par le test appelant après usage
    (storage as unknown as { __restore: () => void }).__restore = () => {
      globalThis.fetch = original;
    };
    return storage;
  }

  it('borne une I/O suspendue avec un AbortSignal réel', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })) as typeof fetch;
    const storage = new SupabaseDocumentStorage({
      url: 'https://stub.supabase.co',
      serviceRoleKey: 'srk',
      requestTimeoutMs: 5,
    });
    try {
      await expect(storage.get('co-1', KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('attache une deadline à GET, POST, readback, signature, stat et DELETE', async () => {
    const calls: Array<{ method: string; signal: AbortSignal | null }> = [];
    let objectGets = 0;
    const storage = makeStorage((async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, signal: init?.signal ?? null });
      const value = String(url);
      if (value.includes('/object/sign/')) {
        return new Response(JSON.stringify({ signedURL: '/storage/v1/object/sign/x' }));
      }
      if (value.includes('/object/info/')) {
        return new Response(JSON.stringify({ size: BYTES.byteLength, content_type: 'application/xml' }));
      }
      if (method === 'DELETE') return new Response('{}');
      if (method === 'POST') return new Response('{}');
      objectGets += 1;
      return objectGets === 1
        ? new Response(NOT_FOUND_BODY, { status: 400 })
        : new Response(Buffer.from(BYTES), {
            headers: { 'content-type': 'application/xml' },
          });
    }) as typeof fetch);
    try {
      await storage.put({
        companyId: 'co-1',
        key: KEY,
        bytes: BYTES,
        contentType: 'application/xml',
      });
      await storage.getSignedUrl('co-1', KEY, 60);
      await storage.stat('co-1', KEY);
      await storage.remove('co-1', KEY);
      expect(calls.map((call) => call.method)).toEqual([
        'GET', 'POST', 'GET', 'GET', 'POST', 'GET', 'DELETE',
      ]);
      expect(calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('stat sur un objet inexistant (400 + corps not_found) → null, sans throw', async () => {
    const storage = makeStorage(
      (async () => new Response(NOT_FOUND_BODY, { status: 400 })) as typeof fetch,
    );
    try {
      await expect(storage.stat('co-1', KEY)).resolves.toBeNull();
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('get calcule taille et SHA-256 depuis les octets effectivement téléchargés', async () => {
    const storage = makeStorage(
      (async (url: RequestInfo | URL) => String(url).includes('/object/info/')
        ? infoResponse('application/xml; charset=binary')
        : new Response(Buffer.from(BYTES), {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          })) as typeof fetch,
    );
    try {
      const loaded = await storage.get('co-1', KEY);
      expect(loaded).toEqual({
        key: KEY,
        bytes: BYTES,
        sizeBytes: BYTES.byteLength,
        sha256: SHA,
        contentType: 'application/xml; charset=binary',
      });
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('le GET et sa lecture info partagent le même budget de 15 secondes', async () => {
    let now = 1_000;
    const budgets: number[] = [];
    const storage = makeStorage(
      (async (url: RequestInfo | URL) => {
        if (String(url).includes('/object/info/')) return infoResponse();
        now += 6_000;
        return new Response(Buffer.from(BYTES), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }) as typeof fetch,
      {
        now: () => now,
        timeoutSignal: (milliseconds) => {
          budgets.push(milliseconds);
          return new AbortController().signal;
        },
      },
    );
    try {
      await expect(storage.get('co-1', KEY)).resolves.toMatchObject({ sha256: SHA });
      expect(budgets).toEqual([15_000, 9_000]);
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('refuse un objet téléchargé dont la métadonnée autoritative a disparu', async () => {
    const storage = makeStorage(
      (async (url: RequestInfo | URL) => String(url).includes('/object/info/')
        ? new Response(NOT_FOUND_BODY, { status: 400 })
        : new Response(Buffer.from(BYTES))) as typeof fetch,
    );
    try {
      await expect(storage.get('co-1', KEY)).rejects.toThrow(
        'metadata missing after object download',
      );
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('refuse une taille metadata différente des octets effectivement téléchargés', async () => {
    const storage = makeStorage(
      (async (url: RequestInfo | URL) => String(url).includes('/object/info/')
        ? infoResponse('application/xml', BYTES.byteLength + 1)
        : new Response(Buffer.from(BYTES))) as typeof fetch,
    );
    try {
      await expect(storage.get('co-1', KEY)).rejects.toThrow(
        'object and metadata size mismatch',
      );
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('adopte un objet préexistant strictement identique sans POST ni DELETE', async () => {
    const methods: string[] = [];
    const storage = makeStorage((async (url: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (String(url).includes('/object/info/')) return infoResponse();
      return new Response(Buffer.from(BYTES), {
        status: 200,
        headers: { 'content-type': 'application/xml; charset=binary' },
      });
    }) as typeof fetch);
    try {
      await expect(storage.put({
        companyId: 'co-1', key: KEY, bytes: BYTES, contentType: 'application/xml',
      })).resolves.toMatchObject({ created: false, sha256: SHA });
      expect(methods).toEqual(['GET', 'GET']);
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('adopte le gagnant identique après un conflit d’upload concurrent', async () => {
    const methods: string[] = [];
    let getCount = 0;
    const storage = makeStorage((async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (String(url).includes('/object/info/')) return infoResponse();
      if (method === 'GET') {
        getCount += 1;
        return getCount === 1
          ? new Response(NOT_FOUND_BODY, { status: 400 })
          : new Response(Buffer.from(BYTES), {
              status: 200,
              headers: { 'content-type': 'application/xml' },
            });
      }
      return new Response('already exists', { status: 409 });
    }) as typeof fetch);
    try {
      await expect(storage.put({
        companyId: 'co-1', key: KEY, bytes: BYTES, contentType: 'application/xml',
      })).resolves.toMatchObject({ created: false, sha256: SHA });
      expect(methods).toEqual(['GET', 'POST', 'GET', 'GET']);
      expect(methods).not.toContain('DELETE');
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('refuse une collision de même taille/MIME dont les octets diffèrent, sans effacement', async () => {
    const methods: string[] = [];
    const storage = makeStorage((async (url: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (String(url).includes('/object/info/')) return infoResponse();
      return new Response(Buffer.from([1, 2, 4]), {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }) as typeof fetch);
    try {
      await expect(storage.put({
        companyId: 'co-1', key: KEY, bytes: BYTES, contentType: 'application/xml',
      })).rejects.toThrow('collision');
      expect(methods).toEqual(['GET', 'GET']);
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('refuse un readback corrompu après POST sans supprimer une clé potentiellement adoptée', async () => {
    const methods: string[] = [];
    let getCount = 0;
    const storage = makeStorage((async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (String(url).includes('/object/info/')) return infoResponse();
      if (method === 'GET') {
        getCount += 1;
        return getCount === 1
          ? new Response(NOT_FOUND_BODY, { status: 400 })
          : new Response(Buffer.from([1, 2, 4]), {
              status: 200,
              headers: { 'content-type': 'application/xml' },
            });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    try {
      await expect(storage.put({
        companyId: 'co-1', key: KEY, bytes: BYTES, contentType: 'application/xml',
      })).rejects.toThrow('read-after-write integrity mismatch');
      expect(methods).toEqual(['GET', 'POST', 'GET', 'GET']);
      expect(methods).not.toContain('DELETE');
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('adopte l’objet exact quand l’ACK du POST est perdu', async () => {
    const methods: string[] = [];
    let getCount = 0;
    const storage = makeStorage((async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (String(url).includes('/object/info/')) return infoResponse();
      if (method === 'GET') {
        getCount += 1;
        return getCount === 1
          ? new Response(NOT_FOUND_BODY, { status: 400 })
          : new Response(Buffer.from(BYTES), {
              status: 200,
              headers: { 'content-type': 'application/xml' },
            });
      }
      throw new Error('connection reset after upload');
    }) as typeof fetch);
    try {
      await expect(storage.put({
        companyId: 'co-1', key: KEY, bytes: BYTES, contentType: 'application/xml',
      })).resolves.toMatchObject({ created: false, sha256: SHA });
      expect(methods).toEqual(['GET', 'POST', 'GET', 'GET']);
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('premier upload : adopte le readback byte-exact malgré son en-tête GET générique', async () => {
    const calls: string[] = [];
    let objectGets = 0;
    const storage = makeStorage((async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${u}`);
      if (u.includes('/object/info/')) return infoResponse();
      if (method === 'GET' && u.includes('/object/bob-documents/')) {
        objectGets += 1;
        return objectGets === 1
          ? new Response(NOT_FOUND_BODY, { status: 400 })
          : new Response(Buffer.from(BYTES), {
              status: 200,
              headers: { 'content-type': 'text/plain' },
            });
      }
      return new Response('{}', { status: 200 }); // l'upload POST réussit
    }) as typeof fetch);
    try {
      const stored = await storage.put({
        companyId: 'co-1',
        key: KEY,
        bytes: BYTES,
        contentType: 'application/xml',
      });
      expect(stored.sha256).toBe(SHA);
      expect(stored.created).toBe(true);
      expect(stored.contentType).toContain('application/xml');
      expect(calls.some((c) => c.startsWith('POST') && c.includes('/object/bob-documents/'))).toBe(
        true,
      );
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('stat sur un objet existant lit size/content_type du corps info', async () => {
    const storage = makeStorage(
      (async () =>
        new Response(JSON.stringify({ size: 10, content_type: 'text/plain' }), {
          status: 200,
        })) as typeof fetch,
    );
    try {
      await expect(storage.stat('co-1', KEY)).resolves.toEqual({
        sizeBytes: 10,
        contentType: 'text/plain',
      });
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it.each([
    ['absente', {}],
    ['négative', { size: -1 }],
    ['non entière', { size: 1.5 }],
    ['textuelle', { size: '10' }],
  ])('une taille %s échoue fermé au lieu de fabriquer un fichier à 0 octet', async (_label, body) => {
    const storage = makeStorage(
      (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
        })) as typeof fetch,
    );
    try {
      await expect(storage.stat('co-1', KEY)).rejects.toThrow('missing valid size');
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it.each([
    ['absent', { size: 10 }],
    ['vide', { size: 10, content_type: '  ' }],
    ['sans type', { size: 10, content_type: '; charset=utf-8' }],
    ['sans sous-type', { size: 10, content_type: 'not-a-mime' }],
    ['non textuel', { size: 10, content_type: 42 }],
  ])('un type MIME %s échoue fermé', async (_label, body) => {
    const storage = makeStorage(
      (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
    );
    try {
      await expect(storage.stat('co-1', KEY)).rejects.toThrow('missing valid content type');
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('une VRAIE erreur (500) continue de throw — jamais un null menteur', async () => {
    const storage = makeStorage(
      (async () => new Response('boom', { status: 500 })) as typeof fetch,
    );
    try {
      await expect(storage.stat('co-1', KEY)).rejects.toThrow('stat failed: 500');
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('getSignedUrl : le chemin relatif Supabase (« /object/sign/… ») est préfixé de /storage/v1', async () => {
    const storage = makeStorage(
      (async () =>
        new Response(JSON.stringify({ signedURL: `/object/sign/bob-documents/${KEY}?token=t1` }), {
          status: 200,
        })) as typeof fetch,
    );
    try {
      await expect(storage.getSignedUrl('co-1', KEY, 60)).resolves.toBe(
        `https://stub.supabase.co/storage/v1/object/sign/bob-documents/${KEY}?token=t1`,
      );
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });

  it('getSignedUrl : un chemin déjà absolu ou déjà préfixé /storage/v1 reste intact', async () => {
    const storage = makeStorage(
      (async () =>
        new Response(
          JSON.stringify({ signedURL: `/storage/v1/object/sign/bob-documents/${KEY}?token=t2` }),
          { status: 200 },
        )) as typeof fetch,
    );
    try {
      await expect(storage.getSignedUrl('co-1', KEY, 60)).resolves.toBe(
        `https://stub.supabase.co/storage/v1/object/sign/bob-documents/${KEY}?token=t2`,
      );
    } finally {
      (storage as unknown as { __restore: () => void }).__restore();
    }
  });
});
