import { describe, expect, it } from 'vitest';
import { deriveKnownReceivables, type KnownReceivableInvoice } from './derive-known-receivables';

const invoice = (overrides: Partial<KnownReceivableInvoice> = {}): KnownReceivableInvoice => ({
  id: 'inv-1',
  companyId: 'co-1',
  kind: 'final',
  status: 'issued',
  netToPayCents: 100_000,
  paidCents: 25_000,
  ...overrides,
});

describe('deriveKnownReceivables', () => {
  it('dérive le reste dû des seules pièces émises du tenant', () => {
    expect(
      deriveKnownReceivables({
        companyId: 'co-1',
        invoices: [
          invoice(),
          invoice({ id: 'draft', status: 'draft', netToPayCents: 999_999, paidCents: 0 }),
          invoice({ id: 'foreign', companyId: 'co-2', netToPayCents: 999_999, paidCents: 0 }),
        ],
      }),
    ).toEqual({ ok: true, value: { receivablesCents: 75_000, customerCreditCents: 0 } });
  });

  it('impute les avoirs émis et expose séparément un crédit client excédentaire', () => {
    expect(
      deriveKnownReceivables({
        companyId: 'co-1',
        invoices: [
          invoice({ netToPayCents: 10_000, paidCents: 0 }),
          invoice({ id: 'credit', kind: 'credit_note', netToPayCents: 15_000, paidCents: 0 }),
        ],
      }),
    ).toEqual({ ok: true, value: { receivablesCents: 0, customerCreditCents: 5_000 } });
  });

  it('échoue sur une donnée persistée incohérente au lieu de la corriger silencieusement', () => {
    expect(
      deriveKnownReceivables({
        companyId: 'co-1',
        invoices: [invoice({ paidCents: 100_001 })],
      }),
    ).toEqual({ ok: false, error: { code: 'INVALID_INVOICE', invoiceId: 'inv-1' } });
  });
});
