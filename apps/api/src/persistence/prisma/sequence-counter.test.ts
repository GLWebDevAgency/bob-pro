import { describe, expect, it, vi } from 'vitest';
import { PrismaSequenceCounter } from './repositories';
import type { PrismaService } from './prisma.service';

function counterReturning(rows: readonly { next_value: number | bigint }[]) {
  const queryRaw = vi.fn(async () => [...rows]);
  const prisma = {
    client: () => ({ $queryRaw: queryRaw }),
  } as unknown as PrismaService;
  return { counter: new PrismaSequenceCounter(prisma), queryRaw };
}

describe('PrismaSequenceCounter — allocation légale fail-closed', () => {
  it('accepte exactement la valeur positive sûre renvoyée par PostgreSQL', async () => {
    const { counter, queryRaw } = counterReturning([{ next_value: 42n }]);

    await expect(
      counter.allocate({ companyId: 'company-owner', counterKey: 'invoice', fiscalYear: 2026 }),
    ).resolves.toMatchObject({ sequence: 42, formatted: { value: 'F-2026-0042' } });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([[[]], [[{ next_value: 1 }, { next_value: 2 }]]])(
    'refuse %j ligne(s) au lieu d’inventer la séquence 1',
    async (rows) => {
      const { counter } = counterReturning(rows);
      await expect(
        counter.allocate({ companyId: 'company-owner', counterKey: 'invoice', fiscalYear: 2026 }),
      ).rejects.toThrow('DOCUMENT_COUNTER_ALLOCATION_CORRUPT:expected_one_row');
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuse une nextValue corrompue (%s)',
    async (nextValue) => {
      const { counter } = counterReturning([{ next_value: nextValue }]);
      await expect(
        counter.allocate({ companyId: 'company-owner', counterKey: 'invoice', fiscalYear: 2026 }),
      ).rejects.toThrow('DOCUMENT_COUNTER_ALLOCATION_CORRUPT:invalid_next_value');
    },
  );
});
