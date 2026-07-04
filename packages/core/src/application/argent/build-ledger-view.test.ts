import { describe, it, expect } from 'vitest';
import {
  buildLedgerView,
  type LedgerEntryData,
  type LedgerExpenseData,
  type LedgerInvoiceData,
} from './build-ledger-view';

/** Écriture de vente (facture émise) : 411 débit ; 706 + 44571 crédit. */
function saleEntry(htCents: number, vatCents: number): LedgerEntryData {
  return {
    lines: [
      { account: '411', debitCents: htCents + vatCents, creditCents: 0 },
      { account: '706', debitCents: 0, creditCents: htCents },
      { account: '44571', debitCents: 0, creditCents: vatCents },
    ],
  };
}

/** Écriture d'encaissement : 512 débit ; 411 crédit. */
function paymentEntry(amountCents: number, account: '512' | '530' = '512'): LedgerEntryData {
  return {
    lines: [
      { account, debitCents: amountCents, creditCents: 0 },
      { account: '411', debitCents: 0, creditCents: amountCents },
    ],
  };
}

/** Écriture d'achat (cycle E1) : 606 + 44566 débit ; 401 crédit — la déductible vit au livre. */
function purchaseEntry(htCents: number, vatCents: number): LedgerEntryData {
  return {
    lines: [
      { account: '606', debitCents: htCents, creditCents: 0 },
      { account: '44566', debitCents: vatCents, creditCents: 0 },
      { account: '401', debitCents: 0, creditCents: htCents + vatCents },
    ],
  };
}

function invoice(overrides: Partial<LedgerInvoiceData> = {}): LedgerInvoiceData {
  return { kind: 'final', status: 'issued', totals: { netToPay: 120000 }, paid: 0, ...overrides };
}

function expense(overrides: Partial<LedgerExpenseData> = {}): LedgerExpenseData {
  return { status: 'to_pay', totalTtcCents: 30000, vatCents: 5000, ...overrides };
}

describe('buildLedgerView', () => {
  it('total = solde + Σ rangées signées (signes corrects sur chaque ligne)', () => {
    const view = buildLedgerView({
      invoices: [invoice({ totals: { netToPay: 570000 } })],
      expenses: [expense({ totalTtcCents: 290000, vatCents: 10000 })],
      // La déductible se lit AU GRAND-LIVRE (44566 posté par le cycle achats E1).
      accountingEntries: [saleEntry(500000, 134000), paymentEntry(682000), purchaseEntry(50000, 10000)],
    });

    expect(view.bankCents).toBe(682000); // 512 débit − crédit
    expect(view.receivablesCents).toBe(570000); // + entre
    expect(view.chargesCents).toBe(-290000); // − sort
    expect(view.vatCents).toBe(-124000); // − (134 000 collectée − 10 000 déductible au 44566)
    expect(view.cotisationsCents).toBeNull(); // aucune source côté client

    // Cohérence du contrat C11 : total = lead + Σ rangées présentes.
    const rows = [view.bankCents, view.receivablesCents, view.chargesCents, view.vatCents];
    const sum = rows.reduce<number>((acc, cents) => acc + (cents ?? 0), 0);
    expect(view.totalCents).toBe(sum);
    expect(view.totalCents).toBe(682000 + 570000 - 290000 - 124000);
  });

  it('factures attendues : plafond netToPay − paid, statuts encaissables seulement, avoirs en déduction', () => {
    const view = buildLedgerView({
      invoices: [
        invoice({ status: 'partially_paid', totals: { netToPay: 100000 }, paid: 40000 }), // reste 600
        invoice({ status: 'paid', totals: { netToPay: 999900 }, paid: 999900 }), // payée → 0
        invoice({ status: 'draft', totals: { netToPay: 50000 } }), // brouillon → 0
        invoice({ kind: 'credit_note', status: 'issued', totals: { netToPay: 10000 } }), // avoir → −100
      ],
    });
    expect(view.receivablesCents).toBe(60000 - 10000);
  });

  it('source absente → ligne null (« — ») et total sur les lignes présentes uniquement', () => {
    const view = buildLedgerView({ invoices: [invoice({ totals: { netToPay: 80000 } })] });
    expect(view.bankCents).toBeNull();
    expect(view.chargesCents).toBeNull();
    expect(view.vatCents).toBeNull(); // TVA exige écritures ET dépenses
    expect(view.totalCents).toBe(80000);

    const empty = buildLedgerView({});
    expect(empty.totalCents).toBeNull();
    expect(empty.reserve).toEqual({ vatCents: null, chargesCents: null });
  });

  it('TVA nette plancher 0 (déductible > collectée) et réserve = valeurs positives TVA + charges', () => {
    const view = buildLedgerView({
      expenses: [expense({ totalTtcCents: 110000 })],
      accountingEntries: [saleEntry(100000, 20000), paymentEntry(15000, '530'), purchaseEntry(800000, 200000)],
    });
    expect(view.vatCents).toBe(0); // jamais une TVA « négative » (crédit) dans le grand-livre, ni un -0
    expect(view.bankCents).toBe(15000); // la caisse (530) compte comme trésorerie
    expect(view.reserve.vatCents).toBe(0);
    expect(view.reserve.chargesCents).toBe(110000); // charges à mettre de côté, en positif
  });

  it('les dépenses payées ne comptent plus dans les charges prévues', () => {
    const view = buildLedgerView({
      expenses: [expense({ status: 'paid', totalTtcCents: 500000, vatCents: null })],
      accountingEntries: [],
    });
    expect(view.chargesCents).toBe(0);
    expect(view.vatCents).toBe(0);
  });
});
