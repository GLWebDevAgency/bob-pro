import { describe, expect, it } from 'vitest';
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

  it.each(['abc', '', 0, 31, Number.NaN, Number.POSITIVE_INFINITY])('rejette un horizon invalide (%s)', async (horizon) => {
    const snapshots = makeSnapshots();
    const r = await new GetCashflow({ snapshots: snapshots.port }).execute({
      companyId: 'co-1',
      scenario: 'realiste',
      horizon,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(snapshots.calls()).toBe(0);
  });
});
