import { describe, it, expect } from 'vitest';
import { Invoice } from '../billing/invoice/invoice';
import { Quote } from '../billing/quote/quote';
import { type QuoteLine } from '../billing/shared/line';
import { DocNumber } from '../billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { createFrenchOperationalChartOfAccounts } from './chart-of-accounts';
import { buildIssuedInvoiceAccountingEntry } from './invoice-accounting';

const AT = '2026-06-01T10:00:00.000Z';
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

function signedQuote(opts?: { depositPct?: number; retenuePct?: number; globalDiscountPct?: number }): Quote {
  const q = Quote.compose({ id: 'q1', companyId: 'co-1', customerId: 'customer-1', at: AT });
  if (!q.ok) throw new Error('quote');
  for (const line of lines) q.value.addLine(line);
  if (opts?.depositPct !== undefined) q.value.setDeposit(opts.depositPct);
  if (opts?.retenuePct !== undefined) q.value.setRetenueGarantie(opts.retenuePct);
  if (opts?.globalDiscountPct !== undefined)
    q.value.setGlobalDiscount({ type: 'percent', value: opts.globalDiscountPct });
  q.value.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.value.send(AT);
  q.value.sign({ signerName: 'Durand', signedAt: AT, method: 'onsite_draw', accepted: true }, AT);
  return q.value;
}

function chart() {
  const r = createFrenchOperationalChartOfAccounts('co-1');
  if (!r.ok) throw new Error('chart');
  return r.value;
}

function issueIt(invoice: Invoice, sequence = 1): Invoice {
  invoice.assignNumber(DocNumber.format('F', 2026, sequence), AT);
  const issued = invoice.issue({
    mentions: [],
    terms,
    issuedAt: ISSUED,
    at: AT,
    vatTreatment: 'standard',
    frenchBillingMode: 'S1',
  });
  if (!issued.ok) throw new Error('issue');
  return invoice;
}

