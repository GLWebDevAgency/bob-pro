import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { PrismaJarvisDispatchRunDirectory } from './jarvis-dispatch-directory.persistence';
import { PrismaService } from './prisma.service';

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => '00000000-0000-4000-8000-000000000099',
}));

const CLAIM_ID = '00000000-0000-4000-8000-000000000099';
const DATABASE_NOW = new Date('2026-08-21T00:00:00.000Z');
const HARD_EXPIRES_AT = new Date('2026-08-21T00:05:00.000Z');

function queryText(query: unknown): string {
  const raw = query as { sql?: unknown } | undefined;
  return typeof raw?.sql === 'string' ? raw.sql.replace(/\s+/gu, ' ').trim() : '';
}

function harness(
  results: readonly unknown[],
  timeoutRow: unknown = { statementTimeout: '4s', lockTimeout: '1s' },
) {
  const queue = [...results];
  const queryRaw = vi.fn(async (query: unknown) => {
    if (queryText(query).includes("set_config( 'statement_timeout'")) return [timeoutRow];
    if (queue.length === 0) throw new Error('Unexpected SQL query.');
    const result = queue.shift();
    if (result instanceof Error) throw result;
    return result;
  });
  const transaction = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
  const rollback = vi.fn();
  const withIsolatedGlobal = vi.fn(async (
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    try {
      return await operation(transaction);
    } catch (error) {
      rollback();
      throw error;
    }
  });
  return {
    directory: new PrismaJarvisDispatchRunDirectory(
      { withIsolatedGlobal } as unknown as PrismaService,
    ),
    queryRaw,
    rollback,
    withIsolatedGlobal,
  };
}

function queryContaining(mock: ReturnType<typeof vi.fn>, fragment: string) {
  const call = mock.mock.calls.find(([query]) => queryText(query).includes(fragment));
  const query = call?.[0] as { values?: unknown } | undefined;
  return {
    sql: call ? queryText(call[0]) : '',
    values: Array.isArray(query?.values) ? query.values : [],
  };
}

function claimedRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    status: 'claimed',
    companyId: 'company-a',
    claimId: CLAIM_ID,
    position: 1,
    pageSize: 1,
    ownerUserId: 'owner-a',
    runId: '00000000-0000-4000-8000-000000000001',
    hasMore: false,
    replayed: false,
    databaseNow: DATABASE_NOW,
    claimHardExpiresAt: HARD_EXPIRES_AT,
    ...overrides,
  };
}

function controlRow(status: 'empty' | 'busy') {
  return {
    status,
    companyId: 'company-a',
    claimId: null,
    position: null,
    pageSize: null,
    ownerUserId: null,
    runId: null,
    hasMore: null,
    replayed: null,
    databaseNow: null,
    claimHardExpiresAt: null,
  };
}

