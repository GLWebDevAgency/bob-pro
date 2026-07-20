import { describe, expect, it } from 'vitest';
import { CreateCreditNote } from './create-credit-note';
import { Invoice, type InvoiceSnapshot } from '../../domain/billing/invoice/invoice';
import { type InvoiceRepository } from '../ports/repositories';

function snapshot(over: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    id: 'inv-1',
    companyId: 'co-1',
    customerId: 'cus-1',
    kind: 'final',
    status: 'issued',
    lines: [{ id: 'l1', label: 'Intervention', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 }],
    number: 'F-2026-0001',
    frozenTotals: { ht: 100000, vatByRate: { '20': 20000 }, vat: 20000, ttc: 120000, netToPay: 120000 },
    mentions: [],
    issuedAt: '2026-06-10',
    dueAt: '2026-07-10',
    paid: 0,
    depositPct: null,
    parentQuoteId: 'quote-1',
    ...over,
  };
}

function makeEnv(seed: InvoiceSnapshot[]) {
  const invoices = new Map(seed.map((s) => [s.id, Invoice.rehydrate(s)]));
  let n = 0;
  const repo: InvoiceRepository = {
    findById: async (id) => invoices.get(id) ?? null,
    lockById: async (id) => invoices.get(id) ?? null,
    findByParentQuoteId: async (companyId, parentQuoteId, kind) =>
      [...invoices.values()].find(
        (i) => i.companyId === companyId && i.parentQuoteId === parentQuoteId && i.kind === kind,
      ) ?? null,
    findCreditNoteBySourceInvoiceId: async (companyId, sourceInvoiceId) =>
      [...invoices.values()].find(
        (i) => i.companyId === companyId && i.kind === 'credit_note' && i.creditNoteSource?.invoiceId === sourceInvoiceId,
      ) ?? null,
    listByCompany: async (companyId) => [...invoices.values()].filter((i) => i.companyId === companyId),
    save: async (i) => void invoices.set(i.id, i),
    deleteById: async (id) => void invoices.delete(id),
  };
  return { repo, usecase: new CreateCreditNote({ invoices: repo, ids: { newId: () => `cn-${++n}` } }) };
}

describe('CreateCreditNote (A6 — avoir total en brouillon)', () => {
  it('crée l’avoir : mêmes lignes, source légale exacte, même devis parent, statut brouillon', async () => {
    const env = makeEnv([snapshot()]);
    const r = await env.usecase.execute({ invoiceId: 'inv-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cn = await env.repo.findById(r.value.creditNoteId);
    expect(cn?.kind).toBe('credit_note');
    expect(cn?.status).toBe('draft');
    expect(cn?.parentQuoteId).toBe('quote-1');
    expect(cn?.creditNoteSource).toEqual({
      invoiceId: 'inv-1',
      kind: 'final',
      number: 'F-2026-0001',
      issuedAt: '2026-06-10',
    });
    expect(cn?.totals().ttc).toBe(120000); // montant SIGNÉ à l'affichage (buildPieceView : −)
  });

  it('idempotent : un avoir existant sur la même facture source est retourné, pas doublé', async () => {
    const env = makeEnv([snapshot()]);
    const first = await env.usecase.execute({ invoiceId: 'inv-1' });
    const replay = await env.usecase.execute({ invoiceId: 'inv-1' });
    expect(first.ok && replay.ok && replay.value.creditNoteId).toBe(first.ok ? first.value.creditNoteId : null);
  });

  it('autorise deux avoirs pour deux factures distinctes du même devis sans collision', async () => {
    const env = makeEnv([
      snapshot({ id: 'inv-deposit', kind: 'deposit', number: 'F-2026-0001' }),
      snapshot({ id: 'inv-final', kind: 'final', number: 'F-2026-0002' }),
    ]);

    const depositCredit = await env.usecase.execute({ invoiceId: 'inv-deposit' });
    const finalCredit = await env.usecase.execute({ invoiceId: 'inv-final' });

    expect(depositCredit.ok).toBe(true);
    expect(finalCredit.ok).toBe(true);
    if (!depositCredit.ok || !finalCredit.ok) return;
    expect(finalCredit.value.creditNoteId).not.toBe(depositCredit.value.creditNoteId);
    expect((await env.repo.findById(depositCredit.value.creditNoteId))?.creditNoteSource?.invoiceId).toBe('inv-deposit');
    expect((await env.repo.findById(finalCredit.value.creditNoteId))?.creditNoteSource?.invoiceId).toBe('inv-final');
  });

  it('refuse un avoir sur un brouillon (se corrige) et sur un avoir (ne s’avoirise pas)', async () => {
    const env = makeEnv([
      snapshot({ id: 'inv-draft', status: 'draft', number: null }),
      snapshot({ id: 'inv-cn', kind: 'credit_note', parentQuoteId: null }),
    ]);
    const onDraft = await env.usecase.execute({ invoiceId: 'inv-draft' });
    expect(onDraft.ok).toBe(false);
    const onCreditNote = await env.usecase.execute({ invoiceId: 'inv-cn' });
    expect(onCreditNote.ok).toBe(false);
  });
});
