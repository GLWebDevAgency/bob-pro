import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, JournalEntry, PendingAction } from '@bob/ai';
import { HttpBobClient } from './http-client';

describe('HttpBobClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
    },
  };

  it('askBob POSTe /ai/ask (message + autonomie demandée) et rend l’AgentRun du serveur tel quel', async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.bob.test/ai/ask') {
        expect(init?.method).toBe('POST');
        const headers = init?.headers as Record<string, string>;
        expect(headers['x-company-id']).toBe('company-mercier');
        expect(headers.authorization).toBe('Bearer test-token');
        expect(JSON.parse(String(init?.body))).toEqual({ message: 'encaisse la facture 2026-014', autonomy: 'confirm_all' });
        return new Response(JSON.stringify(proposedRun), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { kind: 'not_found', resource: 'route' } }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-mercier', getToken: async () => 'test-token' });
    const r = await client.askBob({ message: 'encaisse la facture 2026-014', autonomy: 'confirm_all' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.value).toEqual(proposedRun);
    expect(r.value.pending?.tool).toBe('encaisser_facture'); // rejouable tel quel via confirmBob
  });

  it('confirmBob POSTe la PendingAction telle quelle sur /ai/confirm et rend le run « done »', async () => {
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
        expect(JSON.parse(String(init?.body))).toEqual(pending);
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
});

