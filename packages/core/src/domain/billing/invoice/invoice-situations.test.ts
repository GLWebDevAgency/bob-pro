import { describe, it, expect } from 'vitest';
import { Quote } from '../quote/quote';
import { Invoice } from './invoice';
import { DocNumber } from '../shared/doc-number';
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

function signedQuote(opts?: { retenuePct?: number; depositPct?: number; globalDiscountPct?: number }): Quote {
  const r = Quote.compose({ id: 'q1', companyId: 'c1', customerId: 'k1', at: AT });
  if (!r.ok) throw new Error('quote');
  const q = r.value;
  for (const l of lines) q.addLine(l);
  if (opts?.depositPct !== undefined) q.setDeposit(opts.depositPct);
  if (opts?.retenuePct !== undefined) q.setRetenueGarantie(opts.retenuePct);
  if (opts?.globalDiscountPct !== undefined)
    q.setGlobalDiscount({ type: 'percent', value: opts.globalDiscountPct });
  q.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.send(AT);
  q.sign(sig, AT);
  return q;
}

describe('Invoice.situationFromSignedQuote (B2)', () => {
  it('exige un devis signé et des paramètres valides', () => {
    const draft = Quote.compose({ id: 'q2', companyId: 'c1', customerId: 'k1', at: AT });
    if (!draft.ok) throw new Error('q');
    expect(Invoice.situationFromSignedQuote(draft.value, 'inv1', { order: 1, targetHtCents: 1000 }).ok).toBe(false);
    const q = signedQuote();
    expect(Invoice.situationFromSignedQuote(q, 'inv1', { order: 0, targetHtCents: 1000 }).ok).toBe(false);
    expect(Invoice.situationFromSignedQuote(q, 'inv1', { order: 1, targetHtCents: 0 }).ok).toBe(false);
    expect(Invoice.situationFromSignedQuote(q, 'inv1', { order: 1, targetHtCents: 148001 }).ok).toBe(false);
  });
  it('test d’or : situation 30 % HT (44 400) → lignes prorata exactes, TTC 48 840', () => {
    const r = Invoice.situationFromSignedQuote(signedQuote(), 'inv1', { order: 1, targetHtCents: 44400 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inv = r.value;
    expect(inv.kind).toBe('situation');
    expect(inv.situationOrder).toBe(1);
    expect(inv.parentQuoteId).toBe('q1');
    // Proration par poste : 80 000 → 24 000 ; 68 000 → 20 400 (mêmes id de poste, traçabilité).
    expect(inv.lines.map((l) => ({ id: l.id, unitPriceHT: l.unitPriceHT }))).toEqual([
      { id: 'l1', unitPriceHT: 24000 },
      { id: 'l2', unitPriceHT: 20400 },
    ]);
    const t = inv.totals();
    expect(t.ht).toBe(44400);
    expect(t.vatByRate['10']).toBe(4440);
    expect(t.ttc).toBe(48840);
    expect(t.netToPay).toBe(48840);
  });
  it('la somme des lignes prorata vaut EXACTEMENT la cible (montants non ronds)', () => {
    const r = Invoice.situationFromSignedQuote(signedQuote(), 'inv1', { order: 2, targetHtCents: 33333 });
    if (!r.ok) throw new Error('situation');
    const totalHt = r.value.lines.reduce((sum, l) => sum + Math.round(l.qty * l.unitPriceHT), 0);
    expect(totalHt).toBe(33333);
  });
  it('B5 — retenue de garantie 5 % : déduite du net à payer, jamais de la TVA', () => {
    const r = Invoice.situationFromSignedQuote(signedQuote({ retenuePct: 5 }), 'inv1', {
      order: 1,
      targetHtCents: 44400,
    });
    if (!r.ok) throw new Error('situation');
    const t = r.value.totals();
    expect(t.ttc).toBe(48840);
    expect(t.retenueGarantieCents).toBe(2442);
    expect(t.netToPay).toBe(46398);
    expect(t.duePayableCents).toBe(48840);
    expect(t.vatByRate['10']).toBe(4440); // TVA due sur l'avancement PLEIN
  });
  it('B5 — payer le montant immédiat ne solde pas la retenue ; le reliquat reste encaissable', () => {
    const created = Invoice.situationFromSignedQuote(signedQuote({ retenuePct: 5 }), 'inv-ret', {
      order: 1,
      targetHtCents: 44400,
    });
    if (!created.ok) throw new Error('situation');
    const invoice = created.value;
    invoice.assignNumber(DocNumber.format('F', 2026, 2), AT);
    invoice.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' });

    expect(invoice.registerPayment(46398, AT).ok).toBe(true);
    expect(invoice.status).toBe('partially_paid');
    expect(invoice.paid).toBe(46398);
    expect(invoice.registerPayment(2442, AT).ok).toBe(true);
    expect(invoice.status).toBe('paid');
    expect(invoice.paid).toBe(48840);
  });
  it('B3 — le prorata part des bases NETTES de remises du devis', () => {
    // Marché remisé 10 % : HT net 133 200. Une situation de 133 200 = 100 % passe ;
    // 133 201 dépasse le marché net → refus.
    const q = signedQuote({ globalDiscountPct: 10 });
    expect(Invoice.situationFromSignedQuote(q, 'inv1', { order: 1, targetHtCents: 133201 }).ok).toBe(false);
    const full = Invoice.situationFromSignedQuote(q, 'inv1', { order: 1, targetHtCents: 133200 });
    if (!full.ok) throw new Error('situation');
    expect(full.value.totals().ht).toBe(133200);
  });
  it('les lignes d’une situation sont figées (addLine refusé)', () => {
    const r = Invoice.situationFromSignedQuote(signedQuote(), 'inv1', { order: 1, targetHtCents: 44400 });
    if (!r.ok) throw new Error('situation');
    expect(r.value.addLine(lines[0]!).ok).toBe(false);
  });
  it('émission : numéro + mentions + totaux FIGÉS (retenue comprise)', () => {
    const r = Invoice.situationFromSignedQuote(signedQuote({ retenuePct: 5 }), 'inv1', {
      order: 1,
      targetHtCents: 44400,
    });
    if (!r.ok) throw new Error('situation');
    const inv = r.value;
    inv.assignNumber(DocNumber.format('F', 2026, 1), AT);
    expect(inv.issue({ mentions: ['M'], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' }).ok).toBe(true);
    expect(inv.totals().retenueGarantieCents).toBe(2442);
    expect(inv.totals().netToPay).toBe(46398);
  });
  it('snapshot round-trip : ordre, retenue et totaux conservés', () => {
    const r = Invoice.situationFromSignedQuote(signedQuote({ retenuePct: 5 }), 'inv1', {
      order: 3,
      targetHtCents: 44400,
    });
    if (!r.ok) throw new Error('situation');
    const rehydrated = Invoice.rehydrate(r.value.toSnapshot());
    expect(rehydrated.kind).toBe('situation');
    expect(rehydrated.situationOrder).toBe(3);
    expect(rehydrated.retenueGarantiePct).toBe(5);
    expect(rehydrated.totals()).toEqual(r.value.totals());
  });
  it('avoir sur situation émise : miroir exact (ordre, retenue, totaux figés)', () => {
    const r = Invoice.situationFromSignedQuote(signedQuote({ retenuePct: 5 }), 'inv1', {
      order: 1,
      targetHtCents: 44400,
    });
    if (!r.ok) throw new Error('situation');
    const inv = r.value;
    inv.assignNumber(DocNumber.format('F', 2026, 1), AT);
    inv.issue({
      mentions: [],
      terms,
      issuedAt: ISSUED,
      at: AT,
      vatTreatment: 'standard',
      frenchBillingMode: 'S1',
    });
    const creditNote = Invoice.creditNoteFor(inv, 'cn1');
    expect(creditNote.ok).toBe(true);
    if (creditNote.ok) {
      expect(creditNote.value.situationOrder).toBe(1);
      expect(creditNote.value.retenueGarantiePct).toBe(5);
      expect(creditNote.value.totals()).toEqual(inv.totals());
      expect(creditNote.value.creditNoteSource?.kind).toBe('situation');
    }
  });
});

describe('Invoice.fromSignedQuote — remises B3 et retenue B5', () => {
  it('acompte V2 : ses lignes et son TTC portent 30 % du marché remisé, sans double remise', () => {
    const r = Invoice.fromSignedQuote(signedQuote({ depositPct: 30, globalDiscountPct: 10 }), 'deposit', 'inv1');
    if (!r.ok) throw new Error('deposit');
    const t = r.value.totals();
    expect(t.ttc).toBe(43956);
    expect(t.netToPay).toBe(43956);
    expect(t.duePayableCents).toBe(43956);
    expect(r.value.globalDiscount).toBeNull();
    expect(r.value.lines.every((line) => line.label.startsWith('Acompte 30 % — '))).toBe(true);
  });
  it('acompte : PAS de retenue de garantie (elle précède l’exécution)', () => {
    const r = Invoice.fromSignedQuote(signedQuote({ depositPct: 30, retenuePct: 5 }), 'deposit', 'inv1');
    if (!r.ok) throw new Error('deposit');
    expect(r.value.retenueGarantiePct).toBeNull();
    expect('retenueGarantieCents' in r.value.totals()).toBe(false);
  });
  it('finale avec retenue seule : net = TTC − 5 %', () => {
    const r = Invoice.fromSignedQuote(signedQuote({ retenuePct: 5 }), 'final', 'inv1');
    if (!r.ok) throw new Error('final');
    const t = r.value.totals();
    expect(t.ttc).toBe(162800);
    expect(t.retenueGarantieCents).toBe(8140);
    expect(t.netToPay).toBe(154660);
  });
  it('finale après acompte + situation : lignes résiduelles, reprise avance et retenue distinctes', () => {
    const r = Invoice.fromSignedQuote(signedQuote({ retenuePct: 5 }), 'final', 'inv1', {
      depositDeduction: { amountCents: 97680, invoiceId: null },
      situationDeductionCents: 48840,
      situationBilledHtCents: 44400,
      situationBilledByQuoteLineCents: { l1: 24000, l2: 20400 },
      precedingInvoices: [
        { invoiceId: 'dep-1', kind: 'deposit', number: 'F-2026-0001', issuedAt: ISSUED },
        { invoiceId: 'sit-1', kind: 'situation', number: 'F-2026-0002', issuedAt: ISSUED },
      ],
    });
    if (!r.ok) throw new Error('final');
    const t = r.value.totals();
    // Lignes restantes : 113 960 TTC ; reprise d'avance : 48 840 ; créance : 65 120.
    // La retenue porte sur les travaux résiduels, pas sur l'avance : 5 % = 5 698.
    expect(t.ttc).toBe(113960);
    expect(t.duePayableCents).toBe(65120);
    expect(t.retenueGarantieCents).toBe(5698);
    expect(t.netToPay).toBe(59422);
    expect(r.value.situationDeductionCents).toBe(48840);
  });
  it('part situations > déduction totale → refus', () => {
    const r = Invoice.fromSignedQuote(signedQuote(), 'final', 'inv1', {
      depositDeduction: { amountCents: 1000, invoiceId: null },
      situationDeductionCents: 1001,
    });
    expect(r.ok).toBe(false);
  });
});

describe('Invoice.composeStandalone (B1) — facture directe', () => {
  it('sans urgence : composée nue (b2b/syndic/régie), aucun fait inventé', () => {
    const r = Invoice.composeStandalone({ id: 'inv1', companyId: 'c1', customerId: 'k1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.urgentRepair).toBeNull();
      expect(r.value.parentQuoteId).toBeNull();
    }
  });
  it('urgence tracée : fait horodaté + événement dédié + round-trip snapshot', () => {
    const r = Invoice.composeStandalone({
      id: 'inv1',
      companyId: 'c1',
      customerId: 'k1',
      urgentRepair: { requestedAt: AT },
    });
    if (!r.ok) throw new Error('invoice');
    expect(r.value.urgentRepair).toEqual({ requestedAt: AT });
    expect(r.value.pullEvents().some((e) => e.type === 'InvoiceUrgentRepairDeclared')).toBe(true);
    const rehydrated = Invoice.rehydrate(r.value.toSnapshot());
    expect(rehydrated.urgentRepair).toEqual({ requestedAt: AT });
  });
  it('setGlobalDiscount : autorisé sur facture directe, refusé sur pièce dérivée d’un devis', () => {
    const standalone = Invoice.composeStandalone({ id: 'inv1', companyId: 'c1', customerId: 'k1' });
    if (!standalone.ok) throw new Error('invoice');
    standalone.value.addLine(lines[0]!);
    expect(standalone.value.setGlobalDiscount({ type: 'percent', value: 10 }).ok).toBe(true);
    expect(standalone.value.totals().ht).toBe(72000);

    const derived = Invoice.fromSignedQuote(signedQuote(), 'final', 'inv2');
    if (!derived.ok) throw new Error('final');
    expect(derived.value.setGlobalDiscount({ type: 'percent', value: 10 }).ok).toBe(false);
  });
  it('issue() refuse une remise globale en montant devenue > HT (fail-closed au figeage)', () => {
    const r = Invoice.composeStandalone({ id: 'inv1', companyId: 'c1', customerId: 'k1' });
    if (!r.ok) throw new Error('invoice');
    const inv = r.value;
    inv.addLine(lines[0]!); // 80 000
    inv.addLine(lines[1]!); // 68 000
    expect(inv.setGlobalDiscount({ type: 'amount', cents: 100000 }).ok).toBe(true);
    // Les lignes bougent encore en brouillon : on réduit à une seule ligne de 80 000.
    const snapshot = inv.toSnapshot();
    snapshot.lines = [lines[0]!];
    const shrunk = Invoice.rehydrate(snapshot);
    shrunk.assignNumber(DocNumber.format('F', 2026, 9), AT);
    const issued = shrunk.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' });
    expect(issued.ok).toBe(false);
  });
});
