import { describe, expect, it } from 'vitest';
import {
  deriveCustomerFinancialMetrics,
  MIN_SETTLED_INVOICES_FOR_PAYMENT_METRICS,
  type CustomerFinancialMetricInvoiceData,
  type CustomerFinancialMetricPaymentData,
  type DeriveCustomerFinancialMetricsInput,
} from './derive-customer-financial-metrics';

function invoice(
  overrides: Partial<CustomerFinancialMetricInvoiceData> = {},
): CustomerFinancialMetricInvoiceData {
  return {
    id: 'inv-1',
    companyId: 'co-a',
    customerId: 'cus-a',
    kind: 'final',
    status: 'issued',
    totals: { netToPay: 100_000 },
    paid: 0,
    issuedAt: '2026-06-10',
    dueAt: '2026-07-10',
    sourceInvoiceId: null,
    ...overrides,
  };
}

function payment(
  overrides: Partial<CustomerFinancialMetricPaymentData> = {},
): CustomerFinancialMetricPaymentData {
  return {
    id: 'pay-1',
    companyId: 'co-a',
    invoiceId: 'inv-1',
    amount: 100_000,
    receivedAt: '2026-07-10T10:00:00.000Z',
    ...overrides,
  };
}

function derive(overrides: Partial<DeriveCustomerFinancialMetricsInput> = {}) {
  return deriveCustomerFinancialMetrics({
    companyId: 'co-a',
    customerId: 'cus-a',
    invoices: [],
    payments: [],
    ...overrides,
  });
}

