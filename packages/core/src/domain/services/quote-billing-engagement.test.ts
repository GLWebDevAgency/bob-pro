import { describe, expect, it } from 'vitest';
import { Invoice } from '../billing/invoice/invoice';
import { Quote, type QuoteSnapshot } from '../billing/quote/quote';
import { DocNumber } from '../billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { billedTtcCents, quoteBillingEngagement } from './quote-billing-engagement';

const AT = '2026-06-01T09:00:00.000Z';
const terms = (() => {
  const t = PaymentTerms.of({ days: 30, endOfMonth: false, label: '30 jours' });
  if (!t.ok) throw new Error('terms');
  return t.value;
})();

function signedQuote(over: Partial<QuoteSnapshot> = {}): Quote {
  return Quote.rehydrate({
    id: 'quote-1',
    companyId: 'co-1',
    customerId: 'cus-1',
    status: 'signed',
    number: 'D-2026-0001',
    depositPct: 30,
    validUntil: null,
    signature: { signerName: 'Martin', signedAt: AT, method: 'onsite_draw', accepted: true },
    lines: [
      { id: 'l1', label: 'Chauffe-eau', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
      { id: 'l2', label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
    ],
    ...over,
  });
}

function issue(invoice: Invoice, sequence: number): Invoice {
  const assigned = invoice.assignNumber(DocNumber.format('F', 2026, sequence), AT);
  if (!assigned.ok) throw new Error('number');
  const issued = invoice.issue({ mentions: [], terms, issuedAt: '2026-06-01', at: AT });
  if (!issued.ok) throw new Error('issue');
  return invoice;
}

function situation(quote: Quote, id: string, order: number, targetHtCents: number): Invoice {
  const r = Invoice.situationFromSignedQuote(quote, id, { order, targetHtCents });
  if (!r.ok) throw new Error('situation');
  return r.value;
}

describe('quoteBillingEngagement (B2 — source unique des pièces sœurs)', () => {
  const quote = signedQuote();

  it('classe acompte + situations en engagé, finale à part, et ignore les autres devis', () => {
    const deposit = Invoice.fromSignedQuote(quote, 'deposit', 'dep-1');
    const final = Invoice.fromSignedQuote(quote, 'final', 'fin-1');
    if (!deposit.ok || !final.ok) throw new Error('pieces');
    const other = signedQuote({ id: 'quote-2' });
    const stranger = Invoice.fromSignedQuote(other, 'deposit', 'dep-9');
    if (!stranger.ok) throw new Error('stranger');
    const sit = situation(quote, 'sit-1', 1, 44400);

    const engagement = quoteBillingEngagement(
      [deposit.value, final.value, stranger.value, sit],
      quote.id,
    );
    expect(engagement.engaged.map((i) => i.id).sort()).toEqual(['dep-1', 'sit-1']);
    expect(engagement.finals.map((i) => i.id)).toEqual(['fin-1']);
  });

  it('exclut les pièces ANNULÉES de l’engagé et des finales', () => {
    const sit = issue(situation(quote, 'sit-1', 1, 44400), 1);
    const cancelled = sit.cancel('erreur', AT);
    if (!cancelled.ok) throw new Error('cancel');
    const final = Invoice.fromSignedQuote(quote, 'final', 'fin-1');
    if (!final.ok) throw new Error('final');
    const cancelledFinal = issue(final.value, 2).cancel('erreur', AT);
    if (!cancelledFinal.ok) throw new Error('cancel final');

    const engagement = quoteBillingEngagement([sit, final.value], quote.id);
    expect(engagement.engaged).toEqual([]);
    expect(engagement.finals).toEqual([]);
  });

  it('exclut une pièce TOTALEMENT AVOIRÉE (avoir émis) — un brouillon d’avoir ne compte pas', () => {
    const sit = issue(situation(quote, 'sit-1', 1, 44400), 1);
    const draftCredit = Invoice.creditNoteFor(sit, 'cn-1');
    if (!draftCredit.ok) throw new Error('credit');

    // Avoir encore BROUILLON : aucun effet fiscal, la situation reste engagée.
    const before = quoteBillingEngagement([sit, draftCredit.value], quote.id);
    expect(before.engaged.map((i) => i.id)).toEqual(['sit-1']);

    issue(draftCredit.value, 2);
    const after = quoteBillingEngagement([sit, draftCredit.value], quote.id);
    expect(after.engaged).toEqual([]);
  });

  it('nextSituationOrder = max + 1 TOUT statut : un n° d’ordre annulé n’est JAMAIS réutilisé', () => {
    expect(quoteBillingEngagement([], quote.id).nextSituationOrder).toBe(1);

    const sit1 = issue(situation(quote, 'sit-1', 1, 20000), 1);
    const cancelled = sit1.cancel('erreur', AT);
    if (!cancelled.ok) throw new Error('cancel');
    const sit2 = situation(quote, 'sit-2', 2, 20000); // brouillon

    const engagement = quoteBillingEngagement([sit1, sit2], quote.id);
    // Annulée (n° 1) + brouillon (n° 2) → le prochain est 3, jamais un n° déjà imprimé.
    expect(engagement.nextSituationOrder).toBe(3);
    expect(engagement.engaged.map((i) => i.id)).toEqual(['sit-2']);
  });

  it('billedTtcCents : acompte = net à payer, situation = TTC (retenue B5 comprise)', () => {
    const deposit = Invoice.fromSignedQuote(quote, 'deposit', 'dep-1');
    if (!deposit.ok) throw new Error('deposit');
    // Acompte 30 % du TTC 162 800 → net à payer 48 840.
    expect(billedTtcCents(deposit.value)).toBe(48840);

    const retenueQuote = signedQuote({ retenueGarantiePct: 5 });
    const sit = situation(retenueQuote, 'sit-1', 1, 44400);
    // TTC 48 840 ; net à payer 46 398 (retenue 2 442) — le CUMUL compte le TTC plein.
    expect(sit.totals().netToPay).toBe(46398);
    expect(billedTtcCents(sit)).toBe(48840);
  });
});
