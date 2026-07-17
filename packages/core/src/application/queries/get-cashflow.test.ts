import { describe, expect, it } from 'vitest';
import { Expense, type Invoice } from '../..';
import type { ClockPort } from '../ports/services';
import { GetCashflow } from './get-cashflow';

function makeSnapshots() {
  let calls = 0;
  return {
    port: {
      get: async () => {
        calls++;
        return { bankBalance: 682000, receivables: 300000, charges: 100000, vatDue: 124000 };
      },
    },
    calls: () => calls,
  };
}

describe('GetCashflow', () => {
  it('projette avec un horizon valide fourni en string', async () => {
    const snapshots = makeSnapshots();
    const r = await new GetCashflow({ snapshots: snapshots.port }).execute({
      companyId: 'co-1',
      scenario: 'realiste',
      horizon: '30',
    });

    expect(r.ok).toBe(true);
    expect(snapshots.calls()).toBe(1);
  });

  it('rejette un scenario invalide avant lecture du snapshot', async () => {
    const snapshots = makeSnapshots();
    const r = await new GetCashflow({ snapshots: snapshots.port }).execute({
      companyId: 'co-1',
      scenario: 'fantaisie',
      horizon: 30,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(snapshots.calls()).toBe(0);
  });

  it.each(['abc', '', 0, 31, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejette un horizon invalide (%s)',
    async (horizon) => {
      const snapshots = makeSnapshots();
      const r = await new GetCashflow({ snapshots: snapshots.port }).execute({
        companyId: 'co-1',
        scenario: 'realiste',
        horizon,
      });

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('domain');
      expect(snapshots.calls()).toBe(0);
    },
  );

  it('borne les flux aux échéances du vrai horizon et expose les données sans date', async () => {
    const makeInvoice = (input: { id: string; amount: number; dueAt: string | null }): Invoice =>
      ({
        id: input.id,
        companyId: 'co-1',
        kind: 'final',
        status: 'issued',
        dueAt: input.dueAt,
        paid: 0,
        totals: () => ({
          ht: input.amount,
          vatByRate: {},
          vat: 0,
          ttc: input.amount,
          netToPay: input.amount,
        }),
      }) as Invoice;
    const invoices = {
      listByCompany: async () => [
        makeInvoice({ id: 'due', amount: 10_000, dueAt: '2026-07-20' }),
        makeInvoice({ id: 'future', amount: 20_000, dueAt: '2026-08-20' }),
        makeInvoice({ id: 'undated', amount: 30_000, dueAt: null }),
      ],
    };
    const expense = (id: string, amount: number, dueAt: string | null) =>
      Expense.rehydrate({
        id,
        companyId: 'co-1',
        supplierName: 'Fournisseur',
        supplierSiren: null,
        documentDate: '2026-07-01',
        totalTtcCents: amount,
        totalHtCents: amount,
        vatCents: 0,
        vatRatePct: 0,
        category: 'autre',
        status: 'to_pay',
        source: 'manual',
        dueAt,
      });
    const expenses = {
      listByCompany: async () => [
        expense('due', 7_000, '2026-07-22'),
        expense('future', 8_000, '2026-08-20'),
        expense('undated', 9_000, null),
      ],
    };
    const clock: ClockPort = {
      now: () => '2026-07-17T08:00:00.000Z',
      today: () => '2026-07-17',
    };
    const snapshots = {
      get: async () => ({
        bankBalance: 100_000,
        receivables: 999_999,
        charges: 5_000,
        vatDue: 0,
      }),
    };

    const result = await new GetCashflow({ snapshots, invoices, expenses, clock }).execute({
      companyId: 'co-1',
      scenario: 'optimiste',
      horizon: 30,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        available: 89_000,
        payout: 89_000,
        risk: false,
        vatDue: 0,
        basis: {
          modelVersion: 'cashflow-projection/2',
          kind: 'dated_documents',
          scenario: 'optimiste',
          horizonDays: 30,
          receivableCollectionRatePct: 100,
          asOf: '2026-07-17',
          horizonEnd: '2026-08-16',
          receivablesIncludedCents: 10_000,
          receivablesAfterHorizonCents: 20_000,
          receivablesUndatedCents: 30_000,
          chargesIncludedCents: 21_000,
          chargesAfterHorizonCents: 8_000,
          chargesUndatedIncludedCents: 9_000,
        },
      },
    });
  });
});
