import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, JournalEntry, PendingAction } from '@bob/ai';
import { HttpBobClient } from './http-client';

const pushBindingInput = () => ({
  installationId: '11111111-1111-4111-8111-111111111111',
  throughGeneration: 1,
  revocationSecret: 'a'.repeat(64),
});

const pushRegistrationInput = () => ({
  installationId: '11111111-1111-4111-8111-111111111111',
  bindingId: '22222222-2222-4222-8222-222222222222',
  bindingGeneration: 1,
  revocationSecret: 'a'.repeat(64),
  expoPushToken: 'ExponentPushToken[abc]',
  platform: 'ios' as const,
});

describe('HttpBobClient', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('refuse toute API HTTP distante avant de transporter token ou secret push', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => new HttpBobClient({
      baseUrl: 'http://api.example.test',
      companyId: 'company-1',
    })).toThrow('HTTPS requis');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => new HttpBobClient({
      baseUrl: 'http://localhost:3000',
      companyId: 'company-1',
    })).not.toThrow();
  });

  it('closeAccount : DELETE /account avec le confirmationText en body, décode closedAt', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(url).toBe('https://api.bob.test/account');
      expect(init?.method).toBe('DELETE');
      expect(JSON.parse(String(init?.body))).toEqual({ confirmationText: 'Mercier Plomberie', reason: 'je change de métier' });
      return new Response(JSON.stringify({ closedAt: '2026-07-16T09:00:00.000Z' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await expect(
      client.closeAccount({ confirmationText: 'Mercier Plomberie', reason: 'je change de métier' }),
    ).resolves.toEqual({ ok: true, value: { closedAt: '2026-07-16T09:00:00.000Z' } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('closeAccount : confirmationText erroné (422 serveur) → AppError validation, jamais un succès', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: { kind: 'validation', issues: [{ field: 'confirmationText', message: 'ne correspond pas' }] } }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await expect(client.closeAccount({ confirmationText: 'faux nom' })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
  });

  it('interdit les redirects et refuse une réponse cross-origin avant décodage', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      const response = new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
      Object.defineProperty(response, 'url', { value: 'https://evil.example/push' });
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });
    await expect(client.replayPushRevocation(pushBindingInput())).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api', cause: 'Redirection API cross-origin refusée.' },
    });
  });

  it.each(['bound', 'superseded'] as const)(
    'décode strictement la réponse push register %s',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status }), {
        headers: { 'content-type': 'application/json' },
      })));
      const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

      await expect(client.registerDevice(pushRegistrationInput())).resolves.toEqual({
        ok: true,
        value: { status },
      });
    },
  );

  it.each([
    null,
    [],
    { status: 'BOUND' },
    { status: 'bound', accepted: true },
  ])('rejette une réponse push register malformée %#', async (payload) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await expect(client.registerDevice(pushRegistrationInput())).resolves.toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'api-contract',
        cause: 'Réponse API invalide pour POST /devices.',
      },
    });
  });

  it('rejette une réponse register enrichie par un proxy au lieu de faire confiance à un cast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'bound',
      proxyRequestId: 'req-1',
    }), { headers: { 'content-type': 'application/json' } })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await expect(client.registerDevice(pushRegistrationInput())).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it.each([
    ['revoke authentifié', '/devices/revocations', false],
    ['replay public', '/public/push-revocations', true],
  ] as const)('décode strictement la réponse push %s', async (_label, expectedPath, publicReplay) => {
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe(`https://api.bob.test${expectedPath}`);
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    const result = publicReplay
      ? client.replayPushRevocation(pushBindingInput())
      : client.revokeDeviceBinding(pushBindingInput());
    await expect(result).resolves.toEqual({ ok: true, value: { accepted: true } });
  });

  it.each([
    ['revoke authentifié', false, null],
    ['revoke authentifié', false, []],
    ['revoke authentifié', false, { accepted: false }],
    ['replay public', true, { accepted: 'true' }],
    ['replay public via proxy', true, { accepted: true, proxyRequestId: 'req-1' }],
  ] as const)('rejette une réponse push %s malformée', async (_label, publicReplay, payload) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    const result = publicReplay
      ? client.replayPushRevocation(pushBindingInput())
      : client.revokeDeviceBinding(pushBindingInput());
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it.each([
    ['register', 12_000, (client: HttpBobClient) => client.registerDevice(pushRegistrationInput())],
    ['revoke authentifié', 10_000, (client: HttpBobClient) => client.revokeDeviceBinding(pushBindingInput())],
    ['replay public', 10_000, (client: HttpBobClient) => client.replayPushRevocation(pushBindingInput())],
  ] as const)('conserve le timeout push %s à %i ms', async (_label, timeoutMs, invoke) => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    const pending = invoke(client);
    await vi.advanceTimersByTimeAsync(timeoutMs);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'api',
        cause: `Délai réseau dépassé après ${timeoutMs} ms.`,
      },
    });
  });

  it('borne aussi une récupération de jeton bloquée avant les appels documentaires', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-1',
      getToken: () => new Promise<string | null>(() => undefined),
    });

    const pending = client.getDocument('document-1');
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'api',
        cause: 'Délai réseau dépassé après 20000 ms.',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('conserve le même budget jusqu’au décodage complet du corps HTTP', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => undefined),
      } as Response;
    }));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    const pending = client.getDocument('document-1');
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api', cause: 'Délai réseau dépassé après 20000 ms.' },
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('transmet uniquement le DTO devis autorisé avec sa clé de rejeu opaque', async () => {
    const output = {
      quoteId: 'quote-1',
      totals: { ht: 16_000, vat: 3_200, ttc: 19_200, netToPay: 19_200, vatByRate: { 20: 3_200 } },
    };
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        customerId: 'customer-1',
        idempotencyKey: 'mobile-voice:quote:opaque-1',
        lines: [
          { label: 'Pose', category: 'labor', qty: 2, unitPriceHT: 8_000, vatRate: 20 },
        ],
        context: { housingOlderThan2y: true },
      });
      return new Response(JSON.stringify(output), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });
    const runtimeExtendedInput = {
      customerId: 'customer-1',
      idempotencyKey: 'mobile-voice:quote:opaque-1',
      lines: [{ label: 'Pose', category: 'labor' as const, qty: 2, unitPriceHT: 8_000, vatRate: 20 as const }],
      context: { housingOlderThan2y: true },
      companyId: 'forged-company',
      internalSecret: 'must-not-cross-http',
    };

    await expect(client.createQuote(runtimeExtendedInput)).resolves.toEqual({ ok: true, value: output });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.bob.test/quotes',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejette une réponse 2xx createQuote malformée avant tout checkpoint local', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      quoteId: 'quote-1',
      totals: { ht: 100, vat: 20, ttc: 999, netToPay: 120, vatByRate: { 20: 20 } },
    }), { headers: { 'content-type': 'application/json' } })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await expect(client.createQuote({
      customerId: 'customer-1',
      lines: [{ label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 100, vatRate: 20 }],
    })).resolves.toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'api-contract',
        cause: 'Réponse API invalide pour POST /quotes.',
      },
    });
  });

  it('borne POST /quotes pour autoriser un rejeu avec la même clé après réponse perdue', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });
    const pending = client.createQuote({
      customerId: 'customer-1',
      idempotencyKey: 'mobile-voice:quote:timeout-1',
      lines: [{ label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 100, vatRate: 20 }],
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api', cause: 'Délai réseau dépassé après 20000 ms.' },
    });
  });

  it('transmet uniquement le DTO autorisé et la clé opaque de recordExpense', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        supplierName: 'Cedeo',
        documentDate: '2026-07-13',
        totalTtcCents: 12_000,
        category: 'fournitures',
        idempotencyKey: 'scan-expense-opaque-1',
      });
      return new Response(JSON.stringify({ id: 'expense-1' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });
    const runtimeExtendedInput = {
      supplierName: 'Cedeo',
      documentDate: '2026-07-13',
      totalTtcCents: 12_000,
      category: 'fournitures' as const,
      idempotencyKey: 'scan-expense-opaque-1',
      companyId: 'other-tenant',
      internalSecret: 'must-not-cross-http',
    };

    await expect(client.recordExpense(runtimeExtendedInput))
      .resolves.toEqual({ ok: true, value: { id: 'expense-1' } });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.bob.test/expenses',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejette une réponse 2xx recordExpense malformée comme rupture de contrat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), {
      headers: { 'content-type': 'application/json' },
    })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });

    const result = await client.recordExpense({
      supplierName: 'Cedeo',
      documentDate: '2026-07-13',
      totalTtcCents: 12_000,
      category: 'fournitures',
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'api-contract',
        cause: 'Réponse API invalide pour POST /expenses.',
      },
    });
  });

  it('envoie une commande document→dépense bornée et vérifie la réponse contextuelle', async () => {
    const sha = 'b'.repeat(64);
    const documentId = 'document/scan?1';
    const response = {
      expenseId: 'expense-1',
      document: {
        id: documentId,
        companyId: 'company-1',
        kind: 'expense_receipt',
        origin: 'ocr',
        status: 'active',
        filename: 'ticket.jpg',
        mimeType: 'image/jpeg',
        byteSize: 123,
        sha256: sha,
        storageKey: `companies/company-1/documents/${documentId}/v1/${sha}.jpg`,
        folderId: 'folder-1',
        revision: 3,
        version: 1,
        linkedEntityType: 'expense',
        linkedEntityId: 'expense-1',
        documentDate: '2026-07-13',
        issuedAt: null,
        createdAt: '2026-07-13T12:00:00.000Z',
        createdBy: 'user-1',
        retentionUntil: '2036-07-13',
        tags: ['ticket'],
      },
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bob.test/documents/document%2Fscan%3F1/expense');
      expect(init?.method).toBe('PUT');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body))).toEqual({
        expectedRevision: 1,
        targetFolderId: 'folder-1',
        expense: {
          supplierName: 'Cedeo',
          documentDate: '2026-07-13',
          totalTtcCents: 12_000,
          category: 'fournitures',
        },
      });
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });
    const runtimeExtendedInput = {
      documentId,
      expectedRevision: 1,
      targetFolderId: 'folder-1',
      expense: {
        supplierName: 'Cedeo',
        documentDate: '2026-07-13',
        totalTtcCents: 12_000,
        category: 'fournitures' as const,
        source: 'manual',
        idempotencyKey: 'forged',
        companyId: 'other-tenant',
      },
      linkedEntityId: 'forged',
    };

    await expect(client.recordDocumentExpense(runtimeExtendedInput)).resolves.toEqual({
      ok: true,
      value: response,
    });
  });

  it('échoue fermé sur des DTO documentaires HTTP incomplets au lieu de les caster', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      const payload = url.endsWith('/download-url')
        ? { url: 'https://storage.example.test/document-1' }
        : {};
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    const document = await client.getDocument('document-1');
    expect(document).toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'api-contract',
        cause: 'Réponse API invalide pour GET /documents/document-1.',
      },
    });
    const download = await client.documentDownloadUrl('document-1');
    expect(download.ok).toBe(false);
    if (!download.ok) expect(download.error).toMatchObject({ kind: 'dependency', port: 'api-contract' });
  });

  it('encode les segments documentaires et lie la réponse au tenant et à l’id demandés', async () => {
    const sha = 'a'.repeat(64);
    const documentId = 'document/1?origin=voice';
    const response = {
      id: documentId,
      companyId: 'company-1',
      kind: 'expense_receipt',
      origin: 'ocr',
      status: 'active',
      filename: 'ticket.jpg',
      mimeType: 'image/jpeg',
      byteSize: 123,
      sha256: sha,
      storageKey: `companies/company-1/documents/${documentId}/v1/${sha}.jpg`,
      folderId: null,
      revision: 1,
      version: 1,
      linkedEntityType: null,
      linkedEntityId: null,
      documentDate: '2026-07-13',
      issuedAt: null,
      createdAt: '2026-07-13T12:00:00.000Z',
      createdBy: 'user-1',
      retentionUntil: '2036-07-13',
      tags: ['ticket'],
    };
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe('https://api.bob.test/documents/document%2F1%3Forigin%3Dvoice');
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await expect(client.getDocument(documentId)).resolves.toEqual({ ok: true, value: response });

    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
      ...response,
      companyId: 'company-2',
      storageKey: `companies/company-2/documents/${documentId}/v1/${sha}.jpg`,
    }), { headers: { 'content-type': 'application/json' } }));
    const crossTenant = await client.getDocument(documentId);
    expect(crossTenant.ok).toBe(false);
    if (!crossTenant.ok) {
      expect(crossTenant.error).toMatchObject({ kind: 'dependency', port: 'api-contract' });
    }
  });

  it('encode chaque segment dynamique du coffre documentaire', async () => {
    const urls: string[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      signals.push(init?.signal);
      return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } });
    }));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });
    const rawId = 'id/avec?query#fragment';
    const encodedId = encodeURIComponent(rawId);

    await client.getDocument(rawId);
    await client.getDocumentFolder(rawId);
    await client.updateDocumentFolder({ folderId: rawId, expectedRevision: 1, name: 'Archives' });
    await client.previewDocumentFolderDeletion(rawId);
    await client.executeDocumentFolderDeletion({ planId: rawId, strategy: { kind: 'empty' } });
    await client.moveDocumentToFolder({ documentId: rawId, folderId: null, expectedRevision: 1 });
    await client.analyzeDocument(rawId);
    await client.classifyDocument({
      documentId: rawId,
      linkedEntityType: 'expense',
      linkedEntityId: 'expense-1',
      expectedRevision: 1,
    });
    await client.documentDownloadUrl(rawId);

    expect(urls).toEqual([
      `https://api.bob.test/documents/${encodedId}`,
      `https://api.bob.test/document-folders/${encodedId}`,
      `https://api.bob.test/document-folders/${encodedId}`,
      `https://api.bob.test/document-folders/${encodedId}/deletion-plans`,
      `https://api.bob.test/document-folder-deletion-plans/${encodedId}/executions`,
      `https://api.bob.test/documents/${encodedId}/folder`,
      `https://api.bob.test/documents/${encodedId}/analysis`,
      `https://api.bob.test/documents/${encodedId}/classify`,
      `https://api.bob.test/documents/${encodedId}/download-url`,
    ]);
    expect(signals).toHaveLength(urls.length);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it('rend annulables l’intake, l’analyse OCR et les mutations de dossier', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } });
    }));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await client.createDocumentIntake({
      contentBase64: '/9j/2Q==',
      mimeType: 'image/jpeg',
      filename: 'ticket.jpg',
      idempotencyKey: 'intake-1',
    });
    await client.extractDocument({ contentBase64: '/9j/2Q==', mimeType: 'image/jpeg' });
    await client.createDocumentFolder({ name: 'Achats' });
    await client.moveDocumentToFolder({
      documentId: 'document-1',
      folderId: 'folder-1',
      expectedRevision: 1,
    });

    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it('exports FEC files with authoritative metadata from the API', async () => {
    const metadata = {
      filename: '732829320FEC20261231.txt',
      descriptionFilename: '732829320FEC20261231-description.txt',
      entryCount: 7,
      rowCount: 19,
      warnings: ['Compte 411 absent du plan comptable.'],
    };
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/accounting/fec-metadata?')) {
        return new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/accounting/fec-description?')) {
        return new Response('Descriptif FEC\n', {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': 'attachment; filename="732829320FEC20261231-description.txt"',
          },
        });
      }
      if (url.includes('/accounting/fec?')) {
        return new Response('JournalCode\tEcritureNum\nVE\t1\n', {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': 'attachment; filename="732829320FEC20261231.txt"',
          },
        });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-mercier',
      getToken: async () => 'test-token',
    });

    const r = await client.exportFec({ from: '2026-01-01', to: '2026-12-31' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.value.filename).toBe(metadata.filename);
    expect(r.value.descriptionFilename).toBe(metadata.descriptionFilename);
    expect(r.value.entryCount).toBe(metadata.entryCount);
    expect(r.value.rowCount).toBe(metadata.rowCount);
    expect(r.value.warnings).toEqual(metadata.warnings);
    expect(r.value.content).toContain('JournalCode');
    expect(r.value.descriptionContent).toContain('Descriptif FEC');
  });

  it("loads a payment accounting preview for an invoice", async () => {
    const preview = {
      invoiceId: 'inv-1',
      available: true,
      reason: null,
      reference: 'F-2026-0001',
      amountCents: 12000,
      remainingCents: 12000,
      method: 'transfer',
      totalDebitCents: 12000,
      totalCreditCents: 12000,
      lines: [
        { account: '512', label: 'Encaissement F-2026-0001', debitCents: 12000, creditCents: 0 },
        { account: '411', label: 'Encaissement F-2026-0001', debitCents: 0, creditCents: 12000 },
      ],
    };
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://api.bob.test/invoices/inv-1/payment-accounting-preview?amount=12000&method=transfer') {
        return new Response(JSON.stringify(preview), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });
    const r = await client.paymentAccountingPreview({ invoiceId: 'inv-1', amountCents: 12000, method: 'transfer' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.value).toEqual(preview);
  });

  it('C-EXP5b : getFiscalCalendar → GET /fiscal-calendar (JWT + tenant), échéances rendues telles quelles', async () => {
    const deadlines = [
      {
        id: 'cfe-acompte-2026',
        date: '2026-06-15',
        label: 'CFE : acompte (si CFE N-1 ≥ 3 000 €)',
        kind: 'cfe',
        amountHint: null,
        legalRef: 'art. 1679 quinquies CGI',
        confidence: 'assumed',
        explain: "Un acompte de 50 % de CFE n'est dû à cette date que si ta CFE de l'an dernier a atteint 3 000 €.",
      },
      {
        id: 'tva-acompte-juillet-2026',
        date: '2026-07-24',
        label: 'TVA : acompte de juillet (55 %)',
        kind: 'tva',
        amountHint: null,
        legalRef: 'art. 287, 3 CGI',
        confidence: 'assumed',
        explain: "Tu verses en juillet un acompte de 55 % de la TVA de l'an dernier (sauf si elle était sous 1 000 €) — la date exacte figure sur ton avis d'acompte.",
      },
    ];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === 'https://api.bob.test/fiscal-calendar' && init?.method === 'GET') {
        const headers = init?.headers as Record<string, string>;
        expect(headers['x-company-id']).toBe('company-mercier');
        expect(headers.authorization).toBe('Bearer test-token');
        return new Response(JSON.stringify(deadlines), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier', getToken: async () => 'test-token' });

    const r = await client.getFiscalCalendar();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Le client ne réinterprète RIEN : dates, confidence et explains viennent du use case serveur.
    expect(r.value).toEqual(deadlines);
  });

  it('C-EXP5b : getFiscalCalendar remonte l’AppError serveur telle quelle (ex. tenant sans société)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { kind: 'not_found', entity: 'company', id: 'co-fantome' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-fantome' });

    const r = await client.getFiscalCalendar();

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'not_found', entity: 'company', id: 'co-fantome' });
  });

  it('PONT-SERVEUR v1 : getCompanyMe → GET /company/me (JWT + tenant), fiche société rendue telle quelle', async () => {
    const company = {
      id: 'company-mercier',
      name: 'Mercier Plomberie',
      legalForm: 'EI',
      siren: '732829320',
      siret: '73282932000074',
      apeCode: '4322A',
      trade: 'plombier',
      vatRegime: 'reel_simpl',
      rcsOrRm: 'RM 92',
      address: { line1: '12 rue des Artisans', zip: '92000', city: 'Nanterre' },
      dateCreation: '2019-03-01',
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === 'https://api.bob.test/company/me' && init?.method === 'GET') {
        const headers = init?.headers as Record<string, string>;
        expect(headers['x-company-id']).toBe('company-mercier');
        expect(headers.authorization).toBe('Bearer test-token');
        return new Response(JSON.stringify(company), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier', getToken: async () => 'test-token' });

    const r = await client.getCompanyMe();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Le client ne réinterprète RIEN : la fiche société (identité connectée) vient de la BDD du tenant.
    expect(r.value).toEqual(company);
  });

  it('PONT-SERVEUR v1 : getCompanyMe remonte l’AppError serveur telle quelle (tenant sans société)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { kind: 'not_found', entity: 'company', id: 'co-fantome' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-fantome' });

    const r = await client.getCompanyMe();

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'not_found', entity: 'company', id: 'co-fantome' });
  });

  it('PONT-SERVEUR v1 : payExpense / listPayments / createCreditNote frappent EXACTEMENT les routes servies', async () => {
    const payment = { id: 'pay-1', invoiceId: 'inv-1', amountCents: 48840, method: 'card', receivedAt: '2026-07-04T10:00:00.000Z' };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === 'https://api.bob.test/expenses/exp-1/pay' && method === 'POST') {
        return new Response(JSON.stringify({ status: 'paid', alreadyPaid: false }), { headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://api.bob.test/payments' && method === 'GET') {
        return new Response(JSON.stringify([payment]), { headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://api.bob.test/invoices/inv-1/credit-note' && method === 'POST') {
        return new Response(JSON.stringify({ creditNoteId: 'inv-2' }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const paid = await client.payExpense({ expenseId: 'exp-1' });
    expect(paid.ok && paid.value.status).toBe('paid');

    const payments = await client.listPayments();
    expect(payments.ok && payments.value).toEqual([payment]);

    const creditNote = await client.createCreditNote({ invoiceId: 'inv-1' });
    expect(creditNote.ok && creditNote.value).toEqual({ creditNoteId: 'inv-2' });
  });

  it('R3/R6 : génération explicite et mutations draft frappent EXACTEMENT les routes servies', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === 'https://api.bob.test/quotes/quote-1/invoice' && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({ mode: 'final' });
        return new Response(JSON.stringify({ invoiceId: 'inv-9' }), { headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://api.bob.test/quotes/quote-1/lines/line-1' && method === 'PATCH') {
        expect(JSON.parse(String(init?.body))).toEqual({ qty: 3, unitPriceHT: 9000 });
        return new Response(JSON.stringify({ status: 'draft' }), { headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://api.bob.test/quotes/quote-1/lines/line-2' && method === 'DELETE') {
        return new Response(JSON.stringify({ status: 'draft' }), { headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://api.bob.test/invoices/inv-9/draft' && method === 'DELETE') {
        return new Response(JSON.stringify({ deleted: true }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const generated = await client.generateInvoice({ quoteId: 'quote-1', mode: 'final' });
    expect(generated.ok && generated.value).toEqual({ invoiceId: 'inv-9' });

    const updated = await client.updateQuoteLine({ quoteId: 'quote-1', lineId: 'line-1', patch: { qty: 3, unitPriceHT: 9000 } });
    expect(updated.ok && updated.value).toEqual({ status: 'draft' });

    const removed = await client.removeQuoteLine({ quoteId: 'quote-1', lineId: 'line-2' });
    expect(removed.ok && removed.value).toEqual({ status: 'draft' });

    const deleted = await client.deleteDraftInvoice('inv-9');
    expect(deleted.ok && deleted.value).toEqual({ deleted: true });
  });

  it('P0 R4 : signature-link et sign frappent les routes exactes avec le corps exact', async () => {
    const proofDataUrl = 'data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E';
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === 'https://api.bob.test/quotes/quote-1/signature-link' && method === 'POST') {
        // Préparer le lien n'envoie AUCUN corps métier : pas d'e-mail, pas de destinataire.
        expect(init?.body ?? undefined).toBeUndefined();
        return new Response(
          JSON.stringify({ signatureUrl: 'https://demo.bobpro.fr/sign/pst_new', expiresAt: '2026-07-31T00:00:00.000Z' }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (u === 'https://api.bob.test/quotes/quote-1/sign' && method === 'POST') {
        // Le tracé part en dataURL brut : le SERVEUR calcule le hash de preuve (jamais le client).
        expect(JSON.parse(String(init?.body))).toEqual({ signerName: 'M. Martin', proofDataUrl });
        return new Response(JSON.stringify({ status: 'signed' }), { headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://api.bob.test/quotes/quote-2/sign' && method === 'POST') {
        // Sans tracé, la clé proofDataUrl est ABSENTE du corps (jamais null/undefined sérialisé).
        expect(JSON.parse(String(init?.body))).toEqual({ signerName: 'M. Martin' });
        return new Response(JSON.stringify({ status: 'signed' }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const link = await client.createQuoteSignatureLink('quote-1');
    expect(link.ok && link.value).toEqual({
      signatureUrl: 'https://demo.bobpro.fr/sign/pst_new',
      expiresAt: '2026-07-31T00:00:00.000Z',
    });

    const signedWithProof = await client.signQuote({ quoteId: 'quote-1', signerName: 'M. Martin', proofDataUrl });
    expect(signedWithProof.ok && signedWithProof.value).toEqual({ status: 'signed' });

    const signedWithout = await client.signQuote({ quoteId: 'quote-2', signerName: 'M. Martin' });
    expect(signedWithout.ok && signedWithout.value).toEqual({ status: 'signed' });
  });

  it('loads expense defaults from the API memory endpoint', async () => {
    const defaults = {
      supplierName: 'Leroy Merlin',
      supplierSiren: '552100554',
      category: 'materiel',
      vatRatePct: 20,
      source: 'memory',
    };
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.bob.test/expenses/defaults') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({ supplierName: 'Leroy Merlin', categoryGuess: 'autre' });
        return new Response(JSON.stringify(defaults), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });
    const r = await client.suggestExpenseDefaults({
      supplierName: 'Leroy Merlin',
      supplierSiren: null,
      vatRatePctApplied: null,
      categoryGuess: 'autre',
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(defaults);
  });

  it('utilise un plan opaque mono-usage pour supprimer un dossier sans renvoyer le snapshot', async () => {
    const plan = {
      planId: 'plan-opaque-00000001',
      expiresAt: '2026-07-13T14:05:00.000Z',
      folder: { id: 'folder-old', parentId: null, name: 'Archives', systemKey: null },
      directChildCount: 1,
      descendantFolderCount: 1,
      directDocumentCount: 2,
      documentCount: 2,
      canDeleteEmpty: false,
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target === 'https://api.bob.test/document-folders/folder-old/deletion-plans') {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeUndefined();
        return new Response(JSON.stringify(plan), { headers: { 'content-type': 'application/json' } });
      }
      if (target === 'https://api.bob.test/document-folder-deletion-plans/plan-opaque-00000001/executions') {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          strategy: { kind: 'transfer', targetFolderId: 'folder-accounting', targetExpectedRevision: 3 },
        });
        expect(body).not.toHaveProperty('snapshot');
        expect(body).not.toHaveProperty('expectedRevision');
        return new Response(
          JSON.stringify({ folderId: 'folder-old', transferredDocuments: 2, transferredChildren: 1 }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', entity: 'route', id: target } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const preview = await client.previewDocumentFolderDeletion('folder-old');
    expect(preview.ok && preview.value).toEqual(plan);
    const executed = await client.executeDocumentFolderDeletion({
      planId: plan.planId,
      strategy: { kind: 'transfer', targetFolderId: 'folder-accounting', targetExpectedRevision: 3 },
    });
    expect(executed.ok && executed.value).toEqual({
      folderId: 'folder-old',
      transferredDocuments: 2,
      transferredChildren: 1,
    });
  });
});

describe('HttpBobClient — assistant Bob (C40 ⑧ : ask/confirm/journal serveur)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const proposedRun: AgentRun = {
    kind: 'proposed',
    intent: 'encaisser',
    model: 'demo',
    plan: ['Identifier la facture', 'Préparer l’encaissement', 'Attendre ta confirmation'],
    card: { title: 'Encaissement à confirmer', body: 'Encaisser 2026-014 · 1 320,00 € (Durand)\nJe valide ?' },
    pending: {
      tool: 'encaisser_facture',
      args: { invoiceId: 'inv-1', amountCents: 132000 },
      label: 'Encaisser 2026-014 · 1 320,00 € (Durand)',
      proposalId: 'proposal-server-1',
      expiresAt: '2026-07-13T04:00:00.000Z',
    },
  };

  it('askBob POSTe uniquement le DTO agent sérialisable complet et rend l’AgentRun du serveur tel quel', async () => {
    const history = [
      { role: 'user', text: 'Montre-moi la facture Martin.' },
      { role: 'bob', text: 'La facture F-2026-014 est affichée.' },
    ] as const;
    const context = {
      screen: { name: '/facture/[id]', instanceId: 'invoice:inv-1' },
      entities: [{ type: 'invoice', id: 'inv-1', label: 'Facture F-2026-014' }],
      capabilities: ['invoice.read', 'invoice.collect'],
    } as const;
    const onPhase = vi.fn();
    // Objet volontairement élargi : la frontière HTTP doit retirer les champs locaux/inconnus.
    const input = {
      message: 'encaisse celle-ci',
      autonomy: 'confirm_all',
      history,
      tone: 'pro',
      context,
      onPhase,
      ignoredAtRuntime: 'secret-local-state',
    } as const;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.bob.test/ai/ask') {
        expect(init?.method).toBe('POST');
        const headers = init?.headers as Record<string, string>;
        expect(headers['x-company-id']).toBe('company-mercier');
        expect(headers.authorization).toBe('Bearer test-token');
        expect(JSON.parse(String(init?.body))).toEqual({
          message: 'encaisse celle-ci',
          autonomy: 'confirm_all',
          history,
          tone: 'pro',
          context,
        });
        return new Response(JSON.stringify(proposedRun), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier', getToken: async () => 'test-token' });
    const r = await client.askBob(input);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onPhase).not.toHaveBeenCalled();
    expect(r.value).toEqual(proposedRun);
    expect(r.value.pending?.tool).toBe('encaisser_facture'); // rejouable tel quel via confirmBob
  });

  it('confirmBob ne POSTe que le proposalId opaque sur /ai/confirm et rend le run « done »', async () => {
    const doneRun: AgentRun = {
      kind: 'done',
      intent: 'encaisser',
      model: 'agent-runtime',
      plan: ['Encaisser 2026-014 · 1 320,00 € (Durand)'],
      card: { title: 'Fait ✓', body: 'Encaisser 2026-014 · 1 320,00 € (Durand) — c’est noté.' },
    };
    const pending: PendingAction = proposedRun.pending!;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.bob.test/ai/confirm') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ proposalId: 'proposal-server-1' });
        expect(String(init?.body)).not.toContain('invoiceId');
        expect(String(init?.body)).not.toContain('amountCents');
        return new Response(JSON.stringify(doneRun), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });
    const r = await client.confirmBob(pending);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(doneRun);
  });

  it('previewBobProposal recharge le diff opaque par GET sans envoyer aucun args', async () => {
    const pending = proposedRun.pending!;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.bob.test/ai/proposals/proposal-server-1');
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify(pending), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });
    await expect(client.previewBobProposal('proposal-server-1')).resolves.toEqual({
      ok: true,
      value: pending,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('confirmBob remonte l’AppError du serveur (garde-fou/paywall) sans la maquiller', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: { kind: 'forbidden', reason: "L'assistant Bob est inclus à partir de l'offre Solo." } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });
    const r = await client.confirmBob(proposedRun.pending!);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'forbidden', reason: "L'assistant Bob est inclus à partir de l'offre Solo." });
  });

  it('getRunJournal lit GET /ai/runs/:runId/journal (audit append-only company-scoped)', async () => {
    const entries: JournalEntry[] = [
      {
        seq: 1,
        runId: 'run-7',
        at: '2026-07-03T10:00:00.000Z',
        phase: 'planned',
        tool: 'encaisser_facture',
        label: 'Encaisser 2026-014',
        args: { invoiceId: 'inv-1', amountCents: 132000 },
        mutating: true,
        outbound: false,
        compliance: 'medium',
      },
      {
        seq: 2,
        runId: 'run-7',
        at: '2026-07-03T10:00:00.100Z',
        phase: 'executed',
        tool: 'encaisser_facture',
        label: 'Encaisser 2026-014',
        args: { invoiceId: 'inv-1', amountCents: 132000 },
        mutating: true,
        outbound: false,
        compliance: 'medium',
        resultDigest: 'status=paid',
      },
    ];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.bob.test/ai/runs/run-7/journal') {
        expect(init?.method).toBe('GET');
        return new Response(JSON.stringify(entries), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });
    const r = await client.getRunJournal('run-7');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(entries);
  });

  it('createCustomer POSTe /customers (DTO CustomersController) et rend l’id créé', async () => {
    const input = {
      name: 'Mme Nguyen',
      type: 'b2c' as const,
      address: { line1: '4 rue Basse', zip: '92310', city: 'Sèvres' },
      score: 100,
      avgDelayDays: 0,
      outstanding: 0,
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === 'https://api.bob.test/customers' && init?.method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual(input);
        return new Response(JSON.stringify({ id: 'cust-42' }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });
    const r = await client.createCustomer(input);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ id: 'cust-42' });
  });

  it('C25 : relance ciblée réelle + fil de notifications + devices (endpoints serveur)', async () => {
    const item = {
      id: 'job-1',
      kind: 'invoice-relance',
      title: 'Facture F-2026-0002 — relance ferme',
      body: null,
      channel: 'email',
      status: 'done',
      route: '/facture/inv-1',
      readAt: null,
      createdAt: '2026-07-03T06:00:00.000Z',
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === 'https://api.bob.test/invoices/inv-1/relance' && method === 'POST') {
        return new Response(JSON.stringify({ jobId: 'job-1', status: 'done', tone: 'ferme' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u === 'https://api.bob.test/notifications' && method === 'GET') {
        return new Response(JSON.stringify([item]), { headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://api.bob.test/notifications/job-1/read' && method === 'POST') {
        return new Response(JSON.stringify({ ...item, readAt: '2026-07-03T08:00:00.000Z' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u === 'https://api.bob.test/notifications/unread-preview' && method === 'GET') {
        return new Response(
          JSON.stringify({ unreadCount: 1, throughCreatedAt: '2026-07-03T08:00:00.000Z' }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (u === 'https://api.bob.test/notifications/read-through' && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({
          throughCreatedAt: '2026-07-03T08:00:00.000Z',
        });
        return new Response(
          JSON.stringify({ updatedCount: 1, readAt: '2026-07-03T08:00:01.000Z' }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (u === 'https://api.bob.test/devices' && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({
          expoPushToken: 'ExponentPushToken[abc]',
          platform: 'ios',
          installationId: '11111111-1111-4111-8111-111111111111',
          bindingId: '22222222-2222-4222-8222-222222222222',
          bindingGeneration: 1,
          revocationSecret: 'a'.repeat(64),
        });
        return new Response(JSON.stringify({ status: 'bound' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u === 'https://api.bob.test/devices' && method === 'DELETE') {
        expect(JSON.parse(String(init?.body))).toEqual({ expoPushToken: 'ExponentPushToken[abc]' });
        return new Response(JSON.stringify({ unregistered: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const sent = await client.sendRelance('inv-1');
    expect(sent.ok && sent.value).toEqual({ jobId: 'job-1', status: 'done', tone: 'ferme' });

    const feed = await client.listNotifications();
    expect(feed.ok && feed.value).toEqual([item]);

    const read = await client.markNotificationRead('job-1');
    expect(read.ok && read.value.readAt).toBe('2026-07-03T08:00:00.000Z');

    const preview = await client.previewUnreadNotifications();
    expect(preview.ok && preview.value).toEqual({
      unreadCount: 1,
      throughCreatedAt: '2026-07-03T08:00:00.000Z',
    });
    const readThrough = await client.markNotificationsReadThrough({
      throughCreatedAt: '2026-07-03T08:00:00.000Z',
    });
    expect(readThrough.ok && readThrough.value).toEqual({
      updatedCount: 1,
      readAt: '2026-07-03T08:00:01.000Z',
    });

    const device = await client.registerDevice({
      expoPushToken: 'ExponentPushToken[abc]',
      platform: 'ios',
      installationId: '11111111-1111-4111-8111-111111111111',
      bindingId: '22222222-2222-4222-8222-222222222222',
      bindingGeneration: 1,
      revocationSecret: 'a'.repeat(64),
    });
    expect(device.ok && device.value).toEqual({ status: 'bound' });
    const revoked = await client.unregisterDevice({ expoPushToken: 'ExponentPushToken[abc]' });
    expect(revoked).toEqual({ ok: true, value: { unregistered: true } });
  });

  it('C24b : registerCompany → POST /onboarding/company, id décidé par le serveur (jamais envoyé)', async () => {
    const input = {
      name: 'Durand Élec',
      legalForm: 'EI' as const,
      siren: '732829320',
      siret: '73282932000074',
      trade: 'electricien' as const,
      vatRegime: 'franchise' as const,
      address: { line1: '4 rue du Forgeron', zip: '92310', city: 'Sèvres' },
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === 'https://api.bob.test/onboarding/company' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toEqual(input);
        expect(body).not.toHaveProperty('id'); // anti-rattachement : l'id vient TOUJOURS du serveur
        return new Response(JSON.stringify({ companyId: 'company-user-1' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const r = await client.registerCompany(input);

    expect(r.ok && r.value).toEqual({ companyId: 'company-user-1' });
  });

  it('C26b : getSubscription → GET /subscription, early-access RÉEL du tenant (SubscriptionInfo ⊂ payload)', async () => {
    const payload = {
      tier: 'business',
      status: 'active',
      earlyAccess: true,
      priceCents: 0,
      currentPeriodEnd: null,
      features: ['ai_assistant', 'accounting_foundation'],
      catalog: [],
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === 'https://api.bob.test/subscription' && init?.method === 'GET') {
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const r = await client.getSubscription();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.value).toEqual(payload);
    // Le cœur C26b : la vérité early-access voyage jusqu'à l'écran (0 € facturé, pas de plan inventé).
    expect(r.value.earlyAccess).toBe(true);
    expect(r.value.priceCents).toBe(0);
  });

  it('BOB EXPERT FISCAL (Phase 1A) : getFiscalProfile → GET /fiscal-profile', async () => {
    const payload = {
      companyId: 'company-mercier',
      legalForm: { status: 'source_fiable', value: 'EI', updatedAt: '2026-07-15T10:00:00.000Z', source: 'insee_siret' },
      taxRegime: { status: 'hypothese', value: 'reel_ir', updatedAt: '2026-07-15T10:00:00.000Z', source: 'derived_legal_form' },
      socialStatus: { status: 'hypothese', value: 'tns', updatedAt: '2026-07-15T10:00:00.000Z', source: 'derived_legal_form' },
      activityNature: { status: 'manquant' },
      vatRegime: { status: 'manquant' },
      acre: { status: 'manquant' },
      versementLiberatoire: { status: 'manquant' },
      fiscalYearEnd: { status: 'hypothese', value: null, updatedAt: '2026-07-15T10:00:00.000Z', source: 'derived_legal_form' },
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === 'https://api.bob.test/fiscal-profile' && init?.method === 'GET') {
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const r = await client.getFiscalProfile();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.value).toEqual(payload);
  });

  it('BOB EXPERT FISCAL (Phase 1A) : updateFiscalProfileField → PATCH /fiscal-profile/:field, { value } dans le corps', async () => {
    const payload = {
      companyId: 'company-mercier',
      legalForm: { status: 'source_fiable', value: 'EI', updatedAt: '2026-07-15T10:00:00.000Z', source: 'insee_siret' },
      taxRegime: { status: 'confirme_utilisateur', value: 'is', updatedAt: '2026-07-15T10:00:00.000Z', source: 'user_form' },
      socialStatus: { status: 'manquant' },
      activityNature: { status: 'manquant' },
      vatRegime: { status: 'manquant' },
      acre: { status: 'manquant' },
      versementLiberatoire: { status: 'manquant' },
      fiscalYearEnd: { status: 'manquant' },
    };
    let capturedBody: unknown = null;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === 'https://api.bob.test/fiscal-profile/taxRegime' && init?.method === 'PATCH') {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const r = await client.updateFiscalProfileField('taxRegime', 'is');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedBody).toEqual({ value: 'is' });
    expect(r.value).toEqual(payload);
  });

  it('pilier 2 : latestValueDigest → GET /engagement/digest/latest ; digest null (sans substance) voyage tel quel', async () => {
    const payload = {
      digest: null,
      periodStart: '2026-07-06T22:00:00.000Z',
      periodEnd: '2026-07-13T22:00:00.000Z',
      isoWeek: '2026-W28',
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === 'https://api.bob.test/engagement/digest/latest' && init?.method === 'GET') {
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const r = await client.latestValueDigest();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // null = semaine sans substance : la carte mobile ne se rend pas — jamais un digest inventé.
    expect(r.value).toEqual(payload);
  });

  it('pilier 2 : trialReport → GET /engagement/trial-report ; trial null (pas d’essai) voyage tel quel', async () => {
    const payload = {
      digest: null,
      periodStart: null,
      periodEnd: null,
      trial: { plan: 'pro', endsAt: '2026-07-28T09:00:00.000Z', phase: 'ending_soon', daysLeft: 2 },
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === 'https://api.bob.test/engagement/trial-report' && init?.method === 'GET') {
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const r = await client.trialReport();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(payload);
  });

  it('pilier 2 : recordValueDigestOpened → POST /engagement/digest/opened avec l’accroche du domaine', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === 'https://api.bob.test/engagement/digest/opened' && init?.method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({ highlightKind: 'money' });
        return new Response(JSON.stringify({ recorded: true }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const r = await client.recordValueDigestOpened('money');

    expect(r.ok && r.value).toEqual({ recorded: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe('HttpBobClient — C-EXP6b réception e-facture', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('importFacturXExpense → POST /expenses/import-facturx ; confirm → POST …/confirm avec la décision EXPLICITE', async () => {
    const review = {
      draft: {
        supplierName: 'Sanit Chauffe SAS',
        supplierSiren: '552100554',
        supplierInvoiceNumber: 'FC-2026-118',
        documentDate: '2026-06-20',
        dueAt: '2026-07-20',
        totalTtcCents: 55800,
        totalHtCents: 47000,
        vatCents: 8800,
        vatRatePct: null,
        vatNonDeductible: false,
        vatNote: null,
        categoryGuess: 'materiel',
        categorySource: 'memory',
        source: 'facturx',
        duplicateKey: '552100554|FC-2026-118',
      },
      controls: ['destinataire', 'coherence_en16931', 'doublon'],
    };
    const outcome = { status: 'approved', expenseId: 'exp-9', xmlDocumentId: 'doc-3' };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u === 'https://api.bob.test/expenses/import-facturx' && init?.method === 'POST') {
        return new Response(JSON.stringify(review), { headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://api.bob.test/expenses/import-facturx/confirm' && init?.method === 'POST') {
        return new Response(JSON.stringify(outcome), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const r = await client.importFacturXExpense({ xml: '<rsm:CrossIndustryInvoice/>' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(review);

    const c = await client.confirmFacturXExpense({
      xml: '<rsm:CrossIndustryInvoice/>',
      decision: { action: 'approve', category: 'materiel' },
    });
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.value).toEqual(outcome);

    // La décision voyage TELLE QUELLE (le serveur revalide) : xml resoumis + action explicite.
    const confirmCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/confirm'));
    expect(confirmCall).toBeDefined();
    const body = JSON.parse(String((confirmCall?.[1] as RequestInit).body));
    expect(body).toEqual({ xml: '<rsm:CrossIndustryInvoice/>', decision: { action: 'approve', category: 'materiel' } });
  });

  it('un contrôle bloquant serveur (doublon) remonte comme AppError validation typée facturx.*', async () => {
    const error = {
      error: {
        kind: 'validation',
        issues: [{ field: 'facturx.doublon', message: 'Facture FC-2026-118 du fournisseur déjà enregistrée (clé 552100554|FC-2026-118) — import refusé (anti double-paiement).' }],
      },
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(error), { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier' });

    const r = await client.importFacturXExpense({ xml: '<xml/>' });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'validation') {
      expect(r.error.issues[0]?.field).toBe('facturx.doublon');
      expect(r.error.issues[0]?.message).toContain('552100554|FC-2026-118');
    }
  });
});

describe('HttpBobClient — Bob Live WebRTC', () => {
  const speechSourcePolicy = (sessionHandle: string) => ({
    mode: 'signed-url-v1' as const,
    allowedOrigin: 'https://project.supabase.co',
    allowedPathPrefix: `/storage/v1/object/sign/bob-live-audio/companies/company-1/bob-live/${sessionHandle}/`,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('décode strictement la capacité et négocie le SDP via le backend authentifié', async () => {
    const answerSdp = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
    const sessionHandle = '00000000-0000-4000-8000-000000000001';
    const turnId = '00000000-0000-4000-8000-000000000002';
    const acknowledgementId = '00000000-0000-4000-8000-000000000003';
    const contextDigest = 'a'.repeat(64);
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/voice/realtime/config')) {
        return new Response(JSON.stringify({
          available: true,
          transport: 'webrtc',
          model: 'gpt-realtime-2.1',
          voice: 'marin',
          configVersion: 'bob-live-webrtc-v1',
          requiresDevelopmentBuild: true,
          maxSessionSeconds: 900,
          speechDelivery: 'audited-signed-url-v1',
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (init?.method === 'DELETE') {
        expect(String(url)).toBe(`https://api.bob.test/voice/realtime/calls/${sessionHandle}`);
        return new Response(JSON.stringify({ ended: true }), { headers: { 'content-type': 'application/json' } });
      }
      if (init?.method === 'PUT') {
        expect(String(url)).toBe(`https://api.bob.test/voice/realtime/calls/${sessionHandle}/context`);
        expect(JSON.parse(String(init.body))).toEqual({
          version: 1,
          revision: 7,
          context: {
            screen: { name: '/home', instanceId: 'home-1' },
            entities: [],
            capabilities: ['screen.read'],
          },
        });
        return new Response(JSON.stringify({ revision: 7, contextDigest }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).endsWith('/control-acknowledgements')) {
        expect(String(url)).toBe(
          `https://api.bob.test/voice/realtime/calls/${sessionHandle}/control-acknowledgements`,
        );
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          turnId,
          acknowledgementId,
          contextRevision: 7,
          contextDigest,
        });
        return new Response(JSON.stringify({
          turnId,
          acknowledgementId,
          kind: 'answer',
          contextRevision: 7,
          contextDigest,
          navigate: '/cloture',
        }), { headers: { 'content-type': 'application/json' } });
      }
      expect(String(url)).toBe('https://api.bob.test/voice/realtime/calls');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n',
        sessionHandle,
      });
      return new Response(JSON.stringify({
        transport: 'webrtc',
        answerSdp,
        sessionHandle,
        hardExpiresAt: '2026-07-13T20:00:00.000Z',
        model: 'gpt-realtime-2.1',
        voice: 'marin',
        configVersion: 'bob-live-webrtc-v1',
        maxSessionSeconds: 900,
        speechSourcePolicy: speechSourcePolicy(sessionHandle),
      }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-1',
      getToken: async () => 'supabase-jwt',
    });

    const config = await client.realtimeVoiceConfig();
    const call = await client.createRealtimeVoiceCall({
      sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n',
      sessionHandle,
    });
    const context = await client.updateRealtimeVoiceContext(sessionHandle, {
      version: 1,
      revision: 7,
      context: {
        screen: { name: '/home', instanceId: 'home-1' },
        entities: [],
        capabilities: ['screen.read'] as const,
      },
    });
    const control = await client.acknowledgeRealtimeVoiceControl(sessionHandle, {
      turnId,
      acknowledgementId,
      contextRevision: 7,
      contextDigest,
    });
    const ended = await client.hangupRealtimeVoiceCall(sessionHandle);

    expect(config).toMatchObject({ ok: true, value: { available: true, transport: 'webrtc' } });
    expect(call).toMatchObject({ ok: true, value: { answerSdp } });
    expect(context).toEqual({ ok: true, value: { revision: 7, contextDigest } });
    expect(control).toEqual({
      ok: true,
      value: {
        turnId,
        acknowledgementId,
        kind: 'answer',
        contextRevision: 7,
        contextDigest,
        navigate: '/cloture',
      },
    });
    expect(ended).toEqual({ ok: true, value: { ended: true } });
    if (call.ok) expect(call.value).not.toHaveProperty('callId');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer supabase-jwt' });
  });

  it('décode le bootstrap Mistral opaque sans mettre le ticket dans l’URL ni exposer le fournisseur', async () => {
    const sessionHandle = '00000000-0000-4000-8000-000000000011';
    const ticket = 'A'.repeat(43);
    const contextDigest = 'b'.repeat(64);
    const context = {
      version: 1 as const,
      revision: 3,
      context: {
        screen: { name: '/documents', instanceId: 'documents-1' },
        entities: [],
        capabilities: ['screen.read'] as const,
      },
    };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bob.test/voice/realtime/calls');
      expect(String(url)).not.toContain(ticket);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ context, sessionHandle });
      return new Response(JSON.stringify({
        transport: 'mistral-pcm',
        websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
        companyId: 'company-1',
        ticket,
        protocol: 'bob.mistral-pcm.v1',
        ticketExpiresAt: '2026-07-14T12:00:30.000Z',
        maxAudioBytes: 28_800_000,
        contextRevision: 3,
        contextDigest,
        sessionHandle,
        hardExpiresAt: '2026-07-14T12:15:00.000Z',
        model: 'voxtral-mini-transcribe-realtime-2602',
        voice: 'marin',
        configVersion: 'bob-live-provider-neutral-v2',
        maxSessionSeconds: 900,
        speechSourcePolicy: speechSourcePolicy(sessionHandle),
      }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    const result = await client.createRealtimeVoiceCall({
      transport: 'mistral-pcm',
      context,
      sessionHandle,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        transport: 'mistral-pcm',
        websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
        companyId: 'company-1',
        ticket,
        protocol: 'bob.mistral-pcm.v1',
        ticketExpiresAt: '2026-07-14T12:00:30.000Z',
        maxAudioBytes: 28_800_000,
        contextRevision: 3,
        contextDigest,
        sessionHandle,
        hardExpiresAt: '2026-07-14T12:15:00.000Z',
        model: 'voxtral-mini-transcribe-realtime-2602',
        voice: 'marin',
        configVersion: 'bob-live-provider-neutral-v2',
        maxSessionSeconds: 900,
        speechSourcePolicy: speechSourcePolicy(sessionHandle),
      },
    });
  });

  it('rejette un localisateur Mistral dont le companyId dérive du tenant authentifié', async () => {
    const sessionHandle = '00000000-0000-4000-8000-000000000012';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      transport: 'mistral-pcm',
      websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
      companyId: 'company-2',
      ticket: 'A'.repeat(43),
      protocol: 'bob.mistral-pcm.v1',
      ticketExpiresAt: '2026-07-14T12:00:30.000Z',
      maxAudioBytes: 32_000,
      contextRevision: 1,
      contextDigest: 'b'.repeat(64),
      sessionHandle,
      hardExpiresAt: '2026-07-14T12:15:00.000Z',
      model: 'voxtral-mini-transcribe-realtime-2602',
      voice: 'marin',
      configVersion: 'bob-live-provider-neutral-v2',
      maxSessionSeconds: 900,
      // La policy reste correctement liée à company-1 : le champ localisateur doit lui aussi
      // être exact, sinon le mobile transmettrait un tenant ambigu dans l'auth WebSocket.
      speechSourcePolicy: speechSourcePolicy(sessionHandle),
    }), { headers: { 'content-type': 'application/json' } })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await expect(client.createRealtimeVoiceCall({
      transport: 'mistral-pcm',
      context: {
        version: 1,
        revision: 1,
        context: {
          screen: { name: '/home', instanceId: 'home-1' },
          entities: [],
          capabilities: ['screen.read'],
        },
      },
      sessionHandle,
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('rejette un endpoint PCM Mistral qui dérive de l’autorité API authentifiée', async () => {
    const sessionHandle = '00000000-0000-4000-8000-000000000013';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      transport: 'mistral-pcm',
      websocketUrl: 'wss://microphone-collector.attacker.test/v1/voice/realtime/mistral',
      companyId: 'company-1',
      ticket: 'A'.repeat(43),
      protocol: 'bob.mistral-pcm.v1',
      ticketExpiresAt: '2026-07-14T12:00:30.000Z',
      maxAudioBytes: 32_000,
      contextRevision: 1,
      contextDigest: 'b'.repeat(64),
      sessionHandle,
      hardExpiresAt: '2026-07-14T12:15:00.000Z',
      model: 'voxtral-mini-transcribe-realtime-2602',
      voice: 'marin',
      configVersion: 'bob-live-provider-neutral-v2',
      maxSessionSeconds: 900,
      speechSourcePolicy: speechSourcePolicy(sessionHandle),
    }), { headers: { 'content-type': 'application/json' } })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await expect(client.createRealtimeVoiceCall({
      transport: 'mistral-pcm',
      context: {
        version: 1,
        revision: 1,
        context: {
          screen: { name: '/home', instanceId: 'home-1' },
          entities: [],
          capabilities: ['screen.read'],
        },
      },
      sessionHandle,
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it.each([
    ['origine avec credentials', {
      ...speechSourcePolicy('00000000-0000-4000-8000-000000000021'),
      allowedOrigin: 'https://user:secret@project.supabase.co',
    }],
    ['tenant', {
      ...speechSourcePolicy('00000000-0000-4000-8000-000000000021'),
      allowedPathPrefix: '/storage/v1/object/sign/bob-live-audio/companies/company-2/bob-live/00000000-0000-4000-8000-000000000021/',
    }],
    ['session', {
      ...speechSourcePolicy('00000000-0000-4000-8000-000000000099'),
    }],
    ['encodage ambigu', {
      ...speechSourcePolicy('00000000-0000-4000-8000-000000000021'),
      allowedPathPrefix: '/storage/v1/object/sign/bob-live-audio/companies/company-1/bob-live/%30%30/',
    }],
  ])('rejette une policy de source audio hors binding (%s)', async (_label, speechSourcePolicyValue) => {
    const sessionHandle = '00000000-0000-4000-8000-000000000021';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      transport: 'webrtc',
      answerSdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n',
      sessionHandle,
      hardExpiresAt: '2026-07-14T12:15:00.000Z',
      model: 'gpt-realtime-2.1',
      voice: 'marin',
      configVersion: 'bob-live-provider-neutral-v3',
      maxSessionSeconds: 900,
      speechSourcePolicy: speechSourcePolicyValue,
    }), { headers: { 'content-type': 'application/json' } })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await expect(client.createRealtimeVoiceCall({
      sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n',
      sessionHandle,
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('refuse un bootstrap Mistral avec URL ambiguë ou champ privé fournisseur', async () => {
    const response = {
      transport: 'mistral-pcm',
      websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral?ticket=secret',
      companyId: 'company-1',
      ticket: 'A'.repeat(43),
      protocol: 'bob.mistral-pcm.v1',
      ticketExpiresAt: '2026-07-14T12:00:30.000Z',
      maxAudioBytes: 32_000,
      contextRevision: 1,
      contextDigest: 'b'.repeat(64),
      sessionHandle: '00000000-0000-4000-8000-000000000011',
      hardExpiresAt: '2026-07-14T12:15:00.000Z',
      model: 'voxtral-mini-transcribe-realtime-2602',
      voice: 'marin',
      configVersion: 'bob-live-provider-neutral-v2',
      maxSessionSeconds: 900,
      providerSessionId: 'private-provider-id',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    const result = await client.createRealtimeVoiceCall({
      transport: 'mistral-pcm',
      context: {
        version: 1,
        revision: 1,
        context: {
          screen: { name: '/home', instanceId: 'home-1' },
          entities: [],
          capabilities: ['screen.read'],
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('refuse une réponse qui tente d’exposer un call_id fournisseur au mobile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      transport: 'webrtc',
      answerSdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n',
      sessionHandle: '00000000-0000-4000-8000-000000000001',
      hardExpiresAt: '2026-07-13T20:00:00.000Z',
      callId: 'rtc_12345678',
      model: 'gpt-realtime-2.1',
      voice: 'marin',
      configVersion: 'bob-live-webrtc-v1',
      maxSessionSeconds: 900,
    }), { headers: { 'content-type': 'application/json' } })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    const result = await client.createRealtimeVoiceCall({ sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n' });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('refuse un acquittement qui expose nonce/provider id ou une navigation hors allowlist', async () => {
    const sessionHandle = '00000000-0000-4000-8000-000000000001';
    const turnId = '00000000-0000-4000-8000-000000000002';
    const acknowledgementId = '00000000-0000-4000-8000-000000000003';
    const contextDigest = 'a'.repeat(64);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      turnId,
      kind: 'answer',
      contextRevision: 1,
      contextDigest,
      navigate: 'https://evil.invalid',
      responseId: 'resp_private',
      bob_response_nonce: 'provider-private',
    }), { headers: { 'content-type': 'application/json' } })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await expect(client.acknowledgeRealtimeVoiceControl(sessionHandle, {
      turnId,
      acknowledgementId,
      contextRevision: 1,
      contextDigest,
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('refuse avant réseau un contrôle qui ne provient pas d’un ACK audio durable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });

    await expect(client.acknowledgeRealtimeVoiceControl(
      '00000000-0000-4000-8000-000000000001',
      {
        turnId: '00000000-0000-4000-8000-000000000002',
        contextRevision: 1,
        contextDigest: 'a'.repeat(64),
      } as never,
    )).resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propage une annulation externe au bootstrap avant tout fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-1' });
    const controller = new AbortController();
    controller.abort();

    const result = await client.createRealtimeVoiceCall(
      { sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n' },
      controller.signal,
    );

    expect(result).toMatchObject({ ok: false, error: { kind: 'dependency', port: 'api' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
