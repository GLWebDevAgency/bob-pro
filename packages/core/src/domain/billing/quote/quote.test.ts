import { describe, it, expect } from 'vitest';
import { Quote } from './quote';
import { DocNumber } from '../shared/doc-number';
import { makePurchaseOrderRef, type PurchaseOrderRef } from '../shared/purchase-order-ref';
import { type Signature } from '../shared/signature';
import { type QuoteLine } from '../shared/line';
import { type VatRate } from '../shared/vat-rate';

const AT = '2026-06-01T10:00:00.000Z';
const sig: Signature = { signerName: 'Martin', signedAt: AT, method: 'onsite_draw', accepted: true };
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

  describe('updateLine (R6)', () => {
    it('modifie une ligne en draft (patch partiel)', () => {
      const q = freshQuote();
      q.addLine(line('l1', 10, 80000));
      const r = q.updateLine('l1', { qty: 3, unitPriceHT: 90000 });
      expect(r.ok).toBe(true);
      expect(q.lines[0]).toMatchObject({ id: 'l1', qty: 3, unitPriceHT: 90000, vatRate: 10, label: 'X' });
    });
    it('ligne introuvable -> VALIDATION', () => {
      const q = freshQuote();
      q.addLine(line('l1'));
      const r = q.updateLine('missing', { qty: 2 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toEqual({ code: 'VALIDATION', field: 'lineId', message: 'Ligne introuvable.' });
    });
    it('taux TVA invalide rejeté', () => {
      const q = freshQuote();
      q.addLine(line('l1'));
      const r = q.updateLine('l1', { vatRate: 7 as unknown as VatRate });
      expect(r.ok).toBe(false);
    });
    it('quantite invalide rejetée', () => {
      const q = freshQuote();
      q.addLine(line('l1'));
      const r = q.updateLine('l1', { qty: 0 });
      expect(r.ok).toBe(false);
    });
    it('interdit hors draft', () => {
      const q = freshQuote();
      q.addLine(line('l1'));
      q.assignNumber(DocNumber.format('D', 2026, 1), AT);
      q.send(AT);
      const r = q.updateLine('l1', { qty: 2 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_TRANSITION');
    });
  });

  describe('bon de commande (B8)', () => {
    const po = (number = 'BC-RATP-4500123456'): PurchaseOrderRef => {
      const r = makePurchaseOrderRef({ number, receivedAt: AT, documentId: 'doc-1' });
      if (!r.ok) throw new Error('po');
      return r.value;
    };
    const signedQuote = (): Quote => {
      const q = freshQuote();
      q.addLine(line('l1'));
      q.assignNumber(DocNumber.format('D', 2026, 1), AT);
      q.send(AT);
      q.markViewed(AT);
      q.sign(sig, AT);
      return q;
    };

    it('défaut : aucun bon de commande, révision 1 (compat ascendante)', () => {
      const q = freshQuote();
      expect(q.purchaseOrder).toBeNull();
      expect(q.revision).toBe(1);
    });

    it('attache sur devis SIGNÉ (cas nominal grands comptes : le PO répond au devis)', () => {
      const q = signedQuote();
      q.pullEvents();
      const r = q.attachPurchaseOrder(po(), AT);
      expect(r.ok).toBe(true);
      expect(q.purchaseOrder?.number).toBe('BC-RATP-4500123456');
      expect(q.revision).toBe(2);
      expect(q.pullEvents().map((e) => e.type)).toEqual(['QuotePurchaseOrderAttached']);
    });

    it('idempotent : ré-attacher la MÊME référence ne change ni révision ni événements', () => {
      const q = signedQuote();
      q.attachPurchaseOrder(po(), AT);
      q.pullEvents();
      const replay = q.attachPurchaseOrder(po(), AT);
      expect(replay.ok).toBe(true);
      expect(q.revision).toBe(2);
      expect(q.pullEvents()).toEqual([]);
    });

    it('remplaçable : une nouvelle référence écrase l’ancienne (devis non facturé)', () => {
      const q = signedQuote();
      q.attachPurchaseOrder(po(), AT);
      const r = q.attachPurchaseOrder(po('BC-2026-0002'), AT);
      expect(r.ok).toBe(true);
      expect(q.purchaseOrder?.number).toBe('BC-2026-0002');
      expect(q.revision).toBe(3);
    });

    it('refusé/expiré : pas de bon de commande (le devis signé, lui, reste OK)', () => {
      const temoinSigne = signedQuote();
      const q = freshQuote();
      q.addLine(line('l1'));
      q.assignNumber(DocNumber.format('D', 2026, 1), AT);
      q.send(AT);
      q.refuse(AT);
      expect(q.attachPurchaseOrder(po(), AT).ok).toBe(false);
      expect(q.detachPurchaseOrder(AT).ok).toBe(false);
      expect(temoinSigne.attachPurchaseOrder(po(), AT).ok).toBe(true);
    });

    it('detach explicite : retire la référence, bump révision ; sans PO -> VALIDATION', () => {
      const q = signedQuote();
      q.attachPurchaseOrder(po(), AT);
      const r = q.detachPurchaseOrder(AT);
      expect(r.ok).toBe(true);
      expect(q.purchaseOrder).toBeNull();
      expect(q.revision).toBe(3);
      const again = q.detachPurchaseOrder(AT);
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error).toMatchObject({ code: 'VALIDATION', field: 'purchaseOrder' });
    });

    it('snapshot round-trip : purchaseOrder + revision persistés puis relus', () => {
      const q = signedQuote();
      q.attachPurchaseOrder(po(), AT);
      const back = Quote.rehydrate(q.toSnapshot());
      expect(back.purchaseOrder).toEqual({
        number: 'BC-RATP-4500123456',
        receivedAt: AT,
        documentId: 'doc-1',
      });
      expect(back.revision).toBe(2);
    });

    it('compat ascendante : un snapshot legacy SANS purchaseOrder/revision se relit (null / 1)', () => {
      const legacy = Quote.rehydrate({
        id: 'q-legacy',
        companyId: 'c1',
        customerId: 'k1',
        status: 'signed',
        lines: [line('l1')],
        number: 'D-2026-0001',
        depositPct: null,
        validUntil: null,
        signature: sig,
      });
      expect(legacy.purchaseOrder).toBeNull();
      expect(legacy.revision).toBe(1);
    });
  });

  describe('removeLine (R6)', () => {
    it('supprime une ligne existante', () => {
      const q = freshQuote();
      q.addLine(line('l1'));
      q.addLine(line('l2'));
      const r = q.removeLine('l1');
      expect(r.ok).toBe(true);
      expect(q.lines.map((l) => l.id)).toEqual(['l2']);
    });
    it('ligne introuvable -> VALIDATION (plus de no-op silencieux)', () => {
      const q = freshQuote();
      q.addLine(line('l1'));
      const r = q.removeLine('missing');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toEqual({ code: 'VALIDATION', field: 'lineId', message: 'Ligne introuvable.' });
    });
  });
});
