import { describe, expect, it, vi, afterEach } from 'vitest';
import { HttpBobClient } from './http-client';
import { LocalBobClient } from './local-client';
import { FixtureClock } from './in-memory/services';

/**
 * B8 — bon de commande grands comptes (numéro d'engagement) : parité STRICTE des clients.
 * HttpBobClient frappe EXACTEMENT les routes servies avec le corps exact et décode fail-closed ;
 * LocalBobClient exécute les MÊMES use cases core que le serveur (AttachPurchaseOrderToQuote &
 * co.) — mêmes règles, mêmes conflits, même reprise devis → facture.
 */

function makeLocalClient(): LocalBobClient {
  return new LocalBobClient({ clock: new FixtureClock('2026-06-01') });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}

async function signedQuoteId(client: LocalBobClient): Promise<string> {
  const created = await client.createQuote({
    customerId: 'cust-martin',
    lines: [{ label: 'Rénovation hall', category: 'labor', qty: 1, unitPriceHT: 250_000, vatRate: 20 }],
  });
  if (!created.ok) throw new Error('createQuote failed');
  const quoteId = created.value.quoteId;
  if (!(await client.sendQuote(quoteId)).ok) throw new Error('sendQuote failed');
  if (!(await client.signQuote({ quoteId, signerName: 'Mme Responsable Achats' })).ok)
    throw new Error('signQuote failed');
  return quoteId;
}

describe('B8 — parité des clients (méthodes bon de commande)', () => {
  it('HttpBobClient et LocalBobClient exposent TOUTES les méthodes bon de commande', () => {
    const http = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });
    const local = makeLocalClient();
    for (const method of [
      'attachQuotePurchaseOrder',
      'detachQuotePurchaseOrder',
      'attachInvoicePurchaseOrder',
      'detachInvoicePurchaseOrder',
    ] as const) {
      expect(typeof http[method], `HttpBobClient.${method}`).toBe('function');
      expect(typeof local[method], `LocalBobClient.${method}`).toBe('function');
    }
  });
});

describe('B8 — HttpBobClient (routes exactes + codecs défensifs)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attachQuotePurchaseOrder : PUT /quotes/:id/purchase-order avec le corps plat exact', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(url).toBe('https://api.bob.test/quotes/q-1/purchase-order');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({
        number: 'BC-RATP-4712',
        receivedAt: '2026-07-10T00:00:00.000Z',
        documentId: null,
        expectedRevision: 1,
      });
      return jsonResponse({
        targetType: 'quote',
        targetId: 'q-1',
        revision: 2,
        purchaseOrder: { number: 'BC-RATP-4712', receivedAt: '2026-07-10T00:00:00.000Z', documentId: null },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });

    await expect(
      client.attachQuotePurchaseOrder({
        quoteId: 'q-1',
        purchaseOrder: { number: 'BC-RATP-4712', receivedAt: '2026-07-10T00:00:00.000Z', documentId: null },
        expectedRevision: 1,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        targetType: 'quote',
        targetId: 'q-1',
        revision: 2,
        purchaseOrder: { number: 'BC-RATP-4712', receivedAt: '2026-07-10T00:00:00.000Z', documentId: null },
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('detachInvoicePurchaseOrder : DELETE /invoices/:id/purchase-order, seule la révision voyage', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(url).toBe('https://api.bob.test/invoices/inv-9/purchase-order');
      expect(init?.method).toBe('DELETE');
      expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 3 });
      return jsonResponse({ targetType: 'invoice', targetId: 'inv-9', revision: 4, purchaseOrder: null });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });

    await expect(
      client.detachInvoicePurchaseOrder({ invoiceId: 'inv-9', expectedRevision: 3 }),
    ).resolves.toEqual({
      ok: true,
      value: { targetType: 'invoice', targetId: 'inv-9', revision: 4, purchaseOrder: null },
    });
  });

  it('rejette une réponse mutation 2xx malformée (révision 0, mauvais id) — jamais de cast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ targetType: 'quote', targetId: 'autre-devis', revision: 0, purchaseOrder: null }),
      ),
    );
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });
    const r = await client.attachQuotePurchaseOrder({
      quoteId: 'q-1',
      purchaseOrder: { number: 'BC-1' },
      expectedRevision: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'dependency', port: 'api-contract' });
  });

  it('getQuote : serveur antérieur à B8 (champs absents) ⇒ purchaseOrder null + revision 1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ id: 'q-1', companyId: 'co-1', customerId: 'cust-1', status: 'signed' }),
      ),
    );
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });
    const r = await client.getQuote('q-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.purchaseOrder).toBeNull();
    expect(r.value.revision).toBe(1);
  });

  it('listInvoices : purchaseOrder présent transmis tel quel, absent normalisé à null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          {
            id: 'inv-1',
            purchaseOrder: { number: 'BC-77', receivedAt: null, documentId: 'doc-9' },
            revision: 2,
          },
          { id: 'inv-2' },
        ]),
      ),
    );
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });
    const r = await client.listInvoices();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]?.purchaseOrder).toEqual({ number: 'BC-77', receivedAt: null, documentId: 'doc-9' });
    expect(r.value[0]?.revision).toBe(2);
    expect(r.value[1]?.purchaseOrder).toBeNull();
    expect(r.value[1]?.revision).toBe(1);
  });

  it('échoue fermé sur un purchaseOrder PRÉSENT mais difforme (rupture de contrat)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: 'q-1', purchaseOrder: { number: '' } })),
    );
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });
    const r = await client.getQuote('q-1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'dependency', port: 'api-contract' });
  });
});

