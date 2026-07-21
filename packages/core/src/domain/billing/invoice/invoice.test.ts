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
    expect(inv.issue({ mentions: ['Mention 293'], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' }).ok).toBe(true);
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
    inv.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' });
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
    inv.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' });
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
    inv.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' });
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

  it.each([
    { vatTreatmentAtIssuance: null, frenchBillingModeAtIssuance: 'S1' as const },
    { vatTreatmentAtIssuance: 'standard' as const, frenchBillingModeAtIssuance: null },
  ])('refuse un avoir sur une source historique sans faits fiscaux figés (%o)', (missing) => {
    const legacy = Invoice.rehydrate({
      ...issuedInvoiceFromQuote('final', 'source-legacy').toSnapshot(),
      ...missing,
    });

    expect(Invoice.creditNoteFor(legacy, 'credit-legacy')).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION',
        field: 'invoice',
        message:
          'La facture source historique ne possède pas ses faits fiscaux figés. ' +
          'Sa régularisation doit être qualifiée avant de créer un avoir.',
      },
    });
  });
});

describe('Invoice — date de prestation et adresse de chantier (A7, L441-9 c. com. / 242 nonies A CGI)', () => {
  function draftInvoice(id = 'inv-a7'): Invoice {
    const created = Invoice.fromSignedQuote(signedDepositQuote(), 'deposit', id);
    if (!created.ok) throw new Error('invoice');
    const numbered = created.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
    if (!numbered.ok) throw new Error('number');
    return created.value;
  }

  it('fige période + adresse à l’émission et les restitue par copie défensive', () => {
    const inv = draftInvoice();
    const issued = inv.issue({
      mentions: [],
      terms,
      issuedAt: ISSUED,
      at: AT,
      vatTreatment: 'standard',
      frenchBillingMode: 'S1',
      servicePeriod: { start: '2026-05-12', end: '2026-05-28' },
      deliveryAddress: '  12 rue des Acacias, 92310 Sèvres  ',
    });
    expect(issued.ok).toBe(true);
    expect(inv.servicePeriod).toEqual({ start: '2026-05-12', end: '2026-05-28' });
    // L'adresse est assainie (trim) avant d'être figée.
    expect(inv.deliveryAddress).toBe('12 rue des Acacias, 92310 Sèvres');
    const copy = inv.servicePeriod;
    if (copy) copy.start = '1999-01-01';
    expect(inv.servicePeriod?.start).toBe('2026-05-12');
  });

  it('accepte une prestation ponctuelle (end null) et l’absence honnête des deux champs', () => {
    const single = draftInvoice('inv-a7-single');
    expect(
      single.issue({
        mentions: [],
        terms,
        issuedAt: ISSUED,
        at: AT,
        frenchBillingMode: 'S1',
        servicePeriod: { start: '2026-05-12', end: null },
      }).ok,
    ).toBe(true);
    expect(single.servicePeriod).toEqual({ start: '2026-05-12', end: null });
    expect(single.deliveryAddress).toBeNull();

    const bare = draftInvoice('inv-a7-bare');
    expect(bare.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' }).ok).toBe(true);
    expect(bare.servicePeriod).toBeNull();
    expect(bare.deliveryAddress).toBeNull();
  });

  it.each([
    { start: '2026-13-01', end: null },
    { start: '2026-02-30', end: null },
    { start: 'pas-une-date', end: null },
    { start: '2026-05-12', end: '2026-05-11' },
    { start: '2026-05-12', end: '2026-02-30' },
  ])('rejette une période invalide sans muter la facture (%o)', (servicePeriod) => {
    const inv = draftInvoice();
    const issued = inv.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1', servicePeriod });
    expect(issued).toMatchObject({ ok: false, error: { code: 'VALIDATION', field: 'servicePeriod' } });
    expect(inv.status).toBe('draft');
    expect(inv.servicePeriod).toBeNull();
  });

  it.each(['', '   ', 'X'.repeat(501), 'adresse\u0000pipée'])(
    'rejette une adresse de livraison invalide sans muter la facture',
    (deliveryAddress) => {
      const inv = draftInvoice();
      const issued = inv.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1', deliveryAddress });
      expect(issued).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION', field: 'deliveryAddress' },
      });
      expect(inv.status).toBe('draft');
    },
  );

  it('l’avoir total reprend période + adresse de la source et refuse d’en recevoir de nouvelles', () => {
    const source = draftInvoice('inv-a7-source');
    const issued = source.issue({
      mentions: [],
      terms,
      issuedAt: ISSUED,
      at: AT,
      vatTreatment: 'standard',
      frenchBillingMode: 'S1',
      servicePeriod: { start: '2026-05-12', end: '2026-05-28' },
      deliveryAddress: '12 rue des Acacias, 92310 Sèvres',
    });
    if (!issued.ok) throw new Error('issue');
    const credit = Invoice.creditNoteFor(source, 'credit-a7');
    if (!credit.ok) throw new Error('credit');
    expect(credit.value.servicePeriod).toEqual({ start: '2026-05-12', end: '2026-05-28' });
    expect(credit.value.deliveryAddress).toBe('12 rue des Acacias, 92310 Sèvres');

    const numbered = credit.value.assignNumber(DocNumber.format('A', 2026, 1), AT);
    if (!numbered.ok) throw new Error('number');
    // Nouvelle période à l'émission de l'avoir : refusée (contenu figé depuis la source).
    expect(
      credit.value.issue({
        mentions: [],
        terms,
        issuedAt: ISSUED,
        at: AT,
        frenchBillingMode: 'S1',
        servicePeriod: { start: '2026-06-01', end: null },
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION', field: 'servicePeriod' } });
    // Émission sans nouvelle valeur : la reprise de la source est CONSERVÉE, jamais effacée.
    expect(credit.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' }).ok).toBe(true);
    expect(credit.value.servicePeriod).toEqual({ start: '2026-05-12', end: '2026-05-28' });
    expect(credit.value.deliveryAddress).toBe('12 rue des Acacias, 92310 Sèvres');
  });

  it('roundtrip snapshot + compat ascendante des snapshots antérieurs à A7', () => {
    const inv = draftInvoice('inv-a7-snap');
    const issued = inv.issue({
      mentions: [],
      terms,
      issuedAt: ISSUED,
      at: AT,
      vatTreatment: 'standard',
      frenchBillingMode: 'S1',
      servicePeriod: { start: '2026-05-12', end: null },
      deliveryAddress: '12 rue des Acacias, 92310 Sèvres',
    });
    if (!issued.ok) throw new Error('issue');
    const snapshot = inv.toSnapshot();
    expect(snapshot.servicePeriod).toEqual({ start: '2026-05-12', end: null });
    expect(snapshot.deliveryAddress).toBe('12 rue des Acacias, 92310 Sèvres');
    const rehydrated = Invoice.rehydrate(snapshot);
    expect(rehydrated.servicePeriod).toEqual({ start: '2026-05-12', end: null });
    expect(rehydrated.deliveryAddress).toBe('12 rue des Acacias, 92310 Sèvres');

    // Snapshot legacy (avant A7) : champs absents => null honnête, jamais rétro-remplis.
    const { servicePeriod: _sp, deliveryAddress: _da, ...legacy } = snapshot;
    const legacyRehydrated = Invoice.rehydrate(legacy);
    expect(legacyRehydrated.servicePeriod).toBeNull();
    expect(legacyRehydrated.deliveryAddress).toBeNull();
  });
});

function issuedInvoiceFromQuote(mode: 'final' | 'deposit', id: string): Invoice {
  const created = Invoice.fromSignedQuote(signedDepositQuote(), mode, id);
  if (!created.ok) throw new Error('invoice');
  const numbered = created.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
  if (!numbered.ok) throw new Error('number');
  const issued = created.value.issue({
    mentions: [],
    terms,
    issuedAt: ISSUED,
    at: AT,
    vatTreatment: 'standard',
    frenchBillingMode: 'S1',
  });
  if (!issued.ok) throw new Error('issue');
  return created.value;
}

/** B8 : facture d'acompte ÉMISE dérivée d'un devis (porteur ou non d'un bon de commande). */
function issuedInvoiceFromQuoteWithPo(quote: Quote, id: string): Invoice {
  const created = Invoice.fromSignedQuote(quote, 'deposit', id);
  if (!created.ok) throw new Error('invoice');
  const numbered = created.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
  if (!numbered.ok) throw new Error('number');
  const issued = created.value.issue({
    mentions: [],
    terms,
    issuedAt: ISSUED,
    at: AT,
    vatTreatment: 'standard',
    frenchBillingMode: 'S1',
  });
  if (!issued.ok) throw new Error('issue');
  return created.value;
}

describe('Invoice — régime de TVA figé à l’émission (A4, art. 283, 2 nonies / 293 B CGI)', () => {
  function draftFromQuote(id = 'inv-a4'): Invoice {
    const created = Invoice.fromSignedQuote(signedDepositQuote(), 'deposit', id);
    if (!created.ok) throw new Error('invoice');
    const numbered = created.value.assignNumber(DocNumber.format('F', 2026, 7), AT);
    if (!numbered.ok) throw new Error('number');
    return created.value;
  }

  it('fige le régime transmis à l’émission et le restitue au snapshot', () => {
    const inv = draftFromQuote();
    const issued = inv.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, vatTreatment: 'autoliquidation', frenchBillingMode: 'S5' });
    expect(issued.ok).toBe(true);
    expect(inv.vatTreatmentAtIssuance).toBe('autoliquidation');
    expect(Invoice.rehydrate(inv.toSnapshot()).vatTreatmentAtIssuance).toBe('autoliquidation');
  });

  it('appelant antérieur (sans vatTreatment) → null honnête, jamais un régime déduit', () => {
    const inv = draftFromQuote();
    const issued = inv.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' });
    expect(issued.ok).toBe(true);
    expect(inv.vatTreatmentAtIssuance).toBeNull();
    const { vatTreatmentAtIssuance: _omitted, ...legacy } = inv.toSnapshot();
    expect(Invoice.rehydrate(legacy).vatTreatmentAtIssuance).toBeNull();
  });

  it('l’AVOIR reprend le régime FIGÉ de sa source (art. 272 CGI) et son émission ne le réécrit pas', () => {
    const source = draftFromQuote('inv-src-a4');
    const issued = source.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, vatTreatment: 'autoliquidation', frenchBillingMode: 'S5' });
    expect(issued.ok).toBe(true);
    const credit = Invoice.creditNoteFor(source, 'credit-a4');
    expect(credit.ok).toBe(true);
    if (!credit.ok) return;
    expect(credit.value.vatTreatmentAtIssuance).toBe('autoliquidation');
    const numbered = credit.value.assignNumber(DocNumber.format('A', 2026, 1), AT);
    expect(numbered.ok).toBe(true);
    // Émission de l'avoir avec un régime « courant » différent : IGNORÉ, la source fait foi.
    const creditIssued = credit.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, vatTreatment: 'standard', frenchBillingMode: 'S5' });
    expect(creditIssued.ok).toBe(true);
    expect(credit.value.vatTreatmentAtIssuance).toBe('autoliquidation');
  });

  it('refuse au niveau agrégat l’émission d’un ancien brouillon d’avoir sans faits fiscaux source', () => {
    const source = draftFromQuote('inv-src-legacy-credit');
    const sourceIssued = source.issue({
      mentions: [],
      terms,
      issuedAt: ISSUED,
      at: AT,
      vatTreatment: 'standard',
      frenchBillingMode: 'S1',
    });
    expect(sourceIssued.ok).toBe(true);
    const credit = Invoice.creditNoteFor(source, 'credit-legacy-draft');
    if (!credit.ok) throw new Error('credit');
    expect(credit.value.assignNumber(DocNumber.format('A', 2026, 2), AT).ok).toBe(true);
    const legacy = Invoice.rehydrate({
      ...credit.value.toSnapshot(),
      vatTreatmentAtIssuance: null,
      frenchBillingModeAtIssuance: null,
    });

    expect(legacy.issue({
      mentions: [],
      terms,
      issuedAt: ISSUED,
      at: AT,
      frenchBillingMode: 'S1',
    })).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION',
        field: 'invoice',
        message: 'Un avoir ne peut être émis sans les faits fiscaux figés de sa facture source.',
      },
    });
    expect(legacy.status).toBe('draft');
  });
});
