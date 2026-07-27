import { describe, it, expect } from 'vitest';
import { Quote } from '../quote/quote';
import { Invoice } from './invoice';
import { DocNumber } from '../shared/doc-number';
import { PaymentTerms } from '../../../shared-kernel/payment-terms';
import { type Signature } from '../shared/signature';
import { type QuoteLine } from '../shared/line';

/**
 * PR-08 — le site d'une pièce SUIT ses dérivées : la facture (acompte/finale/situation) d'un
 * devis de site reste une pièce du site, l'avoir rectifie la même opération sur le même site.
 * Jamais une re-saisie séparée qui pourrait diverger, jamais un site inventé (null honnête).
 */

const AT = '2026-06-01T10:00:00.000Z';
const sig: Signature = { signerName: 'Martin', signedAt: AT, method: 'onsite_draw', accepted: true };
const lines: QuoteLine[] = [
  { id: 'l1', label: 'Entretien fontaines', category: 'labor', qty: 1, unitPriceHT: 80_000, vatRate: 20 },
];

function signedQuote(chantierId: string | null): Quote {
  const r = Quote.compose({ id: 'q1', companyId: 'c1', customerId: 'k1', at: AT, chantierId });
  if (!r.ok) throw new Error('quote');
  const q = r.value;
  for (const l of lines) q.addLine(l);
  q.setDeposit(30);
  q.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.send(AT);
  q.sign(sig, AT);
  return q;
}

describe('PR-08 — propagation du site sur les pièces dérivées', () => {
  it('le devis composé avec un site l’expose et le fige dans son snapshot', () => {
    const quote = signedQuote('site-bastille');
    expect(quote.chantierId).toBe('site-bastille');
    expect(quote.toSnapshot().chantierId).toBe('site-bastille');
    expect(Quote.rehydrate(quote.toSnapshot()).chantierId).toBe('site-bastille');
  });

  it('un chantierId vide est refusé à la composition (identifiant canonique exigé)', () => {
    const r = Quote.compose({ id: 'q1', companyId: 'c1', customerId: 'k1', at: AT, chantierId: '   ' });
    expect(r.ok).toBe(false);
  });

  it('acompte et finale héritent du site du devis', () => {
    const quote = signedQuote('site-bastille');
    const deposit = Invoice.fromSignedQuote(quote, 'deposit', 'inv-dep');
    const final = Invoice.fromSignedQuote(quote, 'final', 'inv-fin');
    if (!deposit.ok || !final.ok) throw new Error('dérivation');
    expect(deposit.value.chantierId).toBe('site-bastille');
    expect(final.value.chantierId).toBe('site-bastille');
  });

  it('la situation hérite du site du devis', () => {
    const situation = Invoice.situationFromSignedQuote(signedQuote('site-bastille'), 'inv-sit', {
      order: 1,
      targetHtCents: 40_000,
    });
    if (!situation.ok) throw new Error('situation');
    expect(situation.value.chantierId).toBe('site-bastille');
  });

  it('l’avoir reprend le site de la pièce annulée ; snapshot/rehydrate le conservent', () => {
    const final = Invoice.fromSignedQuote(signedQuote('site-bastille'), 'final', 'inv-fin');
    if (!final.ok) throw new Error('finale');
    const inv = final.value;
    inv.assignNumber(DocNumber.format('F', 2026, 1), AT);
    const terms = PaymentTerms.of({ days: 30, endOfMonth: false, label: 'Paiement a 30 jours' });
    if (!terms.ok) throw new Error('terms');
    const issued = inv.issue({
      mentions: [],
      terms: terms.value,
      issuedAt: '2026-06-01',
      at: AT,
      vatTreatment: 'standard',
      frenchBillingMode: 'S1',
    });
    if (!issued.ok) throw new Error(`émission: ${JSON.stringify(issued.error)}`);
    const credit = Invoice.creditNoteFor(inv, 'avoir-1');
    if (!credit.ok) throw new Error('avoir');
    expect(credit.value.chantierId).toBe('site-bastille');
    expect(Invoice.rehydrate(credit.value.toSnapshot()).chantierId).toBe('site-bastille');
  });

  it('devis hors site → toute la lignée reste hors site (null honnête, jamais inventé)', () => {
    const quote = signedQuote(null);
    const final = Invoice.fromSignedQuote(quote, 'final', 'inv-fin');
    if (!final.ok) throw new Error('finale');
    expect(quote.chantierId).toBeNull();
    expect(final.value.chantierId).toBeNull();
    expect(final.value.toSnapshot().chantierId).toBeNull();
  });
});
