import { describe, expect, it, vi, afterEach } from 'vitest';
import { decodeCreditNoteSource } from './credit-note-source-codec';
import { HttpBobClient } from './http-client';
import { LocalBobClient } from './local-client';
import { FixtureClock } from './in-memory/services';

/**
 * E3 — snapshot « facture annulée par cet avoir » (creditNoteSource) : codec défensif HTTP
 * (compat ascendante STRICTE : absent ⇒ null, présent difforme ⇒ échec fermé) + parité du
 * client local (le snapshot vient de l'agrégat, jamais recalculé côté écran).
 */

const SOURCE = {
  invoiceId: 'inv-42',
  kind: 'final',
  number: 'F-2026-0042',
  issuedAt: '2026-07-01',
} as const;

/** InvoiceView minimale telle que servie par GET /invoices — le codec n'exige que `id`. */
function wireInvoice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'inv-1', kind: 'final', status: 'issued', ...over };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('E3 — decodeCreditNoteSource (snapshot défensif)', () => {
  it('accepte le snapshot complet du domaine (invoiceId + kind crédité + numéro + date)', () => {
    expect(decodeCreditNoteSource(SOURCE)).toEqual(SOURCE);
  });

  it('rejette les snapshots difformes — jamais de cast silencieux', () => {
    expect(decodeCreditNoteSource({ ...SOURCE, invoiceId: '' })).toBeNull();
    expect(decodeCreditNoteSource({ ...SOURCE, invoiceId: undefined })).toBeNull();
    expect(decodeCreditNoteSource({ ...SOURCE, number: '  ' })).toBeNull();
    // Un avoir ne crédite jamais un avoir : kind hors {final, deposit, situation} = rupture.
    expect(decodeCreditNoteSource({ ...SOURCE, kind: 'credit_note' })).toBeNull();
    expect(decodeCreditNoteSource({ ...SOURCE, issuedAt: '01/07/2026' })).toBeNull();
    expect(decodeCreditNoteSource('F-2026-0042')).toBeNull();
  });
});

describe('E3 — HttpBobClient (normalisation compat ascendante + fail-closed)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getInvoice : serveur antérieur SANS creditNoteSource ⇒ null normalisé (jamais un échec)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(wireInvoice())));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });
    const r = await client.getInvoice('inv-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.creditNoteSource).toBeNull();
    // B8 déjà en place : la normalisation existante reste intacte.
    expect(r.value.purchaseOrder).toBeNull();
    expect(r.value.revision).toBe(1);
  });

  it('getInvoice : avoir avec snapshot VALIDE ⇒ creditNoteSource typé transmis tel quel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(wireInvoice({ id: 'avoir-1', kind: 'credit_note', creditNoteSource: SOURCE })),
      ),
    );
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });
    const r = await client.getInvoice('avoir-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.creditNoteSource).toEqual(SOURCE);
  });

  it('getInvoice : snapshot PRÉSENT mais difforme ⇒ échec fermé (rupture de contrat)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(wireInvoice({ creditNoteSource: { number: 'F-2026-0042' } })),
      ),
    );
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });
    const r = await client.getInvoice('inv-1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'dependency', port: 'api-contract' });
  });

  it('listInvoices : liste mixte normalisée ; UN élément difforme rompt tout le contrat', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          wireInvoice(),
          wireInvoice({ id: 'avoir-1', kind: 'credit_note', creditNoteSource: SOURCE }),
        ]),
      ),
    );
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'co-1' });
    const r = await client.listInvoices();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((i) => i.creditNoteSource)).toEqual([null, SOURCE]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([wireInvoice(), wireInvoice({ id: 'avoir-1', creditNoteSource: { kind: 'credit_note' } })]),
      ),
    );
    const failed = await new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'co-1',
    }).listInvoices();
    expect(failed.ok).toBe(false);
  });
});

describe('E3 — LocalBobClient (parité : le snapshot vient de l’agrégat)', () => {
  it('flux réel devis → facture émise → avoir : l’avoir expose SA facture d’origine', async () => {
    const client = new LocalBobClient({ clock: new FixtureClock('2026-06-01') });
    const created = await client.createQuote({
      customerId: 'cust-martin',
      lines: [{ label: 'Rénovation SDB', category: 'labor', qty: 1, unitPriceHT: 100_000, vatRate: 20 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const quoteId = created.value.quoteId;
    expect((await client.sendQuote(quoteId)).ok).toBe(true);
    expect((await client.signQuote({ quoteId, signerName: 'M. Martin' })).ok).toBe(true);
    const gen = await client.generateInvoice({ quoteId, mode: 'final' });
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const issued = await client.issueInvoice({ invoiceId: gen.value.invoiceId });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const credit = await client.createCreditNote({ invoiceId: gen.value.invoiceId });
    expect(credit.ok).toBe(true);
    if (!credit.ok) return;

    const creditView = await client.getInvoice(credit.value.creditNoteId);
    expect(creditView.ok).toBe(true);
    if (!creditView.ok) return;
    expect(creditView.value.creditNoteSource).toEqual({
      invoiceId: gen.value.invoiceId,
      kind: 'final',
      number: issued.value.number,
      issuedAt: '2026-06-01',
    });

    // Une pièce ordinaire reste sans snapshot — et la liste porte la même vérité que le détail.
    const sourceView = await client.getInvoice(gen.value.invoiceId);
    expect(sourceView.ok && sourceView.value.creditNoteSource).toBeNull();
    const list = await client.listInvoices();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const listedCredit = list.value.find((i) => i.id === credit.value.creditNoteId);
    expect(listedCredit?.creditNoteSource?.invoiceId).toBe(gen.value.invoiceId);
  });
});
