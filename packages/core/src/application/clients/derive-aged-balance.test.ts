import { describe, expect, it } from 'vitest';
import { deriveAgedBalance, type AgedBalanceInvoiceData } from './derive-aged-balance';

const TODAY = '2026-07-04';
const TOTALS = (netToPay: number) => ({ ht: 0, vatByRate: {}, vat: 0, ttc: netToPay, netToPay });

function invoice(over: Partial<AgedBalanceInvoiceData> = {}): AgedBalanceInvoiceData {
  return { kind: 'final', status: 'issued', totals: TOTALS(100000), paid: 0, dueAt: '2026-07-20', customerId: 'c1', ...over };
}

const CUSTOMERS = [
  { id: 'c1', name: 'Mairie de Sèvres' },
  { id: 'c2', name: 'SARL Martin' },
];

describe('deriveAgedBalance (E5 — pilotage du poste clients)', () => {
  it('ventile par retard d’échéance : non échu / 1-30 / 31-60 / 61-90 / +90 / inconnu', () => {
    const b = deriveAgedBalance({
      invoices: [
        invoice({ dueAt: '2026-07-20' }), // non échu
        invoice({ dueAt: '2026-06-20', status: 'late' }), // 14 j
        invoice({ dueAt: '2026-05-20', status: 'late' }), // 45 j
        invoice({ dueAt: '2026-04-20', status: 'late' }), // 75 j
        invoice({ dueAt: '2026-01-20', status: 'late' }), // 165 j
        invoice({ dueAt: null }), // inconnu
      ],
      customers: CUSTOMERS,
      today: TODAY,
    });
    expect(b.buckets).toEqual({
      not_due: 100000,
      d1_30: 100000,
      d31_60: 100000,
      d61_90: 100000,
      d90_plus: 100000,
      unknown: 100000,
    });
    expect(b.totalCents).toBe(600000);
    expect(b.overdueCents).toBe(400000); // seul l'échu
  });

  it('assiette = netToPay − paid (plafond doctrine), statuts encaissables seulement', () => {
    const b = deriveAgedBalance({
      invoices: [
        invoice({ status: 'partially_paid', paid: 40000 }), // reste 600 €
        invoice({ status: 'paid', paid: 100000 }), // rien
        invoice({ status: 'draft' }), // exclu
        invoice({ status: 'cancelled' }), // exclu
      ],
      customers: CUSTOMERS,
      today: TODAY,
    });
    expect(b.totalCents).toBe(60000);
  });

  it('avoir émis : NÉGATIF dans sa tranche — le dû réel du client baisse', () => {
    const b = deriveAgedBalance({
      invoices: [invoice({ dueAt: '2026-06-20', status: 'late' }), invoice({ kind: 'credit_note', totals: TOTALS(20000), dueAt: '2026-06-20' })],
      customers: CUSTOMERS,
      today: TODAY,
    });
    expect(b.buckets.d1_30).toBe(80000);
  });

  it('par client : trié du plus gros dû, retard max porté, clients à zéro exclus', () => {
    const b = deriveAgedBalance({
      invoices: [
        invoice({ customerId: 'c1', dueAt: '2026-01-20', status: 'late', totals: TOTALS(185000) }), // 165 j
        invoice({ customerId: 'c2', dueAt: '2026-06-30', status: 'late', totals: TOTALS(50000) }), // 4 j
        invoice({ customerId: 'c2', status: 'paid', paid: 100000 }),
      ],
      customers: CUSTOMERS,
      today: TODAY,
    });
    expect(b.byCustomer.map((l) => l.customerId)).toEqual(['c1', 'c2']);
    expect(b.byCustomer[0]).toMatchObject({ customerName: 'Mairie de Sèvres', totalCents: 185000, maxDaysLate: 165 });
    expect(b.byCustomer[1]?.maxDaysLate).toBe(4);
  });
});
