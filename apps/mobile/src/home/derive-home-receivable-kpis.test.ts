import { describe, expect, it } from 'vitest';
import {
  deriveHomeReceivableKpis,
  type HomeReceivableInvoice,
} from './derive-home-receivable-kpis';

const invoice = (patch: Partial<HomeReceivableInvoice> = {}): HomeReceivableInvoice => ({
  id: 'invoice-1',
  companyId: 'company-owner',
  kind: 'final',
  status: 'issued',
  netToPayCents: 120_000,
  paidCents: 20_000,
  ...patch,
});

describe('deriveHomeReceivableKpis', () => {
  it('retourne des zéros factuels quand la BDD ne contient aucune facture', () => {
    expect(deriveHomeReceivableKpis([])).toEqual({ owedCents: 0, lateCents: 0 });
  });

  it('dérive encours et retard des montants réellement émis et encaissés', () => {
    expect(
      deriveHomeReceivableKpis([
        invoice({ status: 'late' }),
        invoice({
          id: 'invoice-2',
          status: 'partially_paid',
          netToPayCents: 90_000,
          paidCents: 30_000,
        }),
        invoice({ id: 'draft', status: 'draft', netToPayCents: 999_999, paidCents: 0 }),
      ]),
    ).toEqual({ owedCents: 160_000, lateCents: 100_000 });
  });

  it('déduit les avoirs ouverts sans produire un encours négatif', () => {
    expect(
      deriveHomeReceivableKpis([
        invoice({ status: 'late', netToPayCents: 100_000, paidCents: 0 }),
        invoice({
          id: 'credit',
          kind: 'credit_note',
          status: 'issued',
          netToPayCents: 35_000,
          paidCents: 0,
        }),
      ]),
    ).toEqual({ owedCents: 65_000, lateCents: 65_000 });
  });

  it('refuse une fuite inter-tenant au lieu de sommer les montants', () => {
    expect(
      deriveHomeReceivableKpis([
        invoice(),
        invoice({ id: 'intruder', companyId: 'company-intruder' }),
      ]),
    ).toBeNull();
  });
});
