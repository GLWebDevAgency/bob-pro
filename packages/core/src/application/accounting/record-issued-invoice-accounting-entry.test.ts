import { describe, expect, it } from 'vitest';
import { Invoice, type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { Quote } from '../../domain/billing/quote/quote';
import { type QuoteLine } from '../../domain/billing/shared/line';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { type AccountingEntry } from '../../domain/accounting/accounting-entry';
import { createFrenchOperationalChartOfAccounts, type ChartOfAccounts } from '../../domain/accounting/chart-of-accounts';
import { type InvoiceRepository } from '../ports/repositories';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';
import { RecordIssuedInvoiceAccountingEntry, issuedInvoiceAccountingEntryId } from './record-issued-invoice-accounting-entry';

const AT = '2026-06-01T10:00:00.000Z';
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

function invoice(kind: Extract<InvoiceKind, 'final' | 'deposit'> = 'final', issued = true): Invoice {
  const inv = Invoice.fromSignedQuote(signedQuote(), kind, 'inv-1');
  if (!inv.ok) throw new Error('invoice');
  if (issued) {
    inv.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
    inv.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT });
  }
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

  async listByCompany(companyId: string): Promise<Invoice[]> {
    return this.row?.companyId === companyId ? [Invoice.rehydrate(this.row.toSnapshot())] : [];
  }

  async save(_invoice: Invoice): Promise<void> {
    throw new Error('not used');
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

describe('RecordIssuedInvoiceAccountingEntry', () => {
  it("poste l'ecriture definitive d'une facture emise", async () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    const entries = new MemoryEntries();
    const useCase = new RecordIssuedInvoiceAccountingEntry({
      invoices: new MemoryInvoices(invoice()),
      entries,
      charts: new MemoryCharts(chart.ok ? chart.value : null),
    });

    const r = await useCase.execute({ invoiceId: 'inv-1' });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        id: issuedInvoiceAccountingEntryId('inv-1'),
        created: true,
        totalDebitCents: 162800,
        totalCreditCents: 162800,
      });
    }
    expect(entries.saved).toHaveLength(1);
    expect(entries.saved[0]?.lines.map((line) => line.account)).toEqual(['411', '707', '706', '44571']);
  });

  it('est idempotent sur retry', async () => {
    const entries = new MemoryEntries();
    const useCase = new RecordIssuedInvoiceAccountingEntry({
      invoices: new MemoryInvoices(invoice()),
      entries,
    });

    const first = await useCase.execute({ invoiceId: 'inv-1' });
    const second = await useCase.execute({ invoiceId: 'inv-1' });

    expect(first.ok && first.value.created).toBe(true);
    expect(second.ok && second.value.created).toBe(false);
    expect(entries.saved).toHaveLength(1);
  });

  it('refuse une facture non emise', async () => {
    const entries = new MemoryEntries();
    const useCase = new RecordIssuedInvoiceAccountingEntry({
      invoices: new MemoryInvoices(invoice('final', false)),
      entries,
    });

    const r = await useCase.execute({ invoiceId: 'inv-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'domain' });
    expect(entries.saved).toHaveLength(0);
  });
});
