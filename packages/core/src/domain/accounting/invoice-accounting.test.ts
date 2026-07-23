import { describe, it, expect } from 'vitest';
import { Invoice } from '../billing/invoice/invoice';
import { Quote } from '../billing/quote/quote';
import { type QuoteLine } from '../billing/shared/line';
import { DocNumber } from '../billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { createFrenchOperationalChartOfAccounts } from './chart-of-accounts';
import { buildIssuedInvoiceAccountingEntry, buildInvoiceAccountingPreviewEntry } from './invoice-accounting';

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

function signedQuote(depositPct: number | null): Quote {
  const q = Quote.compose({ id: 'q1', companyId: 'co-1', customerId: 'customer-1', at: AT });
  if (!q.ok) throw new Error('quote');
  for (const line of lines) q.value.addLine(line);
  q.value.setDeposit(depositPct);
  q.value.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.value.send(AT);
  q.value.sign({ signerName: 'Durand', signedAt: AT, method: 'onsite_draw', accepted: true }, AT);
  return q.value;
}

function issuedInvoice(mode: 'final' | 'deposit'): Invoice {
  const inv = Invoice.fromSignedQuote(signedQuote(mode === 'deposit' ? 30 : null), mode, 'inv-1');
  if (!inv.ok) throw new Error('invoice');
  inv.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
  inv.value.issue({
    mentions: [],
    terms,
    issuedAt: ISSUED,
    at: AT,
    vatTreatment: 'standard',
    frenchBillingMode: 'S1',
  });
  return inv.value;
}

function issuedCreditNote(source: Invoice, id: string, sequence: number): Invoice {
  const credit = Invoice.creditNoteFor(source, id);
  if (!credit.ok) throw new Error('credit note');
  credit.value.assignNumber(DocNumber.format('A', 2026, sequence), AT);
  credit.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: source.frenchBillingModeAtIssuance ?? 'S1' });
  return credit.value;
}

