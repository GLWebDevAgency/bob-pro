import { describe, expect, it } from 'vitest';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { Quote } from '../../domain/billing/quote/quote';
import { type QuoteLine } from '../../domain/billing/shared/line';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { type AccountingEntry } from '../../domain/accounting/accounting-entry';
import { createFrenchOperationalChartOfAccounts, type ChartOfAccounts } from '../../domain/accounting/chart-of-accounts';
import { Payment } from '../../domain/payment/payment';
import { type InvoiceRepository, type PaymentRepository } from '../ports/repositories';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';
import { paymentAccountingEntryId, RecordPaymentAccountingEntry } from './record-payment-accounting-entry';

const AT = '2026-06-01T10:00:00.000Z';
const PAID_AT = '2026-06-07T15:30:00.000Z';
const ISSUED = '2026-06-01';
const terms = (() => {
  const r = PaymentTerms.of({ days: 30, endOfMonth: false, label: '30 jours' });
  if (!r.ok) throw new Error('terms');
  return r.value;
})();

const lines: QuoteLine[] = [
  { id: 'l1', label: 'Chauffe-eau', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
  { id: 'l2', label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
];

function signedQuote(): Quote {
  const q = Quote.compose({ id: 'q1', companyId: 'co-1', customerId: 'customer-1', at: AT });
  if (!q.ok) throw new Error('quote');
  for (const line of lines) q.value.addLine(line);
  q.value.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.value.send(AT);
  q.value.sign({ signerName: 'Durand', signedAt: AT, method: 'draw', accepted: true }, AT);
  return q.value;
}

function invoice(): Invoice {
  const inv = Invoice.fromSignedQuote(signedQuote(), 'final', 'inv-1');
  if (!inv.ok) throw new Error('invoice');
  inv.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
  inv.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT });
  return inv.value;
}

function payment() {
  const p = Payment.record({
    id: 'pay-1',
    companyId: 'co-1',
    invoiceId: 'inv-1',
    amount: 48840,
    method: 'transfer',
    receivedAt: PAID_AT,
    idempotencyKey: 'k1',
  });
  if (!p.ok) throw new Error('payment');
  return p.value;
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

  async listByCompany(companyId: string): Promise<Invoice[]> {
    return this.row?.companyId === companyId ? [Invoice.rehydrate(this.row.toSnapshot())] : [];
  }

  async save(_invoice: Invoice): Promise<void> {
    throw new Error('not used');
  }
}

class MemoryPayments implements PaymentRepository {
  constructor(private readonly row = payment()) {}

  async save(_payment: Payment): Promise<void> {
    throw new Error('not used');
  }

  async findById(companyId: string, id: string): Promise<Payment | null> {
    return this.row.companyId === companyId && this.row.id === id ? this.row : null;
  }

  async listByInvoice(invoiceId: string): Promise<Payment[]> {
    return this.row.invoiceId === invoiceId ? [this.row] : [];
  }

  async findByIdempotencyKey(companyId: string, key: string): Promise<Payment | null> {
    return this.row.companyId === companyId && this.row.idempotencyKey === key ? this.row : null;
  }
}

class MemoryEntries implements AccountingEntryRepository {
  saved: AccountingEntry[] = [];

  async save(entry: AccountingEntry): Promise<void> {
    this.saved.push(entry);
  }

  async findById(companyId: string, id: string): Promise<AccountingEntry | null> {
    return this.saved.find((entry) => entry.companyId === companyId && entry.id === id) ?? null;
  }

  async listByCompany(companyId: string): Promise<AccountingEntry[]> {
    return this.saved.filter((entry) => entry.companyId === companyId);
  }
}

class MemoryCharts implements ChartOfAccountsRepository {
  constructor(private readonly chart: ChartOfAccounts | null) {}

  async save(_chart: ChartOfAccounts): Promise<void> {
    throw new Error('not used');
  }

  async findByCompany(companyId: string): Promise<ChartOfAccounts | null> {
    return this.chart?.companyId === companyId ? this.chart : null;
  }
}

describe('RecordPaymentAccountingEntry', () => {
  it("poste l'ecriture definitive d'un encaissement", async () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    const entries = new MemoryEntries();
    const useCase = new RecordPaymentAccountingEntry({
      invoices: new MemoryInvoices(invoice()),
      payments: new MemoryPayments(),
      entries,
      charts: new MemoryCharts(chart.ok ? chart.value : null),
    });

    const r = await useCase.execute({ companyId: 'co-1', paymentId: 'pay-1' });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        id: paymentAccountingEntryId('pay-1'),
        created: true,
        totalDebitCents: 48840,
        totalCreditCents: 48840,
      });
    }
    expect(entries.saved).toHaveLength(1);
    expect(entries.saved[0]?.lines.map((line) => line.account)).toEqual(['512', '411']);
  });

  it('est idempotent sur retry', async () => {
    const entries = new MemoryEntries();
    const useCase = new RecordPaymentAccountingEntry({
      invoices: new MemoryInvoices(invoice()),
      payments: new MemoryPayments(),
      entries,
    });

    const first = await useCase.execute({ companyId: 'co-1', paymentId: 'pay-1' });
    const second = await useCase.execute({ companyId: 'co-1', paymentId: 'pay-1' });

    expect(first.ok && first.value.created).toBe(true);
    expect(second.ok && second.value.created).toBe(false);
    expect(entries.saved).toHaveLength(1);
  });

  it('renvoie not_found quand le paiement appartient a un autre tenant', async () => {
    const entries = new MemoryEntries();
    const useCase = new RecordPaymentAccountingEntry({
      invoices: new MemoryInvoices(invoice()),
      payments: new MemoryPayments(),
      entries,
    });

    const r = await useCase.execute({ companyId: 'co-2', paymentId: 'pay-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'not_found', entity: 'payment' });
    expect(entries.saved).toHaveLength(0);
  });
});
