import { describe, it, expect } from 'vitest';
import { Quote } from './quote';
import { DocNumber } from '../shared/doc-number';
import { type QuoteLine } from '../shared/line';

const AT = '2026-06-01T10:00:00.000Z';
const lines: QuoteLine[] = [
  { id: 'l1', label: 'Chauffe-eau', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
  { id: 'l2', label: 'MO', category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
];

function draftQuote(withLines = lines): Quote {
  const r = Quote.compose({ id: 'q1', companyId: 'c1', customerId: 'k1', at: AT });
  if (!r.ok) throw new Error('quote');
  for (const l of withLines) {
    const added = r.value.addLine(l);
    if (!added.ok) throw new Error('line');
  }
  return r.value;
}

describe('Quote — remises B3', () => {
  it('addLine accepte une remise de ligne valide et totals() la déduit', () => {
    const q = draftQuote([]);
    expect(
      q.addLine({ ...lines[0]!, discount: { type: 'percent', value: 10 } }).ok,
    ).toBe(true);
    const t = q.totals();
    expect(t.ht).toBe(72000);
    expect(t.discountCents).toBe(8000);
  });
  it('addLine refuse une remise en montant > base de la ligne', () => {
    const q = draftQuote([]);
    expect(q.addLine({ ...lines[0]!, discount: { type: 'amount', cents: 80001 } }).ok).toBe(false);
  });
  it('setGlobalDiscount % : test d’or chauffe-eau remisé 10 % → TTC 146 520', () => {
    const q = draftQuote();
    expect(q.setGlobalDiscount({ type: 'percent', value: 10 }).ok).toBe(true);
    const t = q.totals();
    expect(t.ht).toBe(133200);
    expect(t.vatByRate['10']).toBe(13320);
    expect(t.ttc).toBe(146520);
    expect(t.grossHt).toBe(148000);
  });
  it('setGlobalDiscount montant > HT net → refus', () => {
    const q = draftQuote();
    expect(q.setGlobalDiscount({ type: 'amount', cents: 148001 }).ok).toBe(false);
    expect(q.setGlobalDiscount({ type: 'amount', cents: 148000 }).ok).toBe(true);
  });
  it('setGlobalDiscount(null) retire la remise', () => {
    const q = draftQuote();
    q.setGlobalDiscount({ type: 'percent', value: 5 });
    expect(q.setGlobalDiscount(null).ok).toBe(true);
    expect(q.globalDiscount).toBeNull();
    expect('discountCents' in q.totals()).toBe(false);
  });
  it('updateLine : pose, remplace et retire (null) une remise de ligne', () => {
    const q = draftQuote();
    expect(q.updateLine('l1', { discount: { type: 'amount', cents: 5000 } }).ok).toBe(true);
    expect(q.totals().ht).toBe(143000);
    expect(q.updateLine('l1', { discount: { type: 'percent', value: 50 } }).ok).toBe(true);
    expect(q.totals().ht).toBe(108000);
    expect(q.updateLine('l1', { discount: null }).ok).toBe(true);
    expect(q.totals().ht).toBe(148000);
  });
  it('updateLine : baisser le prix sous une remise en montant conservée → refus (garde plafond)', () => {
    const q = draftQuote();
    expect(q.updateLine('l1', { discount: { type: 'amount', cents: 50000 } }).ok).toBe(true);
    expect(q.updateLine('l1', { unitPriceHT: 40000 }).ok).toBe(false);
  });
  it('send refuse une remise globale en montant devenue supérieure au HT (fail-closed)', () => {
    const q = draftQuote();
    expect(q.setGlobalDiscount({ type: 'amount', cents: 148000 }).ok).toBe(true);
    // La ligne l2 est retirée après la saisie : la remise dépasse désormais le HT.
    expect(q.removeLine('l2').ok).toBe(true);
    q.assignNumber(DocNumber.format('D', 2026, 1), AT);
    const sent = q.send(AT);
    expect(sent.ok).toBe(false);
  });
  it('un devis signé ne se remise plus (draft uniquement)', () => {
    const q = draftQuote();
    q.assignNumber(DocNumber.format('D', 2026, 1), AT);
    q.send(AT);
    expect(q.setGlobalDiscount({ type: 'percent', value: 5 }).ok).toBe(false);
  });
  it('snapshot round-trip : remises de ligne et globale conservées', () => {
    const q = draftQuote([{ ...lines[0]!, discount: { type: 'percent', value: 10 } }, lines[1]!]);
    q.setGlobalDiscount({ type: 'amount', cents: 2000 });
    const rehydrated = Quote.rehydrate(q.toSnapshot());
    expect(rehydrated.globalDiscount).toEqual({ type: 'amount', cents: 2000 });
    expect(rehydrated.totals()).toEqual(q.totals());
  });
  it('compat ascendante : snapshot antérieur sans remise → null honnête', () => {
    const q = draftQuote();
    const snapshot = q.toSnapshot();
    delete (snapshot as unknown as Record<string, unknown>)['globalDiscount'];
    delete (snapshot as unknown as Record<string, unknown>)['retenueGarantiePct'];
    const rehydrated = Quote.rehydrate(snapshot);
    expect(rehydrated.globalDiscount).toBeNull();
    expect(rehydrated.retenueGarantiePct).toBeNull();
  });
});

describe('Quote — retenue de garantie B5', () => {
  it('setRetenueGarantie accepte 0 < taux ≤ 5 et se retire par null', () => {
    const q = draftQuote();
    expect(q.setRetenueGarantie(5).ok).toBe(true);
    expect(q.retenueGarantiePct).toBe(5);
    expect(q.setRetenueGarantie(null).ok).toBe(true);
    expect(q.retenueGarantiePct).toBeNull();
  });
  it('plafond légal : 5,01 % refusé (loi 71-584)', () => {
    const q = draftQuote();
    const r = q.setRetenueGarantie(5.01);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'VALIDATION') expect(r.error.message).toContain('71-584');
  });
  it('draft uniquement : un devis envoyé fige la stipulation', () => {
    const q = draftQuote();
    q.assignNumber(DocNumber.format('D', 2026, 1), AT);
    q.send(AT);
    expect(q.setRetenueGarantie(5).ok).toBe(false);
  });
  it('snapshot round-trip : taux conservé', () => {
    const q = draftQuote();
    q.setRetenueGarantie(3);
    expect(Quote.rehydrate(q.toSnapshot()).retenueGarantiePct).toBe(3);
  });
});