describe('buildIssuedInvoiceAccountingEntry', () => {
  it('mappe une facture finale en 411 / ventes / TVA collectee', () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-1', invoice: issuedInvoice('final'), chart: chart.value });

    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.totalDebitCents).toBe(162800);
      expect(r.value.totalCreditCents).toBe(162800);
      expect(r.value.lines).toEqual([
        { account: '411', label: 'Facture F-2026-0001', debitCents: 162800, creditCents: 0 },
        { account: '707', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 80000 },
        { account: '706', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 68000 },
        { account: '44571', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 14800 },
      ]);
    }
  });

  it("mappe une facture d'acompte sur 4191 sans comptabiliser tout le CA", () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-1', invoice: issuedInvoice('deposit'), chart: chart.value });

    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.totalDebitCents).toBe(48840);
      expect(r.value.totalCreditCents).toBe(48840);
      expect(r.value.lines).toEqual([
        { account: '411', label: 'Facture F-2026-0001', debitCents: 48840, creditCents: 0 },
        { account: '4191', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 44400 },
        { account: '44571', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 4440 },
      ]);
    }
  });

  it("l'avoir total d'un acompte inverse exactement le 411, le 4191 et la TVA de sa source", () => {
    const source = issuedInvoice('deposit');
    const credit = issuedCreditNote(source, 'credit-deposit', 1);
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-credit-deposit', invoice: credit });

    expect(r.ok).toBe(true);
    if (!r.ok || r.value === null) return;
    expect(credit.totals()).toEqual(source.totals());
    expect(r.value.lines).toEqual([
      { account: '4191', label: 'Avoir A-2026-0001', debitCents: 44400, creditCents: 0 },
      { account: '44571', label: 'Avoir A-2026-0001', debitCents: 4440, creditCents: 0 },
      { account: '411', label: 'Avoir A-2026-0001', debitCents: 0, creditCents: 48840 },
    ]);
  });

  // ── Finale après acompte (bug d'équilibre corrigé) ────────────────────────────
  // Sans reprise 4191, l'écriture créditait CA + TVA pleins contre un 411 au solde :
  // déséquilibre = acompte → rejet → facture émise SANS écriture de vente (CA perdu).

  function issuedFinalAfterDeposit(depositCents: number, quoteLines: QuoteLine[] = lines): Invoice {
    const q = Quote.compose({ id: 'q1', companyId: 'co-1', customerId: 'customer-1', at: AT });
    if (!q.ok) throw new Error('quote');
    for (const line of quoteLines) q.value.addLine(line);
    q.value.setDeposit(30);
    q.value.assignNumber(DocNumber.format('D', 2026, 1), AT);
    q.value.send(AT);
    q.value.sign({ signerName: 'Durand', signedAt: AT, method: 'onsite_draw', accepted: true }, AT);
    const inv = Invoice.fromSignedQuote(q.value, 'final', 'inv-2', {
      depositDeduction: { amountCents: depositCents, invoiceId: 'inv-1' },
      precedingInvoices: [{
        invoiceId: 'inv-1',
        kind: 'deposit',
        number: 'F-2026-0001',
        issuedAt: ISSUED,
      }],
    });
    if (!inv.ok) throw new Error('invoice');
    inv.value.assignNumber(DocNumber.format('F', 2026, 2), AT);
    inv.value.issue({
      mentions: [],
      terms,
      issuedAt: ISSUED,
      at: AT,
      vatTreatment: 'standard',
      frenchBillingMode: 'S1',
    });
    return inv.value;
  }

  it('mappe une finale après acompte : solde en 411, reprise 4191/44571 miroir, CA plein', () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;
    // Acompte 30 % du proto : 48 840 ventilé 44 400 (HT) + 4 440 (TVA) — cf. test acompte.
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-2', invoice: issuedFinalAfterDeposit(48840), chart: chart.value });

    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.totalDebitCents).toBe(162800);
      expect(r.value.totalCreditCents).toBe(162800);
      expect(r.value.lines).toEqual([
        { account: '411', label: 'Facture F-2026-0002', debitCents: 113960, creditCents: 0 },
        { account: '4191', label: 'Facture F-2026-0002', debitCents: 44400, creditCents: 0 },
        { account: '44571', label: 'Facture F-2026-0002', debitCents: 4440, creditCents: 0 },
        { account: '707', label: 'Facture F-2026-0002', debitCents: 0, creditCents: 80000 },
        { account: '706', label: 'Facture F-2026-0002', debitCents: 0, creditCents: 68000 },
        { account: '44571', label: 'Facture F-2026-0002', debitCents: 0, creditCents: 14800 },
      ]);
    }
  });

  it("l'avoir total d'une finale après acompte annule aussi la reprise d'avance, au centime", () => {
    const source = issuedFinalAfterDeposit(48840);
    const credit = issuedCreditNote(source, 'credit-final', 2);
    const sourceEntry = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-source-final', invoice: source });
    const creditEntry = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-credit-final', invoice: credit });

    expect(sourceEntry.ok).toBe(true);
    expect(creditEntry.ok).toBe(true);
    if (!sourceEntry.ok || !creditEntry.ok) return;
    if (sourceEntry.value === null || creditEntry.value === null) throw new Error("entree attendue");
    expect(credit.totals()).toEqual(source.totals());
    expect(credit.depositDeductionCents).toBe(48840);

    const balances = new Map<string, number>();
    for (const line of [...sourceEntry.value.lines, ...creditEntry.value.lines]) {
      balances.set(
        line.account,
        (balances.get(line.account) ?? 0) + line.debitCents - line.creditCents,
      );
    }
    expect(Object.fromEntries(balances)).toEqual({
      '411': 0,
      '4191': 0,
      '44571': 0,
      '707': 0,
      '706': 0,
    });
  });

  it('solde le 4191 au centime sur acompte + finale, multi-taux inclus', () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;
    // Montants voulus indivisibles par 30 % : la répartition au plus fort reste doit se
    // refléter à l'identique dans la reprise (déterminisme d'allocateAmounts).
    const mixed: QuoteLine[] = [
      { id: 'l1', label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 77777, vatRate: 10 },
      { id: 'l2', label: 'Matériel', category: 'supply', qty: 1, unitPriceHT: 33333, vatRate: 20 },
    ];
    const q = Quote.compose({ id: 'q1', companyId: 'co-1', customerId: 'customer-1', at: AT });
    if (!q.ok) throw new Error('quote');
    for (const line of mixed) q.value.addLine(line);
    q.value.setDeposit(30);
    q.value.assignNumber(DocNumber.format('D', 2026, 1), AT);
    q.value.send(AT);
    q.value.sign({ signerName: 'Durand', signedAt: AT, method: 'onsite_draw', accepted: true }, AT);

    const dep = Invoice.fromSignedQuote(q.value, 'deposit', 'inv-1');
    if (!dep.ok) throw new Error('deposit');
    dep.value.assignNumber(DocNumber.format('F', 2026, 1), AT);
    dep.value.issue({ mentions: [], terms, issuedAt: ISSUED, at: AT, frenchBillingMode: 'S1' });
    const depositEntry = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-1', invoice: dep.value, chart: chart.value });
    expect(depositEntry.ok).toBe(true);
    if (!depositEntry.ok || depositEntry.value === null) return;

    const finalEntry = buildIssuedInvoiceAccountingEntry({
      entryId: 'ae-2',
      invoice: issuedFinalAfterDeposit(dep.value.totals().netToPay, mixed),
      chart: chart.value,
    });
    expect(finalEntry.ok).toBe(true);
    if (!finalEntry.ok || finalEntry.value === null) return;

    expect(finalEntry.value.totalDebitCents).toBe(finalEntry.value.totalCreditCents);
    const balance4191 = [...depositEntry.value.lines, ...finalEntry.value.lines]
      .filter((line) => line.account === '4191')
      .reduce((sum, line) => sum + line.creditCents - line.debitCents, 0);
    expect(balance4191).toBe(0);
    // La TVA collectée cumulée des deux pièces = TVA totale du chantier, jamais plus.
    const vat = [...depositEntry.value.lines, ...finalEntry.value.lines]
      .filter((line) => line.account === '44571')
      .reduce((sum, line) => sum + line.creditCents - line.debitCents, 0);
    expect(vat).toBe(14445); // 7 778 (10 % de 77 777) + 6 667 (20 % de 33 333), arrondis par taux
  });

  it('accepte une finale entièrement couverte (netToPay = 0) : le CA se constate, sans ligne 411', () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;
    const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-2', invoice: issuedFinalAfterDeposit(162800), chart: chart.value });

    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.totalDebitCents).toBe(162800);
      expect(r.value.totalCreditCents).toBe(162800);
      expect(r.value.lines.some((line) => line.account === '411')).toBe(false);
    }
  });

  it('refuse une facture non emise', () => {
    const inv = Invoice.fromSignedQuote(signedQuote(null), 'final', 'inv-1');
    expect(inv.ok && inv.value !== null).toBe(true);
    if (inv.ok && inv.value !== null) {
      const r = buildIssuedInvoiceAccountingEntry({ entryId: 'ae-1', invoice: inv.value });
      expect(r.ok).toBe(false);
    }
  });
});