describe('B8 — LocalBobClient (mêmes use cases core que le serveur)', () => {
  it('attache sur devis signé, reprend sur la facture dérivée, puis dirige vers la facture', async () => {
    const client = makeLocalClient();
    const quoteId = await signedQuoteId(client);

    // Attache : révision 1 → 2, référence assainie (espaces normalisés par le domaine).
    const attached = await client.attachQuotePurchaseOrder({
      quoteId,
      purchaseOrder: { number: '  BC  RATP-4712 ', receivedAt: '2026-07-10T00:00:00.000Z' },
      expectedRevision: 1,
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.value).toMatchObject({
      targetType: 'quote',
      targetId: quoteId,
      revision: 2,
      purchaseOrder: {
        number: 'BC RATP-4712',
        receivedAt: '2026-07-10T00:00:00.000Z',
        documentId: null,
      },
    });

    const quote = await client.getQuote(quoteId);
    expect(quote.ok && quote.value.purchaseOrder?.number).toBe('BC RATP-4712');
    expect(quote.ok && quote.value.revision).toBe(2);

    // Reprise AUTOMATIQUE devis → facture (source unique : jamais re-saisi).
    const generated = await client.generateInvoice({ quoteId, mode: 'final' });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const invoice = await client.getInvoice(generated.value.invoiceId);
    expect(invoice.ok && invoice.value.purchaseOrder?.number).toBe('BC RATP-4712');

    // Devis déjà facturé : l'attache est dirigée vers la facture (conflit explicite).
    const rejected = await client.attachQuotePurchaseOrder({
      quoteId,
      purchaseOrder: { number: 'BC-AUTRE' },
      expectedRevision: 2,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.kind).toBe('conflict');

    // La facture BROUILLON reste la source modifiable : retrait explicite possible.
    const detached = await client.detachInvoicePurchaseOrder({
      invoiceId: generated.value.invoiceId,
      expectedRevision: 1,
    });
    expect(detached.ok).toBe(true);
    if (!detached.ok) return;
    expect(detached.value.purchaseOrder).toBeNull();
    expect(detached.value.revision).toBe(2);
  });

  it('révision périmée ⇒ conflit (parité serveur), l’état courant reste inchangé', async () => {
    const client = makeLocalClient();
    const quoteId = await signedQuoteId(client);
    const attached = await client.attachQuotePurchaseOrder({
      quoteId,
      purchaseOrder: { number: 'BC-1' },
      expectedRevision: 1,
    });
    expect(attached.ok).toBe(true);

    const stale = await client.attachQuotePurchaseOrder({
      quoteId,
      purchaseOrder: { number: 'BC-2' },
      expectedRevision: 1,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.kind).toBe('conflict');

    const quote = await client.getQuote(quoteId);
    expect(quote.ok && quote.value.purchaseOrder?.number).toBe('BC-1');
    expect(quote.ok && quote.value.revision).toBe(2);
  });

  it('listInvoiceableQuotes (gateway Bob) expose le bon de commande AVANT émission — use case core unique', async () => {
    const client = makeLocalClient();
    const quoteId = await signedQuoteId(client);
    const attached = await client.attachQuotePurchaseOrder({
      quoteId,
      purchaseOrder: { number: 'BC-CHORUS-001' },
      expectedRevision: 1,
    });
    expect(attached.ok).toBe(true);

    // Accès test au gateway agent (méthode privée) : la parité passe par la MÊME surface
    // d'actions que le serveur — le use case core est la source unique.
    const actions = (
      client as unknown as {
        bobActions(): {
          listInvoiceableQuotes?: () => Promise<
            | { ok: true; value: { id: string; purchaseOrder?: { number: string } | null }[] }
            | { ok: false; error: unknown }
          >;
        };
      }
    ).bobActions();
    if (!actions.listInvoiceableQuotes) throw new Error('gateway listInvoiceableQuotes absent');
    const invoiceable = await actions.listInvoiceableQuotes();
    expect(invoiceable.ok).toBe(true);
    if (!invoiceable.ok) return;
    const entry = invoiceable.value.find((q) => q.id === quoteId);
    expect(entry).toBeDefined();
    expect(entry?.purchaseOrder?.number).toBe('BC-CHORUS-001');
  });
});
