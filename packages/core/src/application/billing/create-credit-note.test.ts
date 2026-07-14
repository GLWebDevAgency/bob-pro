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
    frozenTotals: null,
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
    listByCompany: async (companyId) => [...invoices.values()].filter((i) => i.companyId === companyId),
    save: async (i) => void invoices.set(i.id, i),
    deleteById: async (id) => void invoices.delete(id),
  };
  return { repo, usecase: new CreateCreditNote({ invoices: repo, ids: { newId: () => `cn-${++n}` } }) };
}

describe('CreateCreditNote (A6 — avoir total en brouillon)', () => {
  it('crée l’avoir : mêmes lignes, kind credit_note, même devis parent, statut brouillon', async () => {
    const env = makeEnv([snapshot()]);
    const r = await env.usecase.execute({ invoiceId: 'inv-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cn = await env.repo.findById(r.value.creditNoteId);
    expect(cn?.kind).toBe('credit_note');
    expect(cn?.status).toBe('draft');
    expect(cn?.parentQuoteId).toBe('quote-1');
    expect(cn?.totals().ttc).toBe(120000); // montant SIGNÉ à l'affichage (buildPieceView : −)
  });

  it('idempotent : un avoir existant sur le même devis est retourné, pas doublé', async () => {
    const env = makeEnv([snapshot()]);
    const first = await env.usecase.execute({ invoiceId: 'inv-1' });
    const replay = await env.usecase.execute({ invoiceId: 'inv-1' });
    expect(first.ok && replay.ok && replay.value.creditNoteId).toBe(first.ok ? first.value.creditNoteId : null);
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
