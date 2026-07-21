import { describe, expect, it, vi } from 'vitest';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { type QuoteLine } from '../../domain/billing/shared/line';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { type InvoiceRepository } from '../ports/repositories';
import { PreviewPaymentAccountingEntry } from './preview-payment-accounting-entry';

const AT = '2026-06-01T10:00:00.000Z';
const ISSUED = '2026-06-01';
const terms = (() => {
  const r = PaymentTerms.of({ days: 30, endOfMonth: false, label: '30 jours' });
  if (!r.ok) throw new Error('terms');
  return r.value;
})();

const line: QuoteLine = { id: 'l1', label: 'Maintenance', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 };

function issuedInvoice(opts: { paid?: number } = {}): Invoice {
  const inv = Invoice.composeStandalone({ id: 'inv-1', companyId: 'co-1', customerId: 'cust-1' });
  if (!inv.ok) throw new Error('invoice');
  inv.value.addLine(line);
  inv.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
  inv.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' });
  if (opts.paid) inv.value.registerPayment(opts.paid, AT);
  return inv.value;
}

class MemoryInvoices implements InvoiceRepository {
  constructor(private readonly row: Invoice | null) {}

  async findById(id: string): Promise<Invoice | null> {
    return this.row?.id === id ? Invoice.rehydrate(this.row.toSnapshot()) : null;
  }

  async lockById(id: string): Promise<Invoice | null> {
    return this.findById(id);
  }

  async findByParentQuoteId(): Promise<Invoice | null> {
    return null;
  }

  async findCreditNoteBySourceInvoiceId(): Promise<Invoice | null> {
    return null;
  }

  async listByCompany(companyId: string): Promise<Invoice[]> {
    return this.row?.companyId === companyId ? [Invoice.rehydrate(this.row.toSnapshot())] : [];
  }

  async save(_invoice: Invoice): Promise<void> {
    throw new Error('not used');
  }

  async deleteById(_id: string): Promise<void> {
    throw new Error('not used');
  }
}

function useCase(
  invoice: Invoice | null,
  now: () => '2026-06-02T09:30:00.000Z' = () => '2026-06-02T09:30:00.000Z',
) {
  return new PreviewPaymentAccountingEntry({
    invoices: new MemoryInvoices(invoice),
    clock: { now, today: () => '2026-06-02' },
  });
}

describe('PreviewPaymentAccountingEntry', () => {
  it("preview les lignes d'encaissement par virement sans effet de bord", async () => {
    const invoice = issuedInvoice({ paid: 2000 });
    const now = vi.fn(() => '2026-06-02T09:30:00.000Z' as const);
    const r = await useCase(invoice, now).execute({ companyId: 'co-1', invoiceId: 'inv-1', amountCents: 10000, method: 'transfer' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.available).toBe(true);
    if (!r.value.available) return;
    expect(r.value.remainingCents).toBe(10000);
    expect(r.value.totalDebitCents).toBe(10000);
    expect(r.value.totalCreditCents).toBe(10000);
    expect(r.value.lines).toEqual([
      { account: '512', label: 'Encaissement F-2026-0001', debitCents: 10000, creditCents: 0 },
      { account: '411', label: 'Encaissement F-2026-0001', debitCents: 0, creditCents: 10000 },
    ]);
    expect(r.value).not.toHaveProperty('reason');
    expect(invoice.paid).toBe(2000);
    expect(now).toHaveBeenCalledOnce();
  });

  it("preview les especes sur le compte de caisse", async () => {
    const r = await useCase(issuedInvoice()).execute({ companyId: 'co-1', invoiceId: 'inv-1', amountCents: 12000, method: 'cash' });

    expect(r.ok).toBe(true);
    if (r.ok && r.value.available)
      expect(r.value.lines.map((line) => line.account)).toEqual(['530', '411']);
  });

  it('signale un surpaiement sans produire de lignes', async () => {
    const r = await useCase(issuedInvoice()).execute({ companyId: 'co-1', invoiceId: 'inv-1', amountCents: 12001, method: 'transfer' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.available).toBe(false);
    if (r.value.available) return;
    expect(r.value.reason).toContain('Paiement supérieur au reste dû');
    expect(r.value).toEqual({
      invoiceId: 'inv-1',
      available: false,
      reason: r.value.reason,
    });
    expect(r.value).not.toHaveProperty('amountCents');
    expect(r.value).not.toHaveProperty('remainingCents');
    expect(r.value).not.toHaveProperty('lines');
    expect(r.value).not.toHaveProperty('totalDebitCents');
    expect(r.value).not.toHaveProperty('totalCreditCents');
  });

  it('refuse un montant nul au lieu de produire un faux aperçu indisponible', async () => {
    const r = await useCase(issuedInvoice()).execute({
      companyId: 'co-1',
      invoiceId: 'inv-1',
      amountCents: 0,
      method: 'transfer',
    });

    expect(r).toEqual({
      ok: false,
      error: {
        kind: 'validation',
        issues: [
          {
            field: 'amountCents',
            message: 'Montant strictement positif requis en centimes entiers.',
          },
        ],
      },
    });
  });

  it('refuse une methode de paiement inconnue', async () => {
    const r = await useCase(issuedInvoice()).execute({
      companyId: 'co-1',
      invoiceId: 'inv-1',
      amountCents: 12000,
      method: 'cheque' as 'transfer',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'validation' });
  });

  it("ne divulgue pas une facture d'un autre tenant", async () => {
    const r = await useCase(issuedInvoice()).execute({ companyId: 'co-2', invoiceId: 'inv-1', amountCents: 12000, method: 'transfer' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'not_found', entity: 'invoice' });
  });
});
