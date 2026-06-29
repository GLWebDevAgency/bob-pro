import { describe, it, expect } from 'vitest';
import { Quote } from '../quote/quote';
import { Invoice } from './invoice';
import { DocNumber } from '../shared/doc-number';
import { PaymentTerms } from '../../../shared-kernel/payment-terms';
import { type Signature } from '../shared/signature';
import { type QuoteLine } from '../shared/line';

const AT = '2026-06-01T10:00:00.000Z';
const ISSUED = '2026-06-01';
const sig: Signature = { signerName: 'Martin', signedAt: AT, method: 'draw', accepted: true };
const terms = (() => {
  const t = PaymentTerms.of({ days: 30, endOfMonth: false, label: 'Paiement a 30 jours' });
  if (!t.ok) throw new Error('terms');
  return t.value;
})();
const lines: QuoteLine[] = [
  { id: 'l1', label: 'Chauffe-eau', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
  { id: 'l2', label: 'MO', category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
];

function signedDepositQuote(): Quote {
  const r = Quote.compose({ id: 'q1', companyId: 'c1', customerId: 'k1', at: AT });
  if (!r.ok) throw new Error('q');
  const q = r.value;
  for (const l of lines) q.addLine(l);
  q.setDeposit(30);
  q.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.send(AT);
  q.sign(sig, AT);
  return q;
}

describe('Invoice', () => {
  it('fromSignedQuote exige un devis signe', () => {
    const r = Quote.compose({ id: 'q2', companyId: 'c1', customerId: 'k1', at: AT });
    if (!r.ok) throw new Error('q');
    expect(Invoice.fromSignedQuote(r.value, 'final', 'inv1').ok).toBe(false);
  });
  it('acompte 30% => net 488,40', () => {
    const invR = Invoice.fromSignedQuote(signedDepositQuote(), 'deposit', 'inv1');
    expect(invR.ok).toBe(true);
    if (invR.ok) expect(invR.value.totals().netToPay).toBe(48840);
  });
  it('issue fige totals + mentions + dueAt et interdit l edition ensuite', () => {
    const invR = Invoice.fromSignedQuote(signedDepositQuote(), 'deposit', 'inv1');
    if (!invR.ok) throw new Error('inv');
    const inv = invR.value;
    inv.assignNumber(DocNumber.format('F', 2026, 1), AT);
    expect(inv.issue({ mentions: ['Mention 293'], terms, issuedAt: ISSUED, at: AT }).ok).toBe(true);
    expect(inv.status).toBe('issued');
    expect(inv.dueAt).toBe('2026-07-01');
    expect(inv.mentions).toContain('Mention 293');
    expect(inv.addLine(lines[0]!).ok).toBe(false);
  });
  it('registerPayment partiel puis complet => paid', () => {
    const invR = Invoice.fromSignedQuote(signedDepositQuote(), 'deposit', 'inv1');
    if (!invR.ok) throw new Error('inv');
    const inv = invR.value;
    inv.assignNumber(DocNumber.format('F', 2026, 1), AT);
    inv.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT });
    expect(inv.registerPayment(20000, AT).ok).toBe(true);
    expect(inv.status).toBe('partially_paid');
    expect(inv.registerPayment(28840, AT).ok).toBe(true);
    expect(inv.status).toBe('paid');
  });
});