describe('invoice-accounting — situations B2 et retenue B5', () => {
  it('situation SANS retenue : 411 net ; 70x + TVA sur l’avancement (équilibrée)', () => {
    const situation = Invoice.situationFromSignedQuote(signedQuote(), 'inv-1', {
      order: 1,
      targetHtCents: 44400,
    });
    if (!situation.ok) throw new Error('situation');
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-1', invoice: issueIt(situation.value), chart: chart() });
    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.totalDebitCents).toBe(r.value.totalCreditCents);
      expect(r.value.lines).toEqual([
        { account: '411', label: 'Facture F-2026-0001', debitCents: 48840, creditCents: 0 },
        { account: '707', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 24000 },
        { account: '706', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 20400 },
        { account: '44571', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 4440 },
      ]);
    }
  });
  it('situation AVEC retenue 5 % : 411 net + 4117 retenue, CA/TVA pleins (équilibrée)', () => {
    const situation = Invoice.situationFromSignedQuote(signedQuote({ retenuePct: 5 }), 'inv-1', {
      order: 1,
      targetHtCents: 44400,
    });
    if (!situation.ok) throw new Error('situation');
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-1', invoice: issueIt(situation.value), chart: chart() });
    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.totalDebitCents).toBe(r.value.totalCreditCents);
      const debit411 = r.value.lines.find((l) => l.account === '411');
      const debit4117 = r.value.lines.find((l) => l.account === '4117');
      expect(debit411?.debitCents).toBe(46398);
      expect(debit4117?.debitCents).toBe(2442);
    }
  });
  it('finale APRÈS acompte + situation : reprise 4191 = part acompte SEULE, CA réduit de la part situations', () => {
    // Marché 162 800 TTC. Acompte 30 % = 48 840 ; situation 48 840 TTC (44 400 HT).
    const final = Invoice.fromSignedQuote(signedQuote(), 'final', 'inv-3', {
      depositDeduction: { amountCents: 97680, invoiceId: null },
      situationDeductionCents: 48840,
      situationBilledHtCents: 44400,
      situationBilledByQuoteLineCents: { l1: 24000, l2: 20400 },
      precedingInvoices: [
        { invoiceId: 'dep-1', kind: 'deposit', number: 'F-2026-0001', issuedAt: ISSUED },
        { invoiceId: 'sit-1', kind: 'situation', number: 'F-2026-0002', issuedAt: ISSUED },
      ],
    });
    if (!final.ok) throw new Error('final');
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-3', invoice: issueIt(final.value, 3), chart: chart() });
    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.totalDebitCents).toBe(r.value.totalCreditCents);
      // 411 = solde 65 120 ; débits reprise (4191 + 44571) = 48 840 (part ACOMPTE uniquement).
      const debit411 = r.value.lines.find((l) => l.account === '411' && l.debitCents > 0);
      expect(debit411?.debitCents).toBe(65120);
      const reprise4191 = r.value.lines.find((l) => l.account === '4191' && l.debitCents > 0);
      const repriseTva = r.value.lines.find((l) => l.account === '44571' && l.debitCents > 0);
      expect((reprise4191?.debitCents ?? 0) + (repriseTva?.debitCents ?? 0)).toBe(48840);
      // CA crédité = TTC − part situations (162 800 − 48 840 = 113 960 répartis CA + TVA).
      const credits = r.value.lines.filter((l) => l.creditCents > 0);
      expect(credits.reduce((sum, l) => sum + l.creditCents, 0)).toBe(113960);
    }
  });
  it('facture remisée B3 : le CA crédité est le CA NET (équilibrée au centime)', () => {
    const final = Invoice.fromSignedQuote(signedQuote({ globalDiscountPct: 10 }), 'final', 'inv-4');
    if (!final.ok) throw new Error('final');
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-4', invoice: issueIt(final.value, 4), chart: chart() });
    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.totalDebitCents).toBe(r.value.totalCreditCents);
      expect(r.value.totalDebitCents).toBe(146520); // TTC remisé
      const revenue = r.value.lines.filter((l) => (l.account === '706' || l.account === '707') && l.creditCents > 0);
      expect(revenue.reduce((sum, l) => sum + l.creditCents, 0)).toBe(133200); // HT net
    }
  });
  it('avoir sur situation avec retenue : miroir exact (4117 au crédit)', () => {
    const situation = Invoice.situationFromSignedQuote(signedQuote({ retenuePct: 5 }), 'inv-5', {
      order: 1,
      targetHtCents: 44400,
    });
    if (!situation.ok) throw new Error('situation');
    const issued = issueIt(situation.value, 5);
    const creditNote = Invoice.creditNoteFor(issued, 'cn-1');
    if (!creditNote.ok) throw new Error('credit note');
    creditNote.value.assignNumber(DocNumber.format('A', 2026, 1), AT);
    creditNote.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: issued.frenchBillingModeAtIssuance ?? 'S1' });
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-5', invoice: creditNote.value, chart: chart() });
    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.totalDebitCents).toBe(r.value.totalCreditCents);
      const credit4117 = r.value.lines.find((l) => l.account === '4117');
      expect(credit4117?.creditCents).toBe(2442);
      const credit411 = r.value.lines.find((l) => l.account === '411');
      expect(credit411?.creditCents).toBe(46398);
    }
  });
  it('finale SOLDÉE PAR SITUATIONS SEULES (100 %) : refuse une pièce fiscale à zéro', () => {
    const final = Invoice.fromSignedQuote(signedQuote(), 'final', 'inv-6', {
      depositDeduction: { amountCents: 162800, invoiceId: null },
      situationDeductionCents: 162800,
      situationBilledHtCents: 148000,
      situationBilledByQuoteLineCents: { l1: 80000, l2: 68000 },
      precedingInvoices: [
        { invoiceId: 'sit-100', kind: 'situation', number: 'F-2026-0001', issuedAt: ISSUED },
      ],
    });
    expect(final.ok).toBe(false);
    if (!final.ok && final.error.code === 'VALIDATION') {
      expect(final.error.field).toBe('situationBilledHtCents');
    }
  });
  it('une finale à zéro refusée ne peut donc jamais produire un avoir fantôme', () => {
    const final = Invoice.fromSignedQuote(signedQuote(), 'final', 'inv-7', {
      depositDeduction: { amountCents: 162800, invoiceId: null },
      situationDeductionCents: 162800,
      situationBilledHtCents: 148000,
      situationBilledByQuoteLineCents: { l1: 80000, l2: 68000 },
      precedingInvoices: [
        { invoiceId: 'sit-100', kind: 'situation', number: 'F-2026-0001', issuedAt: ISSUED },
      ],
    });
    expect(final.ok).toBe(false);
  });
  it('cas SYMÉTRIQUE — finale couverte à 100 % par acompte + situations : écriture NON vide (reprise 4191)', () => {
    // Acompte 48 840 + situations 113 960 = TTC 162 800 → netToPay 0 MAIS reprise 4191 > 0.
    const final = Invoice.fromSignedQuote(signedQuote({ depositPct: 30 }), 'final', 'inv-8', {
      depositDeduction: { amountCents: 162800, invoiceId: null },
      situationDeductionCents: 113960,
      situationBilledHtCents: 103600,
      situationBilledByQuoteLineCents: { l1: 56000, l2: 47600 },
      precedingInvoices: [
        { invoiceId: 'dep-1', kind: 'deposit', number: 'F-2026-0001', issuedAt: ISSUED },
        { invoiceId: 'sit-1', kind: 'situation', number: 'F-2026-0002', issuedAt: ISSUED },
      ],
    });
    if (!final.ok) throw new Error('final');
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-8', invoice: issueIt(final.value, 8), chart: chart() });
    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value).not.toBeNull();
      if (r.value === null) return;
      expect(r.value.totalDebitCents).toBe(r.value.totalCreditCents);
      expect(r.value.totalDebitCents).toBeGreaterThan(0);
    }
  });
});
