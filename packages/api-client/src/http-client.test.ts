import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, JournalEntry, PendingAction } from '@bob/ai';
import { HttpBobClient } from './http-client';

describe('HttpBobClient', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
        expect(JSON.parse(String(init?.body))).toEqual({ expoPushToken: 'ExponentPushToken[abc]', platform: 'ios' });
        return new Response(JSON.stringify({ id: 'dev-1' }), { headers: { 'content-type': 'application/json' } });
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

    const device = await client.registerDevice({ expoPushToken: 'ExponentPushToken[abc]', platform: 'ios' });
    expect(device.ok && device.value).toEqual({ id: 'dev-1' });
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('décode strictement la capacité et négocie le SDP via le backend authentifié', async () => {
    const answerSdp = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
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
        }), { headers: { 'content-type': 'application/json' } });
      }
      expect(String(url)).toBe('https://api.bob.test/voice/realtime/calls');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n' });
      return new Response(JSON.stringify({
        transport: 'webrtc',
        answerSdp,
        model: 'gpt-realtime-2.1',
        voice: 'marin',
        configVersion: 'bob-live-webrtc-v1',
        maxSessionSeconds: 900,
      }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-1',
      getToken: async () => 'supabase-jwt',
    });

    const config = await client.realtimeVoiceConfig();
    const call = await client.createRealtimeVoiceCall({ sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n' });

    expect(config).toMatchObject({ ok: true, value: { available: true, transport: 'webrtc' } });
    expect(call).toMatchObject({ ok: true, value: { answerSdp } });
    if (call.ok) expect(call.value).not.toHaveProperty('callId');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer supabase-jwt' });
  });

  it('refuse une réponse qui tente d’exposer un call_id fournisseur au mobile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      transport: 'webrtc',
      answerSdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n',
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
});