function value(result: ReturnType<typeof deriveCustomerFinancialMetrics>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected error: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('deriveCustomerFinancialMetrics — encours réel', () => {
  it('compte neuf : aucun faux score, aucun faux délai et aucun encours', () => {
    const metrics = value(derive());
    expect(metrics).toEqual({
      companyId: 'co-a',
      customerId: 'cus-a',
      grossReceivableCents: 0,
      issuedCreditCents: 0,
      outstandingCents: 0,
      customerCreditCents: 0,
      avgDelayDays: null,
      paidOnTimeRatio: null,
      paymentHistoryStatus: 'insufficient_history',
      settledInvoiceCount: 0,
      score: null,
      scoreStatus: 'model_not_ratified',
    });
  });

  it('facture partiellement réglée : reste dû = netToPay − paid', () => {
    const metrics = value(
      derive({
        invoices: [invoice({ status: 'partially_paid', paid: 25_000 })],
        payments: [payment({ amount: 25_000 })],
      }),
    );
    expect(metrics.grossReceivableCents).toBe(75_000);
    expect(metrics.outstandingCents).toBe(75_000);
    expect(metrics.avgDelayDays).toBeNull();
  });

  it('retard : la totalité du reste dû est exposée, sans pénalité monétaire inventée', () => {
    const metrics = value(
      derive({
        invoices: [invoice({ status: 'late', paid: 10_000, issuedAt: '2026-05-01', dueAt: '2026-06-01' })],
      }),
    );
    expect(metrics.outstandingCents).toBe(90_000);
  });

  it('n’inclut que issued/partially_paid/late dans le reste dû', () => {
    const metrics = value(
      derive({
        invoices: [
          invoice({ id: 'issued', status: 'issued' }),
          invoice({ id: 'partial', status: 'partially_paid', paid: 20_000 }),
          invoice({ id: 'late', status: 'late' }),
          invoice({ id: 'draft', status: 'draft' }),
          invoice({ id: 'paid', status: 'paid', paid: 100_000 }),
          invoice({ id: 'cancelled', status: 'cancelled' }),
        ],
      }),
    );
    expect(metrics.grossReceivableCents).toBe(280_000);
  });

  it('acompte + finale : le net de finale déjà déduit est additionné une seule fois ; l’avoir réduit le dû', () => {
    const metrics = value(
      derive({
        invoices: [
          invoice({ id: 'deposit', kind: 'deposit', totals: { netToPay: 30_000 }, paid: 10_000 }),
          invoice({ id: 'final', kind: 'final', totals: { netToPay: 70_000 } }),
          invoice({
            id: 'credit',
            kind: 'credit_note',
            totals: { netToPay: 15_000 },
            sourceInvoiceId: 'final',
          }),
        ],
      }),
    );
    expect(metrics.grossReceivableCents).toBe(90_000);
    expect(metrics.issuedCreditCents).toBe(15_000);
    expect(metrics.outstandingCents).toBe(75_000);
    expect(metrics.customerCreditCents).toBe(0);
  });

  it('un excédent d’avoir devient un crédit client et jamais un encours négatif', () => {
    const metrics = value(
      derive({
        invoices: [
          invoice({ id: 'source', totals: { netToPay: 20_000 } }),
          invoice({
            id: 'credit',
            kind: 'credit_note',
            totals: { netToPay: 30_000 },
            sourceInvoiceId: 'source',
          }),
        ],
      }),
    );
    expect(metrics.outstandingCents).toBe(0);
    expect(metrics.customerCreditCents).toBe(10_000);
  });
});

describe('deriveCustomerFinancialMetrics — comportement de paiement', () => {
  it(`reste inconnu sous ${MIN_SETTLED_INVOICES_FOR_PAYMENT_METRICS} factures soldées`, () => {
    const metrics = value(
      derive({
        invoices: [
          invoice({ id: 'i1', status: 'paid', paid: 100_000 }),
          invoice({ id: 'i2', status: 'paid', paid: 100_000 }),
        ],
        payments: [
          payment({ id: 'p1', invoiceId: 'i1' }),
          payment({ id: 'p2', invoiceId: 'i2' }),
        ],
      }),
    );
    expect(metrics).toMatchObject({
      avgDelayDays: null,
      paidOnTimeRatio: null,
      paymentHistoryStatus: 'insufficient_history',
      settledInvoiceCount: 2,
      score: null,
    });
  });

  it('calcule le délai émission → paiement qui solde la facture, pondéré par les montants', () => {
    const metrics = value(
      derive({
        invoices: [
          invoice({ id: 'i1', status: 'paid', paid: 100_000 }),
          invoice({ id: 'i2', status: 'paid', totals: { netToPay: 200_000 }, paid: 200_000 }),
          invoice({ id: 'i3', kind: 'deposit', status: 'paid', totals: { netToPay: 50_000 }, paid: 50_000 }),
        ],
        payments: [
          payment({ id: 'p1a', invoiceId: 'i1', amount: 40_000, receivedAt: '2026-07-01T10:00:00.000Z' }),
          payment({ id: 'p1b', invoiceId: 'i1', amount: 60_000, receivedAt: '2026-07-14T23:00:00.000Z' }),
          payment({ id: 'p2', invoiceId: 'i2', amount: 200_000, receivedAt: '2026-07-10T10:00:00.000Z' }),
          payment({ id: 'p3', invoiceId: 'i3', amount: 50_000, receivedAt: '2026-07-20T00:01:00.000Z' }),
        ],
      }),
    );
    // Émission le 10/06 : (100 000 × 34 j + 200 000 × 30 j + 50 000 × 40 j) / 350 000 = 32,57 → 33 j.
    expect(metrics.avgDelayDays).toBe(33);
    expect(metrics.paidOnTimeRatio).toBeCloseTo(1 / 3);
    expect(metrics.paymentHistoryStatus).toBe('known');
    expect(metrics.settledInvoiceCount).toBe(3);
    expect(metrics.score).toBeNull();
  });

  it('ne fabrique pas un délai quand le journal Payment ne rapproche pas les soldes Invoice', () => {
    const metrics = value(
      derive({
        invoices: ['i1', 'i2', 'i3'].map((id) => invoice({ id, status: 'paid', paid: 100_000 })),
        payments: [
          payment({ id: 'p1', invoiceId: 'i1' }),
          payment({ id: 'p2', invoiceId: 'i2' }),
          payment({ id: 'p3', invoiceId: 'i3', amount: 90_000 }),
        ],
      }),
    );
    expect(metrics.paymentHistoryStatus).toBe('incomplete');
    expect(metrics.avgDelayDays).toBeNull();
    expect(metrics.paidOnTimeRatio).toBeNull();
    expect(metrics.settledInvoiceCount).toBe(2);
  });

  it('classe un paiement antérieur à l’émission comme historique incomplet, jamais comme délai zéro', () => {
    const metrics = value(
      derive({
        invoices: ['i1', 'i2', 'i3'].map((id) => invoice({ id, status: 'paid', paid: 100_000 })),
        payments: [
          payment({ id: 'p1', invoiceId: 'i1', receivedAt: '2026-06-09T12:00:00.000Z' }),
          payment({ id: 'p2', invoiceId: 'i2' }),
          payment({ id: 'p3', invoiceId: 'i3' }),
        ],
      }),
    );
    expect(metrics.paymentHistoryStatus).toBe('incomplete');
    expect(metrics.avgDelayDays).toBeNull();
  });

  it('exclut du comportement une facture totalement avoirisée', () => {
    const metrics = value(
      derive({
        invoices: [
          ...['i1', 'i2', 'i3'].map((id) => invoice({ id, status: 'paid', paid: 100_000 })),
          invoice({
            id: 'cn-i3',
            kind: 'credit_note',
            sourceInvoiceId: 'i3',
            totals: { netToPay: 100_000 },
          }),
        ],
        payments: [
          payment({ id: 'p1', invoiceId: 'i1' }),
          payment({ id: 'p2', invoiceId: 'i2' }),
          payment({ id: 'p3', invoiceId: 'i3' }),
        ],
      }),
    );
    expect(metrics.settledInvoiceCount).toBe(2);
    expect(metrics.paymentHistoryStatus).toBe('insufficient_history');
  });
});

describe('deriveCustomerFinancialMetrics — isolation et intégrité', () => {
  it('ignore totalement un autre tenant et un autre client, même avec des identifiants de facture identiques', () => {
    const metrics = value(
      derive({
        invoices: [
          invoice({ id: 'shared-id', totals: { netToPay: 80_000 }, paid: 10_000 }),
          invoice({
            id: 'shared-id',
            companyId: 'co-b',
            totals: { netToPay: 9_999_999 },
            status: 'late',
          }),
          invoice({ id: 'other-customer', customerId: 'cus-b', totals: { netToPay: 500_000 } }),
        ],
        payments: [
          payment({ id: 'pa', invoiceId: 'shared-id', amount: 10_000 }),
          payment({ id: 'pb', companyId: 'co-b', invoiceId: 'shared-id', amount: 9_999_999 }),
          payment({ id: 'pc', invoiceId: 'other-customer', amount: 500_000 }),
        ],
      }),
    );
    expect(metrics.grossReceivableCents).toBe(70_000);
    expect(metrics.outstandingCents).toBe(70_000);
  });

  it('refuse les doublons intra-tenant plutôt que de doubler silencieusement un montant', () => {
    const duplicateInvoice = derive({ invoices: [invoice(), invoice()] });
    expect(duplicateInvoice).toEqual({ ok: false, error: { code: 'DUPLICATE_INVOICE', invoiceId: 'inv-1' } });

    const duplicatePayment = derive({
      invoices: [invoice({ status: 'paid', paid: 100_000 })],
      payments: [payment(), payment()],
    });
    expect(duplicatePayment).toEqual({ ok: false, error: { code: 'DUPLICATE_PAYMENT', paymentId: 'pay-1' } });
  });

  it('refuse centimes et dates invalides au lieu de les convertir en faux zéros', () => {
    expect(derive({ invoices: [invoice({ totals: { netToPay: Number.NaN } })] })).toEqual({
      ok: false,
      error: { code: 'INVALID_INVOICE', invoiceId: 'inv-1', field: 'netToPay' },
    });
    expect(
      derive({
        invoices: [invoice({ status: 'paid', paid: 100_000 })],
        payments: [payment({ receivedAt: 'pas-une-date' })],
      }),
    ).toEqual({
      ok: false,
      error: { code: 'INVALID_PAYMENT', paymentId: 'pay-1', field: 'receivedAt' },
    });
    expect(derive({ invoices: [invoice({ issuedAt: '2026-07-11', dueAt: '2026-07-10' })] })).toEqual({
      ok: false,
      error: { code: 'INVALID_INVOICE', invoiceId: 'inv-1', field: 'dueAt' },
    });
  });
});
