import { describe, expect, it } from 'vitest';
import { Invoice } from '../billing/invoice/invoice';
import { Quote } from '../billing/quote/quote';
import { type QuoteLine } from '../billing/shared/line';
import { DocNumber } from '../billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { Payment, type PaymentMethod } from '../payment/payment';
import { createFrenchOperationalChartOfAccounts } from './chart-of-accounts';
import { buildPaymentAccountingEntry, buildPaymentAccountingPreviewLines } from './payment-accounting';

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

function signedQuote(companyId = 'co-1'): Quote {
  const q = Quote.compose({ id: 'q1', companyId, customerId: 'customer-1', at: AT });
  if (!q.ok) throw new Error('quote');
  for (const line of lines) q.value.addLine(line);
  q.value.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.value.send(AT);
  q.value.sign({ signerName: 'Durand', signedAt: AT, method: 'onsite_draw', accepted: true }, AT);
  return q.value;
}

function issuedInvoice(companyId = 'co-1'): Invoice {
  const inv = Invoice.fromSignedQuote(signedQuote(companyId), 'final', 'inv-1');
  if (!inv.ok) throw new Error('invoice');
  inv.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
  inv.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT });
  return inv.value;
}

function payment(method: PaymentMethod = 'transfer', companyId = 'co-1') {
  const p = Payment.record({
    id: `pay-${method}`,
    companyId,
    invoiceId: 'inv-1',
    amount: 48840,
    method,
    receivedAt: PAID_AT,
    idempotencyKey: null,
  });
  if (!p.ok) throw new Error('payment');
  return p.value;
}

describe('buildPaymentAccountingEntry', () => {
  it("preview les lignes d'encaissement sans paiement persiste", () => {
    const r = buildPaymentAccountingPreviewLines({ amountCents: 48840, method: 'transfer', reference: 'F-2026-0001' });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual([
        { account: '512', label: 'Encaissement F-2026-0001', debitCents: 48840, creditCents: 0 },
        { account: '411', label: 'Encaissement F-2026-0001', debitCents: 0, creditCents: 48840 },
      ]);
    }
  });

  it("preview les especes sans paiement persiste", () => {
    const r = buildPaymentAccountingPreviewLines({ amountCents: 1000, method: 'cash', reference: 'F-2026-0001' });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((line) => line.account)).toEqual(['530', '411']);
  });

  it('mappe un encaissement par virement en 512 / 411', () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;

    const r = buildPaymentAccountingEntry({
      entryId: 'payment:pay-transfer:received',
      payment: payment('transfer'),
      invoice: issuedInvoice(),
      chart: chart.value,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.journal).toBe('bank');
      expect(r.value.sourceType).toBe('payment');
      expect(r.value.sourceId).toBe('pay-transfer');
      expect(r.value.entryDate).toBe('2026-06-07');
      expect(r.value.totalDebitCents).toBe(48840);
      expect(r.value.totalCreditCents).toBe(48840);
      expect(r.value.lines).toEqual([
        { account: '512', label: 'Encaissement F-2026-0001', debitCents: 48840, creditCents: 0 },
        { account: '411', label: 'Encaissement F-2026-0001', debitCents: 0, creditCents: 48840 },
      ]);
    }
  });

  it('mappe un encaissement especes en 530 / 411', () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;

    const r = buildPaymentAccountingEntry({
      entryId: 'payment:pay-cash:received',
      payment: payment('cash'),
      invoice: issuedInvoice(),
      chart: chart.value,
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines.map((line) => line.account)).toEqual(['530', '411']);
  });

  it('refuse un paiement rattache a une autre societe', () => {
    const r = buildPaymentAccountingEntry({
      entryId: 'payment:pay-transfer:received',
      payment: payment('transfer', 'co-2'),
      invoice: issuedInvoice('co-1'),
    });

    expect(r.ok).toBe(false);
  });
});
