import { describe, it, expect } from 'vitest';
import { Invoice } from '../billing/invoice/invoice';
import { Quote } from '../billing/quote/quote';
import { type QuoteLine } from '../billing/shared/line';
import { DocNumber } from '../billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { createFrenchOperationalChartOfAccounts } from './chart-of-accounts';
import { buildIssuedInvoiceAccountingEntry, buildInvoiceAccountingPreviewEntry } from './invoice-accounting';

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

function signedQuote(depositPct: number | null): Quote {
  const q = Quote.compose({ id: 'q1', companyId: 'co-1', customerId: 'customer-1', at: AT });
  if (!q.ok) throw new Error('quote');
  for (const line of lines) q.value.addLine(line);
  q.value.setDeposit(depositPct);
  q.value.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.value.send(AT);
  q.value.sign({ signerName: 'Durand', signedAt: AT, method: 'draw', accepted: true }, AT);
  return q.value;
}

function issuedInvoice(mode: 'final' | 'deposit'): Invoice {
  const inv = Invoice.fromSignedQuote(signedQuote(mode === 'deposit' ? 30 : null), mode, 'inv-1');
  if (!inv.ok) throw new Error('invoice');
  inv.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
  inv.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT });
  return inv.value;
}

describe('buildIssuedInvoiceAccountingEntry', () => {
  it('mappe une facture finale en 411 / ventes / TVA collectee', () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-1', invoice: issuedInvoice('final'), chart: chart.value });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.totalDebitCents).toBe(162800);
      expect(r.value.totalCreditCents).toBe(162800);
      expect(r.value.lines).toEqual([
        { account: '411', label: 'Facture F-2026-0001', debitCents: 162800, creditCents: 0 },
        { account: '707', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 80000 },
        { account: '706', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 68000 },
        { account: '44571', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 14800 },
      ]);
    }
  });

  it("mappe une facture d'acompte sur 4191 sans comptabiliser tout le CA", () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-1', invoice: issuedInvoice('deposit'), chart: chart.value });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.totalDebitCents).toBe(48840);
      expect(r.value.totalCreditCents).toBe(48840);
      expect(r.value.lines).toEqual([
        { account: '411', label: 'Facture F-2026-0001', debitCents: 48840, creditCents: 0 },
        { account: '4191', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 44400 },
        { account: '44571', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 4440 },
      ]);
    }
  });

  it('refuse une facture non emise', () => {
    const inv = Invoice.fromSignedQuote(signedQuote(null), 'final', 'inv-1');
    expect(inv.ok).toBe(true);
    if (inv.ok) {
      const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-1', invoice: inv.value });
      expect(r.ok).toBe(false);
    }
  });
});

describe('buildInvoiceAccountingPreviewEntry', () => {
  it('preview une facture brouillon sans numero ni allocation no-gap', () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    const inv = Invoice.fromSignedQuote(signedQuote(null), 'final', 'inv-1');
    expect(inv.ok).toBe(true);
    if (!chart.ok || !inv.ok) return;

    const r = buildInvoiceAccountingPreviewEntry({
      entryId: 'preview-1',
      invoice: inv.value,
      entryDate: ISSUED,
      reference: 'a-emettre',
      chart: chart.value,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(inv.value.number).toBeNull();
      expect(r.value.reference).toBe('a-emettre');
      expect(r.value.entryDate).toBe(ISSUED);
      expect(r.value.totalDebitCents).toBe(162800);
      expect(r.value.lines).toEqual([
        { account: '411', label: 'Facture a-emettre', debitCents: 162800, creditCents: 0 },
        { account: '707', label: 'Facture a-emettre', debitCents: 0, creditCents: 80000 },
        { account: '706', label: 'Facture a-emettre', debitCents: 0, creditCents: 68000 },
        { account: '44571', label: 'Facture a-emettre', debitCents: 0, creditCents: 14800 },
      ]);
    }
  });

  it("preview une facture d'acompte brouillon sur 4191", () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    const inv = Invoice.fromSignedQuote(signedQuote(30), 'deposit', 'inv-1');
    expect(inv.ok).toBe(true);
    if (!chart.ok || !inv.ok) return;

    const r = buildInvoiceAccountingPreviewEntry({
      entryId: 'preview-1',
      invoice: inv.value,
      entryDate: ISSUED,
      reference: 'a-emettre',
      chart: chart.value,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.totalDebitCents).toBe(48840);
      expect(r.value.lines.map((line) => line.account)).toEqual(['411', '4191', '44571']);
    }
  });
});
