import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaRealtimeReaperDirectory } from './realtime-reaper-directory.prisma';

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => '00000000-0000-4000-8000-000000000099',
}));

const CLAIM = '00000000-0000-4000-8000-000000000099';

function queryText(query: unknown): string {
  const raw = query as { sql?: unknown } | undefined;
  return typeof raw?.sql === 'string' ? raw.sql.replace(/\s+/gu, ' ').trim() : '';
}

function harness(
  results: readonly unknown[],
  timeoutRow: unknown = { statementTimeout: '3s', lockTimeout: '1s' },
) {
  const queue = [...results];
  const queryRaw = vi.fn(async (query: unknown) => {
    if (queryText(query).includes("set_config( 'statement_timeout'")) return [timeoutRow];
    if (queue.length === 0) throw new Error('Unexpected SQL query.');
    const result = queue.shift();
    if (result instanceof Error) throw result;
    return result;
  });
  const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
  const rollback = vi.fn();
  const withIsolatedGlobal = vi.fn(async (
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    try {
      return await operation(tx);
    } catch (error) {
      rollback();
      throw error;
    }
  });
  return {
    directory: new PrismaRealtimeReaperDirectory(
      { withIsolatedGlobal } as unknown as PrismaService,
    ),
    queryRaw,
    rollback,
    withIsolatedGlobal,
  };
}

function queryContaining(mock: ReturnType<typeof vi.fn>, fragment: string) {
  const call = mock.mock.calls.find(([query]) => queryText(query).includes(fragment));
  const query = call?.[0] as { sql?: unknown; values?: unknown } | undefined;
  return {
    sql: queryText(query),
    values: Array.isArray(query?.values) ? query.values : [],
  };
}

describe('PrismaRealtimeReaperDirectory', () => {
  it('découvre une page bornée et valide sous transaction globale minutée', async () => {
    const h = harness([[
      { companyId: 'company-a', hasMore: true, claimId: CLAIM },
      { companyId: 'company-b', hasMore: true, claimId: CLAIM },
    ]]);

    await expect(h.directory.listDueCompanyIds({ limit: 2 })).resolves.toEqual({
      status: 'succeeded',
      companyIds: ['company-a', 'company-b'],
      hasMore: true,
      claimId: CLAIM,
    });
    expect(h.withIsolatedGlobal).toHaveBeenCalledWith(
      expect.any(Function),
      { maxWaitMs: 1_000, timeoutMs: 4_000 },
    );
    expect(queryContaining(h.queryRaw, 'statement_timeout').values).toEqual(['3s', '1s']);
    expect(queryContaining(h.queryRaw, 'list_realtime_reaper_tenants_v1').values)
      .toEqual([2, CLAIM]);
  });

  it('refuse doublon, projection incohérente, claim substitué et entrée hors borne', async () => {
    const duplicate = harness([[
      { companyId: 'company-a', hasMore: false, claimId: CLAIM },
      { companyId: 'company-a', hasMore: false, claimId: CLAIM },
    ]]);
    await expect(duplicate.directory.listDueCompanyIds({ limit: 2 })).resolves
      .toEqual({ status: 'unavailable' });
    expect(duplicate.rollback).toHaveBeenCalledOnce();

    const substituted = harness([[
      { companyId: 'company-a', hasMore: false, claimId: '00000000-0000-4000-8000-000000000098' },
    ]]);
    await expect(substituted.directory.listDueCompanyIds({ limit: 1 })).resolves
      .toEqual({ status: 'unavailable' });
    expect(substituted.rollback).toHaveBeenCalledOnce();

    const replayAfterDowngrade = harness([[
      { companyId: 'company-a', hasMore: true, claimId: CLAIM },
      { companyId: 'company-b', hasMore: true, claimId: CLAIM },
    ]]);
    await expect(replayAfterDowngrade.directory.listDueCompanyIds({ limit: 1 })).resolves
      .toEqual({
        status: 'succeeded',
        companyIds: ['company-a', 'company-b'],
        hasMore: true,
        claimId: CLAIM,
      });

    const invalid = harness([]);
    await expect(invalid.directory.listDueCompanyIds({ limit: 0 })).resolves
      .toEqual({ status: 'unavailable' });
    await expect(invalid.directory.listDueCompanyIds({ limit: 1_001 })).resolves
      .toEqual({ status: 'unavailable' });
    expect(invalid.withIsolatedGlobal).not.toHaveBeenCalled();
  });

  it('renouvelle et acquitte seulement un UUID avec un booléen exact', async () => {
    const renew = harness([[{ result: true }]]);
    await expect(renew.directory.renewClaim({ claimId: CLAIM })).resolves.toEqual({
      status: 'succeeded', renewed: true,
    });
    expect(queryContaining(renew.queryRaw, 'renew_realtime_reaper_tenants_claim_v1').values)
      .toEqual([CLAIM]);

    const ack = harness([[{ result: false }]]);
    await expect(ack.directory.acknowledgeClaim({ claimId: CLAIM })).resolves.toEqual({
      status: 'succeeded', acknowledged: false,
    });

    const ambiguous = harness([[{ result: 1 }]]);
    await expect(ambiguous.directory.acknowledgeClaim({ claimId: CLAIM })).resolves
      .toEqual({ status: 'unavailable' });
    expect(ambiguous.rollback).toHaveBeenCalledOnce();
  });

  it('échoue fermé si les timeouts ne sont pas confirmés ou si SQL échoue', async () => {
    const timeout = harness(
      [[{ companyId: 'company-a', hasMore: false, claimId: CLAIM }]],
      { statementTimeout: '0', lockTimeout: '1s' },
    );
    await expect(timeout.directory.listDueCompanyIds({ limit: 1 })).resolves
      .toEqual({ status: 'unavailable' });
    expect(queryContaining(timeout.queryRaw, 'list_realtime_reaper_tenants_v1').sql).toBe('');
    expect(timeout.rollback).toHaveBeenCalledOnce();

    const failed = harness([new Error('private sql detail')]);
    await expect(failed.directory.renewClaim({ claimId: CLAIM })).resolves
      .toEqual({ status: 'unavailable' });
  });
});