describe('PrismaJarvisDispatchRunDirectory', () => {
  it('réclame une page fraîche ordonnée C sous une transaction globale minutée', async () => {
    const h = harness([[
      claimedRow({
        position: 1,
        pageSize: 2,
        ownerUserId: 'z',
        runId: '00000000-0000-4000-8000-000000000001',
        hasMore: true,
      }),
      claimedRow({
        position: 2,
        pageSize: 2,
        ownerUserId: 'é',
        runId: '00000000-0000-4000-8000-000000000002',
        hasMore: true,
      }),
    ]]);

    const result = await h.directory.claimDispatchCoordinates({ companyId: 'company-a', limit: 2 });

    expect(result).toMatchObject({
      status: 'claimed',
      claimId: CLAIM_ID,
      pageSize: 2,
      hasMore: true,
      replayed: false,
      entries: [
        {
          position: 1,
          coordinates: {
            companyId: 'company-a',
            ownerUserId: 'z',
            runId: '00000000-0000-4000-8000-000000000001',
          },
        },
        {
          position: 2,
          coordinates: {
            companyId: 'company-a',
            ownerUserId: 'é',
            runId: '00000000-0000-4000-8000-000000000002',
          },
        },
      ],
    });
    expect(result.status === 'claimed' && result.hardLeaseRemainingMs).toBeGreaterThan(0);
    expect(result.status === 'claimed' && result.hardLeaseRemainingMs).toBeLessThanOrEqual(295_000);
    expect(h.withIsolatedGlobal).toHaveBeenCalledWith(
      expect.any(Function),
      { maxWaitMs: 2_000, timeoutMs: 10_000 },
    );
    expect(queryContaining(h.queryRaw, 'statement_timeout').values).toEqual(['4s', '1s']);
    expect(queryContaining(h.queryRaw, 'claim_jarvis_dispatch_coordinates_v2').values).toEqual([
      'company-a',
      2,
      CLAIM_ID,
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === 'claimed') {
      expect(Object.isFrozen(result.entries)).toBe(true);
      expect(result.entries.every((entry) => Object.isFrozen(entry.coordinates))).toBe(true);
    }
  });

  it('distingue empty, busy et ack_ready sans révéler un claim vivant', async () => {
    const empty = harness([[controlRow('empty')]]);
    await expect(
      empty.directory.claimDispatchCoordinates({ companyId: 'company-a', limit: 25 }),
    ).resolves.toEqual({ status: 'empty' });

    const busy = harness([[controlRow('busy')]]);
    await expect(
      busy.directory.claimDispatchCoordinates({ companyId: 'company-a', limit: 25 }),
    ).resolves.toEqual({ status: 'busy' });

    const ackReady = harness([[
      claimedRow({
        status: 'ack_ready',
        position: null,
        pageSize: 50,
        ownerUserId: null,
        runId: null,
        replayed: true,
        hasMore: true,
      }),
    ]]);
    await expect(
      ackReady.directory.claimDispatchCoordinates({ companyId: 'company-a', limit: 25 }),
    ).resolves.toMatchObject({
      status: 'ack_ready',
      claimId: CLAIM_ID,
      pageSize: 50,
      replayed: true,
      hasMore: true,
    });
  });

  it('accepte un suffixe rejoué absolu après downgrade et refuse une page fraîche trop grande', async () => {
    const replay = harness([[
      claimedRow({ position: 49, pageSize: 50, replayed: true }),
      claimedRow({
        position: 50,
        pageSize: 50,
        replayed: true,
        ownerUserId: 'owner-z',
        runId: '00000000-0000-4000-8000-000000000002',
      }),
    ]]);
    await expect(
      replay.directory.claimDispatchCoordinates({ companyId: 'company-a', limit: 25 }),
    ).resolves.toMatchObject({
      status: 'claimed',
      pageSize: 50,
      replayed: true,
      entries: [{ position: 49 }, { position: 50 }],
    });

    const freshOversized = harness([[
      claimedRow({ position: 26, pageSize: 26, replayed: false }),
    ]]);
    await expect(
      freshOversized.directory.claimDispatchCoordinates({ companyId: 'company-a', limit: 25 }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(freshOversized.rollback).toHaveBeenCalledOnce();
  });

  it('rejette ordre inverse, positions, metadata, dates et contrôles incohérents', async () => {
    const inverse = harness([[
      claimedRow({ position: 1, pageSize: 2, ownerUserId: 'é' }),
      claimedRow({
        position: 2,
        pageSize: 2,
        ownerUserId: 'z',
        runId: '00000000-0000-4000-8000-000000000002',
      }),
    ]]);
    await expect(
      inverse.directory.claimDispatchCoordinates({ companyId: 'company-a', limit: 2 }),
    ).resolves.toEqual({ status: 'unavailable' });

    const gap = harness([[
      claimedRow({ position: 1, pageSize: 3 }),
      claimedRow({
        position: 3,
        pageSize: 3,
        ownerUserId: 'owner-z',
        runId: '00000000-0000-4000-8000-000000000002',
      }),
    ]]);
    await expect(
      gap.directory.claimDispatchCoordinates({ companyId: 'company-a', limit: 3 }),
    ).resolves.toEqual({ status: 'unavailable' });

    const mixed = harness([[
      claimedRow({ position: 1, pageSize: 2 }),
      claimedRow({
        position: 2,
        pageSize: 2,
        ownerUserId: 'owner-z',
        runId: '00000000-0000-4000-8000-000000000002',
        claimHardExpiresAt: new Date('2026-08-21T00:04:59.000Z'),
      }),
    ]]);
    await expect(
      mixed.directory.claimDispatchCoordinates({ companyId: 'company-a', limit: 2 }),
    ).resolves.toEqual({ status: 'unavailable' });

    const infinite = harness([[
      claimedRow({ claimHardExpiresAt: new Date(Number.NaN) }),
    ]]);
    await expect(
      infinite.directory.claimDispatchCoordinates({ companyId: 'company-a', limit: 1 }),
    ).resolves.toEqual({ status: 'unavailable' });

    const leakyBusy = harness([[
      { ...controlRow('busy'), claimId: CLAIM_ID },
    ]]);
    await expect(
      leakyBusy.directory.claimDispatchCoordinates({ companyId: 'company-a', limit: 1 }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('renouvelle, démarre et acquitte par gestes booléens séparés', async () => {
    const renew = harness([[{ result: true }]]);
    await expect(renew.directory.renewDispatchCoordinatesClaim({
      companyId: 'company-a',
      claimId: CLAIM_ID,
    })).resolves.toEqual({ status: 'succeeded', renewed: true });
    expect(queryContaining(renew.queryRaw, 'renew_jarvis_dispatch_coordinates_claim_v2').values)
      .toEqual(['company-a', CLAIM_ID]);

    const start = harness([[{ result: false }]]);
    await expect(start.directory.startDispatchCoordinate({
      companyId: 'company-a',
      claimId: CLAIM_ID,
      position: 49,
    })).resolves.toEqual({ status: 'succeeded', started: false });
    expect(queryContaining(start.queryRaw, 'start_jarvis_dispatch_coordinate_v2').values)
      .toEqual(['company-a', CLAIM_ID, 49]);

    const ack = harness([[{ result: true }]]);
    await expect(ack.directory.acknowledgeDispatchCoordinates({
      companyId: 'company-a',
      claimId: CLAIM_ID,
    })).resolves.toEqual({ status: 'succeeded', acknowledged: true });
  });

  it('échoue fermé avant SQL sur les entrées invalides et sur toute panne/projection ambiguë', async () => {
    const invalid = harness([]);
    await expect(invalid.directory.claimDispatchCoordinates({
      companyId: ' company-a',
      limit: 25,
    })).resolves.toEqual({ status: 'unavailable' });
    await expect(invalid.directory.startDispatchCoordinate({
      companyId: 'company-a',
      claimId: '00000000-0000-0000-0000-000000000000',
      position: 1,
    })).resolves.toEqual({ status: 'unavailable' });
    expect(invalid.withIsolatedGlobal).not.toHaveBeenCalled();

    const badTimeout = harness([[{ result: true }]], {
      statementTimeout: '0',
      lockTimeout: '1s',
    });
    await expect(badTimeout.directory.acknowledgeDispatchCoordinates({
      companyId: 'company-a',
      claimId: CLAIM_ID,
    })).resolves.toEqual({ status: 'unavailable' });
    expect(queryContaining(badTimeout.queryRaw, 'ack_jarvis_dispatch_coordinates_v2').sql).toBe('');

    const sqlFailure = harness([new Error('private sql detail')]);
    await expect(sqlFailure.directory.renewDispatchCoordinatesClaim({
      companyId: 'company-a',
      claimId: CLAIM_ID,
    })).resolves.toEqual({ status: 'unavailable' });

    const ambiguous = harness([[{ result: 1 }]]);
    await expect(ambiguous.directory.acknowledgeDispatchCoordinates({
      companyId: 'company-a',
      claimId: CLAIM_ID,
    })).resolves.toEqual({ status: 'unavailable' });
  });
});
