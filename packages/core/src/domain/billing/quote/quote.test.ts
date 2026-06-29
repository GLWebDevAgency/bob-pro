import { describe, it, expect } from 'vitest';
import { Quote } from './quote';
import { DocNumber } from '../shared/doc-number';
import { type Signature } from '../shared/signature';
import { type QuoteLine } from '../shared/line';
import { type VatRate } from '../shared/vat-rate';

const AT = '2026-06-01T10:00:00.000Z';
const sig: Signature = { signerName: 'Martin', signedAt: AT, method: 'draw', accepted: true };
const line = (id: string, vatRate: VatRate = 10, unitPriceHT = 80000): QuoteLine => ({
  id,
  label: 'X',
  category: 'supply',
  qty: 1,
  unitPriceHT,
  vatRate,
});

function freshQuote(): Quote {
  const r = Quote.compose({ id: 'q1', companyId: 'c1', customerId: 'k1', at: AT });
  if (!r.ok) throw new Error('compose');
  return r.value;
}

describe('Quote', () => {
  it('compose en draft', () => {
    expect(freshQuote().status).toBe('draft');
  });
  it('deposit 30% => netToPay 488,40 (48840 centimes)', () => {
    const q = freshQuote();
    q.addLine(line('l1', 10, 80000));
    q.addLine(line('l2', 10, 68000));
    q.setDeposit(30);
    expect(q.totals().netToPay).toBe(48840);
  });
  it('send sans numero echoue', () => {
    const q = freshQuote();
    q.addLine(line('l1'));
    expect(q.send(AT).ok).toBe(false);
  });
  it('edition interdite hors draft', () => {
    const q = freshQuote();
    q.addLine(line('l1'));
    q.assignNumber(DocNumber.format('D', 2026, 1), AT);
    expect(q.send(AT).ok).toBe(true);
    const r = q.addLine(line('l2'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_TRANSITION');
  });
  it('flux jusqu a signed', () => {
    const q = freshQuote();
    q.addLine(line('l1'));
    q.assignNumber(DocNumber.format('D', 2026, 1), AT);
    q.send(AT);
    q.markViewed(AT);
    expect(q.sign(sig, AT).ok).toBe(true);
    expect(q.status).toBe('signed');
    expect(q.signature?.signerName).toBe('Martin');
  });
  it('transition invalide (draft->signed direct)', () => {
    expect(freshQuote().sign(sig, AT).ok).toBe(false);
  });
});
