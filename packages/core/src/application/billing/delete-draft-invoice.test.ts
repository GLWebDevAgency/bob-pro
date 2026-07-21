import { describe, expect, it } from 'vitest';
import { DeleteDraftInvoice } from './delete-draft-invoice';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { type InvoiceRepository } from '../ports/repositories';

const AT = '2026-06-01T10:00:00.000Z';
const terms = (() => {
  const t = PaymentTerms.of({ days: 30, endOfMonth: false, label: 'Paiement a 30 jours' });
  if (!t.ok) throw new Error('terms');
  return t.value;
})();

function draftInvoice(): Invoice {
  const created = Invoice.composeStandalone({ id: 'inv-1', companyId: 'co-1', customerId: 'cust-1' });
  if (!created.ok) throw new Error('compose');
  created.value.addLine({ id: 'line-1', label: 'Prestation', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 });
  return created.value;
}

function issuedInvoice(): Invoice {
  const inv = draftInvoice();
  inv.assignNumber(DocNumber.format('F', 2026, 1), AT);
  const issued = inv.issue({ mentions: [], terms, issuedAt: '2026-06-01', at: AT, frenchBillingMode: 'S1' });
  if (!issued.ok) throw new Error('issue');
  return inv;
}

function makeDeps(invoice: Invoice | null, lockedInvoice: Invoice | null = invoice) {
  let deletes = 0;
  let transactions = 0;
  const invoices: InvoiceRepository = {
    findById: async () => invoice,
    lockById: async () => lockedInvoice,
    findByParentQuoteId: async () => null,
    findCreditNoteBySourceInvoiceId: async () => null,
    listByCompany: async () => [],
    save: async () => {},
    deleteById: async () => {
      deletes++;
    },
  };
  const uow = {
    runInTransaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      transactions++;
      return fn();
    },
  };
  return { deps: { invoices, uow }, counts: () => ({ deletes, transactions }) };
}

describe('DeleteDraftInvoice', () => {
  it('supprime une facture brouillon', async () => {
    const invoice = draftInvoice();
    const { deps, counts } = makeDeps(invoice);
    const r = await new DeleteDraftInvoice(deps).execute({ invoiceId: invoice.id });

    expect(r).toEqual({ ok: true, value: { deleted: true } });
    expect(counts()).toEqual({ deletes: 1, transactions: 1 });
  });

  it('conflict sur une facture non brouillon (émise)', async () => {
    const invoice = issuedInvoice();
    const { deps, counts } = makeDeps(invoice);
    const r = await new DeleteDraftInvoice(deps).execute({ invoiceId: invoice.id });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual({
        kind: 'conflict',
        entity: 'invoice',
        reason: 'Seule une facture brouillon peut être supprimée.',
      });
    }
    expect(counts()).toEqual({ deletes: 0, transactions: 1 });
  });

  it('introuvable -> not_found (aucune transaction ouverte)', async () => {
    const { deps, counts } = makeDeps(null);
    const r = await new DeleteDraftInvoice(deps).execute({ invoiceId: 'missing' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'not_found', entity: 'invoice', id: 'missing' });
    expect(counts()).toEqual({ deletes: 0, transactions: 0 });
  });

  it('course : verrouillage renvoie null (supprimée entre-temps) -> not_found', async () => {
    const invoice = draftInvoice();
    const { deps, counts } = makeDeps(invoice, null);
    const r = await new DeleteDraftInvoice(deps).execute({ invoiceId: invoice.id });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'not_found', entity: 'invoice', id: invoice.id });
    expect(counts()).toEqual({ deletes: 0, transactions: 1 });
  });
});