describe('buildInvoiceAccountingPreviewEntry', () => {
  it('preview une facture brouillon sans numero ni allocation no-gap', () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    const inv = Invoice.fromSignedQuote(signedQuote(null), 'final', 'inv-1');
    expect(inv.ok).toBe(true);
    if (!chart.ok || !inv.ok) return;

    const r = buildInvoiceAccountingPreviewEntry({
      entryId: 'preview-1',
      invoice: inv.value,
      entryDate: ISSUED,
      reference: 'a-emettre',
      chart: chart.value,
    });

    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(inv.value.number).toBeNull();
      expect(r.value.reference).toBe('a-emettre');
      expect(r.value.entryDate).toBe(ISSUED);
      expect(r.value.totalDebitCents).toBe(162800);
      expect(r.value.lines).toEqual([
        { account: '411', label: 'Facture a-emettre', debitCents: 162800, creditCents: 0 },
        { account: '707', label: 'Facture a-emettre', debitCents: 0, creditCents: 80000 },
        { account: '706', label: 'Facture a-emettre', debitCents: 0, creditCents: 68000 },
        { account: '44571', label: 'Facture a-emettre', debitCents: 0, creditCents: 14800 },
      ]);
    }
  });

  it("preview une facture d'acompte brouillon sur 4191", () => {
    const chart = createFrenchOperationalChartOfAccounts('co-1');
    expect(chart.ok).toBe(true);
    const inv = Invoice.fromSignedQuote(signedQuote(30), 'deposit', 'inv-1');
    expect(inv.ok).toBe(true);
    if (!chart.ok || !inv.ok) return;

    const r = buildInvoiceAccountingPreviewEntry({
      entryId: 'preview-1',
      invoice: inv.value,
      entryDate: ISSUED,
      reference: 'a-emettre',
      chart: chart.value,
    });

    expect(r.ok && r.value !== null).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.totalDebitCents).toBe(48840);
      expect(r.value.lines.map((line) => line.account)).toEqual(['411', '4191', '44571']);
    }
  });
});
