import { describe, expect, it } from 'vitest';
import { CreateDocumentViewLink } from './create-document-view-link';
import { type Quote } from '../../domain/billing/quote/quote';
import { type Invoice } from '../../domain/billing/invoice/invoice';
import { type QuoteRepository, type InvoiceRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';

const clock = { now: () => '2026-06-30T00:00:00.000Z', today: () => '2026-06-30' };

function quote(status: string, companyId = 'co-1'): Quote {
  return { id: 'quote-1', companyId, status } as unknown as Quote;
}

function invoice(number: string | null, issuedAt: string | null, companyId = 'co-1'): Invoice {
  return { id: 'invoice-1', companyId, number, issuedAt } as unknown as Invoice;
}

function makeDeps(q: Quote | null, inv: Invoice | null) {
  let tokenCreates = 0;
  let revokeActiveCalls = 0;
  let lastCreateInput: unknown = null;
  let lastRevokeInput: unknown = null;
  const quotes: QuoteRepository = {
    findById: async () => q,
    lockById: async () => q,
    listByCompany: async () => [],
    save: async () => undefined,
  };
  const invoices: InvoiceRepository = {
    findById: async () => inv,
    lockById: async () => inv,
    findByParentQuoteId: async () => null,
    findCreditNoteBySourceInvoiceId: async () => null,
    listByCompany: async () => [],
    save: async () => undefined,
    deleteById: async () => undefined,
  };
  const publicAccessTokens: PublicAccessTokenRepository = {
    create: async (input) => {
      tokenCreates++;
      lastCreateInput = input;
      return { id: 'grant-1', token: 'pdv_token' };
    },
    findActive: async () => null,
    markUsed: async () => undefined,
    revoke: async () => undefined,
    revokeActiveFor: async (input) => {
      revokeActiveCalls++;
      lastRevokeInput = input;
    },
    revokeAllForCompany: async () => undefined,
  };
  return {
    deps: { quotes, invoices, publicAccessTokens, clock },
    counts: () => ({ tokenCreates, revokeActiveCalls }),
    lastCreateInput: () => lastCreateInput,
    lastRevokeInput: () => lastRevokeInput,
  };
}

describe('CreateDocumentViewLink — devis', () => {
  it('crée un lien pour un devis envoyé (sent)', async () => {
    const { deps, counts, lastCreateInput } = makeDeps(quote('sent'), null);
    const r = await new CreateDocumentViewLink(deps).execute({ kind: 'quote', id: 'quote-1' });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.token).toBe('pdv_token');
    expect(counts()).toEqual({ tokenCreates: 1, revokeActiveCalls: 1 });
    expect(lastCreateInput()).toMatchObject({
      companyId: 'co-1',
      resourceType: 'quote',
      resourceId: 'quote-1',
      scope: 'document_view',
    });
  });

  it.each(['viewed', 'signed', 'refused', 'expired'])(
    'crée un lien pour un devis %s (tout statut sauf brouillon = consultable)',
    async (status) => {
      const { deps, counts } = makeDeps(quote(status), null);
      const r = await new CreateDocumentViewLink(deps).execute({ kind: 'quote', id: 'quote-1' });
      expect(r.ok).toBe(true);
      expect(counts().tokenCreates).toBe(1);
    },
  );

  it('rejette un devis brouillon', async () => {
    const { deps, counts } = makeDeps(quote('draft'), null);
    const r = await new CreateDocumentViewLink(deps).execute({ kind: 'quote', id: 'quote-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toEqual({ tokenCreates: 0, revokeActiveCalls: 0 });
  });

  it('rejette un devis introuvable', async () => {
    const { deps, counts } = makeDeps(null, null);
    const r = await new CreateDocumentViewLink(deps).execute({ kind: 'quote', id: 'quote-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
    expect(counts()).toEqual({ tokenCreates: 0, revokeActiveCalls: 0 });
  });

  it('expiration par défaut = 30 jours, configurable via ttlDays', async () => {
    const { deps: deps30 } = makeDeps(quote('sent'), null);
    const r30 = await new CreateDocumentViewLink(deps30).execute({ kind: 'quote', id: 'quote-1' });
    expect(r30.ok && r30.value.expiresAt).toBe('2026-07-30T00:00:00.000Z');

    const { deps: deps7 } = makeDeps(quote('sent'), null);
    const r7 = await new CreateDocumentViewLink(deps7).execute({ kind: 'quote', id: 'quote-1', ttlDays: 7 });
    expect(r7.ok && r7.value.expiresAt).toBe('2026-07-07T00:00:00.000Z');
  });
});

describe('CreateDocumentViewLink — facture', () => {
  it('crée un lien pour une facture ÉMISE (number + issuedAt renseignés)', async () => {
    const { deps, counts, lastCreateInput } = makeDeps(null, invoice('F-2026-0001', '2026-06-01'));
    const r = await new CreateDocumentViewLink(deps).execute({ kind: 'invoice', id: 'invoice-1' });

    expect(r.ok).toBe(true);
    expect(counts()).toEqual({ tokenCreates: 1, revokeActiveCalls: 1 });
    expect(lastCreateInput()).toMatchObject({
      companyId: 'co-1',
      resourceType: 'invoice',
      resourceId: 'invoice-1',
      scope: 'document_view',
    });
  });

  it('rejette une facture BROUILLON (jamais numérotée)', async () => {
    const { deps, counts } = makeDeps(null, invoice(null, null));
    const r = await new CreateDocumentViewLink(deps).execute({ kind: 'invoice', id: 'invoice-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toEqual({ tokenCreates: 0, revokeActiveCalls: 0 });
  });

  it('rejette une facture avec un numéro mais sans date d’émission (état incohérent)', async () => {
    const { deps, counts } = makeDeps(null, invoice('F-2026-0001', null));
    const r = await new CreateDocumentViewLink(deps).execute({ kind: 'invoice', id: 'invoice-1' });

    expect(r.ok).toBe(false);
    expect(counts()).toEqual({ tokenCreates: 0, revokeActiveCalls: 0 });
  });

  it('rejette une facture introuvable', async () => {
    const { deps, counts } = makeDeps(null, null);
    const r = await new CreateDocumentViewLink(deps).execute({ kind: 'invoice', id: 'invoice-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
    expect(counts()).toEqual({ tokenCreates: 0, revokeActiveCalls: 0 });
  });
});
