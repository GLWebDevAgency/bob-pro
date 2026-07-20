import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaRealtimeSidebandOwner } from './realtime-sideband-owner.prisma';
import type { RealtimeSidebandOwnerIdentity } from './realtime-sideband-owner';

const COMPANY = 'company-a';
const SUBJECT = '1'.repeat(64);
const INSTANCE = '2'.repeat(64);
const TOKEN = '3'.repeat(64);
const OTHER_TOKEN = '4'.repeat(64);
const CONTEXT = '5'.repeat(64);
const SESSION = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-07-14T08:00:00.000Z');

type QueryMock = ReturnType<typeof vi.fn>;

function repository(results: readonly unknown[]) {
  const queue = [...results];
  const queryRaw = vi.fn(async () => {
    if (queue.length === 0) throw new Error('Unexpected SQL query.');
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return value;
  });
  const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
  const withTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  return {
    value: new PrismaRealtimeSidebandOwner({ withTenant } as unknown as PrismaService),
    queryRaw,
    withTenant,
  };
}

function sqlAt(query: QueryMock, index: number): string {
  const strings = query.mock.calls[index]?.[0] as readonly string[] | undefined;
  return strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

function nestedSqlAt(query: QueryMock, callIndex: number, argumentIndex: number): string {
  const nested = query.mock.calls[callIndex]?.[argumentIndex] as { sql?: unknown } | undefined;
  return typeof nested?.sql === 'string' ? nested.sql.replace(/\s+/gu, ' ').trim() : '';
}

function lease(overrides: Record<string, unknown> = {}) {
  return {
    subjectHash: SUBJECT,
    state: 'active',
    leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    hardExpiresAt: new Date(NOW.getTime() + 900_000),
    sidebandOwnerInstanceHash: null,
    sidebandOwnerTokenHash: null,
    sidebandOwnerLeaseExpiresAt: null,
    sidebandOwnerEpoch: 0,
    contextRevision: 7,
    contextDigest: CONTEXT,
    ...overrides,
  };
}

const owner: RealtimeSidebandOwnerIdentity = {
  companyId: COMPANY,
  subjectHash: SUBJECT,
  sessionId: SESSION,
  ownerInstanceHash: INSTANCE,
  ownerTokenHash: TOKEN,
  ownerEpoch: 2,
};

describe('Bob Live — propriétaire sideband Prisma', () => {
  it('acquiert sous verrou une nouvelle epoch et retourne le contexte courant', async () => {
    const updated = lease({
      sidebandOwnerInstanceHash: INSTANCE,
      sidebandOwnerTokenHash: TOKEN,
      sidebandOwnerLeaseExpiresAt: new Date(NOW.getTime() + 30_000),
      sidebandOwnerEpoch: 2,
      databaseNow: NOW,
    });
    const h = repository([[lease({ sidebandOwnerEpoch: 1 })], [{ databaseNow: NOW }], [updated]]);
    await expect(h.value.acquire({
      companyId: COMPANY,
      sessionId: SESSION,
      ownerInstanceHash: INSTANCE,
      candidateOwnerTokenHash: TOKEN,
      leaseSeconds: 30,
    })).resolves.toEqual({
      status: 'acquired',
      owner,
      currentContext: { revision: 7, digest: CONTEXT },
      leaseExpiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    });
    expect(sqlAt(h.queryRaw, 0)).toMatch(/FOR UPDATE/u);
    expect(sqlAt(h.queryRaw, 2)).toMatch(/"sidebandOwnerEpoch" = "sidebandOwnerEpoch" \+ 1/u);
    expect(sqlAt(h.queryRaw, 2)).toMatch(/"contextAppliedRevision" = NULL/u);
    expect(h.withTenant).toHaveBeenCalledWith(COMPANY, expect.any(Function));
  });

  it('refuse le takeover d’un propriétaire vivant sans exécuter d’UPDATE', async () => {
    const h = repository([[
      lease({
        sidebandOwnerInstanceHash: INSTANCE,
        sidebandOwnerTokenHash: OTHER_TOKEN,
        sidebandOwnerLeaseExpiresAt: new Date(NOW.getTime() + 30_000),
        sidebandOwnerEpoch: 1,
      }),
    ], [{ databaseNow: NOW }]]);
    await expect(h.value.acquire({
      companyId: COMPANY,
      sessionId: SESSION,
      ownerInstanceHash: INSTANCE,
      candidateOwnerTokenHash: TOKEN,
      leaseSeconds: 30,
    })).resolves.toEqual({ status: 'busy' });
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('fence renew, contexte appliqué, relecture et release par token+epoch exacts', async () => {
    const renewed = repository([[{ leaseExpiresAt: new Date(NOW.getTime() + 30_000) }]]);
    await expect(renewed.value.renew(owner, 30)).resolves.toEqual({
      status: 'renewed',
      leaseExpiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    });
    expect(nestedSqlAt(renewed.queryRaw, 0, 2))
      .toMatch(/"sidebandOwnerTokenHash" = .*"sidebandOwnerEpoch" =/u);

    const applied = repository([[{ revision: 7 }]]);
    await expect(applied.value.applyContext(owner, { revision: 7, digest: CONTEXT }))
      .resolves.toEqual({ status: 'applied' });
    expect(sqlAt(applied.queryRaw, 0)).toMatch(/"contextAppliedOwnerEpoch" =/u);
    expect(sqlAt(applied.queryRaw, 0)).toMatch(/"contextRevision" = .*"contextDigest" =/u);

    const current = repository([[{ revision: 7, digest: CONTEXT }]]);
    await expect(current.value.readCurrentContext(owner)).resolves.toEqual({
      status: 'current',
      context: { revision: 7, digest: CONTEXT },
    });
    expect(sqlAt(current.queryRaw, 0)).toMatch(/"contextAppliedOwnerEpoch" = "sidebandOwnerEpoch"/u);

    const released = repository([[{ sidebandOwnerEpoch: 2 }]]);
    await expect(released.value.release(owner)).resolves.toEqual({ status: 'released' });
    expect(sqlAt(released.queryRaw, 0)).toMatch(/"sidebandOwnerTokenHash" = NULL/u);
    expect(sqlAt(released.queryRaw, 0)).toMatch(/"contextAppliedRevision" = NULL/u);
  });

  it('retourne unavailable sans propager les erreurs SQL ni les détails', async () => {
    const h = repository([new Error('postgres secret payload')]);
    await expect(h.value.acquire({
      companyId: COMPANY,
      sessionId: SESSION,
      ownerInstanceHash: INSTANCE,
      candidateOwnerTokenHash: TOKEN,
      leaseSeconds: 30,
    })).resolves.toEqual({ status: 'unavailable' });
  });
});
