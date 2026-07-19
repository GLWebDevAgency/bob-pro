import { describe, it, expect } from 'vitest';
import { Quote } from '../quote/quote';
import { Invoice } from './invoice';
import { DocNumber } from '../shared/doc-number';
import { makePurchaseOrderRef, type PurchaseOrderRef } from '../shared/purchase-order-ref';
import { PaymentTerms } from '../../../shared-kernel/payment-terms';
import { type Signature } from '../shared/signature';
import { type QuoteLine } from '../shared/line';

const AT = '2026-06-01T10:00:00.000Z';
const ISSUED = '2026-06-01';
const sig: Signature = { signerName: 'Martin', signedAt: AT, method: 'onsite_draw', accepted: true };
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
  it('registerPayment rejette le surpaiement (pas de trop-perçu silencieux)', () => {
    const invR = Invoice.fromSignedQuote(signedDepositQuote(), 'deposit', 'inv1');
    if (!invR.ok) throw new Error('inv');
    const inv = invR.value;
    inv.assignNumber(DocNumber.format('F', 2026, 1), AT);
    inv.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT });
    expect(inv.registerPayment(60000, AT).ok).toBe(false); // 60000 > 48840 dû -> rejeté
    expect(inv.status).toBe('issued'); // état inchangé
    expect(inv.registerPayment(48840, AT).ok).toBe(true); // paiement exact accepté
    expect(inv.status).toBe('paid');
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 12.34])('registerPayment rejette un montant non entier fini (%s)', (amount) => {
    const invR = Invoice.fromSignedQuote(signedDepositQuote(), 'deposit', 'inv1');
    if (!invR.ok) throw new Error('inv');
    const inv = invR.value;
    inv.assignNumber(DocNumber.format('F', 2026, 1), AT);
    inv.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT });
    expect(inv.registerPayment(amount, AT).ok).toBe(false);
    expect(inv.paid).toBe(0);
    expect(inv.status).toBe('issued');
  });

  it('crée un avoir total traçable qui fige la source et le montant exact d’un acompte', () => {
    const source = issuedInvoiceFromQuote('deposit', 'source-deposit');
    const created = Invoice.creditNoteFor(source, 'credit-1');

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.creditNoteSource).toEqual({
      invoiceId: 'source-deposit',
      kind: 'deposit',
      number: 'F-2026-0001',
      issuedAt: ISSUED,
    });
    expect(created.value.totals()).toEqual(source.totals());
    expect(created.value.totals().netToPay).toBe(48840);
    expect(created.value.addLine(lines[0]!)).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION',
        field: 'lines',
        message: 'Les lignes d’un avoir total sont figées depuis la facture source.',
      },
    });

    const rehydrated = Invoice.rehydrate(created.value.toSnapshot());
    expect(rehydrated.creditNoteSource).toEqual(created.value.creditNoteSource);
    expect(rehydrated.totals()).toEqual(source.totals());
  });

  describe('bon de commande (B8)', () => {
    const po = (number = 'BC-RATP-4500123456'): PurchaseOrderRef => {
      const r = makePurchaseOrderRef({ number, receivedAt: AT, documentId: null });
      if (!r.ok) throw new Error('po');
      return r.value;
    };

    it('REPRISE AUTOMATIQUE : fromSignedQuote copie le PO du devis (source unique, jamais re-saisi)', () => {
      const quote = signedDepositQuote();
      expect(quote.attachPurchaseOrder(po(), AT).ok).toBe(true);
      for (const mode of ['deposit', 'final'] as const) {
        const created = Invoice.fromSignedQuote(quote, mode, `inv-${mode}`);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        expect(created.value.purchaseOrder).toEqual({
          number: 'BC-RATP-4500123456',
          receivedAt: AT,
          documentId: null,
        });
      }
    });

    it('devis sans PO -> facture sans PO (compat : rien n’est inventé)', () => {
      const created = Invoice.fromSignedQuote(signedDepositQuote(), 'final', 'inv-1');
      expect(created.ok).toBe(true);
      if (created.ok) expect(created.value.purchaseOrder).toBeNull();
    });

    it('attache sur BROUILLON, idempotent, remplaçable ; révision suit', () => {
      const invR = Invoice.composeStandalone({ id: 'i1', companyId: 'c1', customerId: 'k1' });
      if (!invR.ok) throw new Error('inv');
      const inv = invR.value;
      inv.pullEvents();
      expect(inv.attachPurchaseOrder(po(), AT).ok).toBe(true);
      expect(inv.revision).toBe(2);
      expect(inv.pullEvents().map((e) => e.type)).toEqual(['InvoicePurchaseOrderAttached']);
      // Idempotence : même référence -> aucun effet.
      expect(inv.attachPurchaseOrder(po(), AT).ok).toBe(true);
      expect(inv.revision).toBe(2);
      expect(inv.pullEvents()).toEqual([]);
      // Remplacement en brouillon : OK.
      expect(inv.attachPurchaseOrder(po('BC-2'), AT).ok).toBe(true);
      expect(inv.purchaseOrder?.number).toBe('BC-2');
      expect(inv.revision).toBe(3);
    });

    it('IMMUTABILITÉ post-émission : attach/detach interdits une fois la facture émise', () => {
      const quote = signedDepositQuote();
      quote.attachPurchaseOrder(po(), AT);
      const inv = issuedInvoiceFromQuoteWithPo(quote, 'inv-issued');
      const attach = inv.attachPurchaseOrder(po('BC-APRES'), AT);
      expect(attach.ok).toBe(false);
      if (!attach.ok) expect(attach.error).toMatchObject({ code: 'VALIDATION', field: 'status' });
      const detach = inv.detachPurchaseOrder(AT);
      expect(detach.ok).toBe(false);
      // Le PO repris du devis reste imprimable sur la pièce émise.
      expect(inv.purchaseOrder?.number).toBe('BC-RATP-4500123456');
    });

    it('avoir total : hérite du PO de la source (compta grands comptes) et le fige', () => {
      const quote = signedDepositQuote();
      quote.attachPurchaseOrder(po(), AT);
      const source = issuedInvoiceFromQuoteWithPo(quote, 'inv-src');
      const credit = Invoice.creditNoteFor(source, 'credit-1');
      expect(credit.ok).toBe(true);
      if (!credit.ok) return;
      expect(credit.value.purchaseOrder?.number).toBe('BC-RATP-4500123456');
      const mutate = credit.value.attachPurchaseOrder(po('BC-AUTRE'), AT);
      expect(mutate.ok).toBe(false);
      if (!mutate.ok) expect(mutate.error).toMatchObject({ code: 'VALIDATION', field: 'purchaseOrder' });
      expect(credit.value.detachPurchaseOrder(AT).ok).toBe(false);
    });

    it('detach explicite sur brouillon ; sans PO -> VALIDATION', () => {
      const invR = Invoice.composeStandalone({ id: 'i1', companyId: 'c1', customerId: 'k1' });
      if (!invR.ok) throw new Error('inv');
      const inv = invR.value;
      expect(inv.detachPurchaseOrder(AT).ok).toBe(false);
      inv.attachPurchaseOrder(po(), AT);
      expect(inv.detachPurchaseOrder(AT).ok).toBe(true);
      expect(inv.purchaseOrder).toBeNull();
      expect(inv.revision).toBe(3);
    });

    it('snapshot round-trip + compat legacy (sans purchaseOrder/revision -> null / 1)', () => {
      const invR = Invoice.composeStandalone({ id: 'i1', companyId: 'c1', customerId: 'k1' });
      if (!invR.ok) throw new Error('inv');
      invR.value.attachPurchaseOrder(po(), AT);
      const back = Invoice.rehydrate(invR.value.toSnapshot());
      expect(back.purchaseOrder?.number).toBe('BC-RATP-4500123456');
      expect(back.revision).toBe(2);

      const legacy = Invoice.rehydrate({
        id: 'i-legacy',
        companyId: 'c1',
        customerId: 'k1',
        kind: 'final',
        status: 'draft',
        lines: [],
        number: null,
        frozenTotals: null,
        mentions: [],
        issuedAt: null,
        dueAt: null,
        paid: 0,
        depositPct: null,
        parentQuoteId: null,
      });
      expect(legacy.purchaseOrder).toBeNull();
      expect(legacy.revision).toBe(1);
    });
  });

  it('refuse une pseudo-source émise sans numéro, date ou totaux légaux figés', () => {
    const corrupt = Invoice.rehydrate({
      ...issuedInvoiceFromQuote('final', 'source-corrupt').toSnapshot(),
      number: null,
    });
    expect(Invoice.creditNoteFor(corrupt, 'credit-corrupt')).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION',
        field: 'invoice',
        message: 'La facture source ne possède pas de trace légale complète (numéro, date et totaux figés).',
      },
    });
  });
});

function issuedInvoiceFromQuote(mode: 'final' | 'deposit', id: string): Invoice {
  const created = Invoice.fromSignedQuote(signedDepositQuote(), mode, id);
  if (!created.ok) throw new Error('invoice');
  const numbered = created.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
  if (!numbered.ok) throw new Error('number');
  const issued = created.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT });
  if (!issued.ok) throw new Error('issue');
  return created.value;
}

/** B8 : facture d'acompte ÉMISE dérivée d'un devis (porteur ou non d'un bon de commande). */
function issuedInvoiceFromQuoteWithPo(quote: Quote, id: string): Invoice {
  const created = Invoice.fromSignedQuote(quote, 'deposit', id);
  if (!created.ok) throw new Error('invoice');
  const numbered = created.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
  if (!numbered.ok) throw new Error('number');
  const issued = created.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT });
  if (!issued.ok) throw new Error('issue');
  return created.value;
}
