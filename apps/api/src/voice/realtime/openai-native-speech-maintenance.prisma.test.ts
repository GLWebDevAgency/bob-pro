import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaOpenAiNativeSpeechMaintenance } from './openai-native-speech-maintenance.prisma';

const COMPANY = 'company-1';
const DELIVERY = '00000000-0000-4000-8000-000000000001';
const EXPIRES_AT = new Date('2026-07-21T10:00:00.000Z');
const CLAIM = '00000000-0000-4000-8000-000000000099';

function reaped(overrides: Record<string, unknown> = {}) {
  return {
    deliveryId: DELIVERY,
    revision: 2,
    phase: 'expired',
    expiresAt: EXPIRES_AT,
    terminalAt: EXPIRES_AT,
    hasMore: true,
    ...overrides,
  };
}

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
  const withIsolatedTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    try {
      return await operation(tx);
    } catch (error) {
      rollback();
      throw error;
    }
  });
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
    maintenance: new PrismaOpenAiNativeSpeechMaintenance(
      { withIsolatedTenant, withIsolatedGlobal } as unknown as PrismaService,
    ),
    queryRaw,
    rollback,
    withIsolatedGlobal,
    withIsolatedTenant,
  };
}

function firstQuery(mock: ReturnType<typeof vi.fn>): { sql: string; values: unknown[] } {
  const query = mock.mock.calls[0]?.[0] as { sql?: unknown; values?: unknown } | undefined;
  return {
    sql: typeof query?.sql === 'string' ? query.sql.replace(/\s+/gu, ' ').trim() : '',
    values: Array.isArray(query?.values) ? query.values : [],
  };
}

function queryContaining(
  mock: ReturnType<typeof vi.fn>,
  fragment: string,
): { sql: string; values: unknown[] } {
  const call = mock.mock.calls.find(([query]) => queryText(query).includes(fragment));
  const query = call?.[0] as { sql?: unknown; values?: unknown } | undefined;
  return {
    sql: queryText(query),
    values: Array.isArray(query?.values) ? query.values : [],
  };
}

describe('PrismaOpenAiNativeSpeechMaintenance — expiration', () => {
  it('terminalise un batch sous transaction tenantée, horloge DB, locks distribués et CAS', async () => {
    const h = harness([[reaped(), reaped({
      deliveryId: '00000000-0000-4000-8000-000000000002',
      revision: 7,
    })]]);

    await expect(h.maintenance.reapExpired({ companyId: COMPANY, limit: 2 })).resolves.toEqual({
      status: 'succeeded',
      expiredCount: 2,
      hasMore: true,
    });
    expect(h.withIsolatedTenant).toHaveBeenCalledWith(
      COMPANY,
      expect.any(Function),
      { maxWaitMs: 1_000, timeoutMs: 4_000 },
    );
    const query = firstQuery(h.queryRaw);
    expect(query.sql).toContain('WITH locked AS MATERIALIZED');
    expect(query.sql).toContain('"expiresAt" <= statement_timestamp()');
    expect(query.sql).toContain('FOR UPDATE OF delivery SKIP LOCKED');
    expect(query.sql).toContain('delivery.revision = candidate.revision');
    expect(query.sql).toContain('"terminalAt" = delivery."expiresAt"');
    expect(query.sql).not.toContain('NOW()');
    expect(query.values).toEqual([COMPANY, 3, 2, COMPANY, 2]);
  });

  it('rollback si PostgreSQL renvoie une projection invalide ou plus que la borne', async () => {
    const corrupt = harness([[reaped({ terminalAt: new Date(EXPIRES_AT.getTime() + 1) })]]);
    await expect(corrupt.maintenance.reapExpired({ companyId: COMPANY, limit: 1 })).resolves
      .toEqual({ status: 'unavailable' });
    expect(corrupt.rollback).toHaveBeenCalledOnce();

    const overflow = harness([[reaped(), reaped({
      deliveryId: '00000000-0000-4000-8000-000000000002',
    })]]);
    await expect(overflow.maintenance.reapExpired({ companyId: COMPANY, limit: 1 })).resolves
      .toEqual({ status: 'unavailable' });
    expect(overflow.rollback).toHaveBeenCalledOnce();
  });
});

describe('PrismaOpenAiNativeSpeechMaintenance — rétention', () => {
  it('purge uniquement les terminaux échus sans contrôle natif possible en V1', async () => {
    const h = harness([[{ purgedCount: 3, dependenciesBlocked: 0, hasMore: false }]]);

    await expect(h.maintenance.purgeRetained({ companyId: COMPANY, limit: 4 })).resolves.toEqual({
      status: 'succeeded',
      purgedCount: 3,
      dependenciesBlocked: 0,
      hasMore: false,
    });
    const query = firstQuery(h.queryRaw);
    expect(query.sql).toContain("phase IN ('delivered', 'cancelled', 'failed', 'expired')");
    expect(query.sql).toContain('"retentionExpiresAt" <= statement_timestamp()');
    expect(query.sql).toContain('NOT EXISTS');
    expect(query.sql).toContain('realtime_control_grants');
    expect(query.sql).toContain('FOR UPDATE OF delivery SKIP LOCKED');
    expect(query.sql).toContain('DELETE FROM realtime_native_speech_deliveries');
    expect(query.values).toEqual([COMPANY, 5, 4, COMPANY, 4]);
  });

  it('rollback sur résumé absent, négatif ou supérieur à la borne', async () => {
    for (const result of [
      [],
      [{ purgedCount: -1, dependenciesBlocked: 0, hasMore: false }],
      [{ purgedCount: 0, dependenciesBlocked: 2, hasMore: false }],
    ]) {
      const h = harness([result]);
      await expect(h.maintenance.purgeRetained({ companyId: COMPANY, limit: 1 })).resolves
        .toEqual({ status: 'unavailable' });
      expect(h.rollback).toHaveBeenCalledOnce();
    }
  });
});

describe('PrismaOpenAiNativeSpeechMaintenance — validation fail-closed', () => {
  it('découvre une liste globale bornée, dédupliquée et strictement validée', async () => {
    const valid = harness([[
      { companyId: 'company-1', hasMore: true, claimId: CLAIM },
      { companyId: 'company-2', hasMore: true, claimId: CLAIM },
    ]]);
    await expect(valid.maintenance.listDueCompanyIds({ lane: 'expiry', limit: 2 })).resolves
      .toEqual({
        status: 'succeeded', companyIds: ['company-1', 'company-2'], hasMore: true,
        claimId: CLAIM,
      });
    expect(valid.withIsolatedGlobal).toHaveBeenCalledWith(
      expect.any(Function),
      { maxWaitMs: 1_000, timeoutMs: 4_000 },
    );
    const timeoutFence = queryContaining(valid.queryRaw, 'statement_timeout');
    expect(timeoutFence.sql).toContain("set_config( 'statement_timeout'");
    expect(timeoutFence.sql).toContain("set_config( 'lock_timeout'");
    expect(timeoutFence.values).toEqual(['3s', '1s']);
    expect(queryContaining(valid.queryRaw, 'list_realtime').sql)
      .toContain('list_realtime_native_speech_maintenance_tenants_v1');

    const duplicate = harness([[
      { companyId: 'company-1', hasMore: false, claimId: CLAIM },
      { companyId: 'company-1', hasMore: false, claimId: CLAIM },
    ]]);
    await expect(duplicate.maintenance.listDueCompanyIds({ lane: 'retention', limit: 2 }))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('acquitte seulement un claim UUID avec une projection booléenne exacte', async () => {
    const valid = harness([[{ acknowledged: true }]]);
    await expect(valid.maintenance.acknowledgeDueCompanyIds({
      lane: 'expiry', claimId: CLAIM,
    })).resolves.toEqual({ status: 'succeeded', acknowledged: true });
    expect(queryContaining(valid.queryRaw, 'ack_realtime').sql)
      .toContain('ack_realtime_native_speech_maintenance_tenants_v1');

    const invalid = harness([[{ acknowledged: 'yes' }]]);
    await expect(invalid.maintenance.acknowledgeDueCompanyIds({
      lane: 'retention', claimId: CLAIM,
    })).resolves.toEqual({ status: 'unavailable' });
  });

  it('renouvelle le lease exact et refuse toute projection ambiguë', async () => {
    const valid = harness([[{ renewed: true }]]);
    await expect(valid.maintenance.renewDueCompanyIdsClaim({
      lane: 'expiry', claimId: CLAIM,
    })).resolves.toEqual({ status: 'succeeded', renewed: true });
    expect(queryContaining(valid.queryRaw, 'renew_realtime').sql)
      .toContain('renew_realtime_native_speech_maintenance_claim_v1');

    const invalid = harness([[{ renewed: 1 }]]);
    await expect(invalid.maintenance.renewDueCompanyIdsClaim({
      lane: 'retention', claimId: CLAIM,
    })).resolves.toEqual({ status: 'unavailable' });
  });

  it('échoue fermé avant la fonction si PostgreSQL ne confirme pas les deux timeouts', async () => {
    const invalid = harness(
      [[{ companyId: COMPANY, hasMore: false, claimId: CLAIM }]],
      { statementTimeout: '0', lockTimeout: '1s' },
    );
    await expect(invalid.maintenance.listDueCompanyIds({ lane: 'expiry', limit: 1 })).resolves
      .toEqual({ status: 'unavailable' });
    expect(queryContaining(invalid.queryRaw, 'list_realtime').sql).toBe('');
    expect(invalid.rollback).toHaveBeenCalledOnce();
  });

  it('refuse les entrées hors contrat avant toute transaction', async () => {
    const h = harness([]);
    for (const input of [
      null,
      { companyId: 'company/escape', limit: 1 },
      { companyId: COMPANY, limit: 0 },
      { companyId: COMPANY, limit: 101 },
      { companyId: COMPANY, limit: 1.5 },
    ]) {
      await expect(h.maintenance.reapExpired(
        input as Parameters<typeof h.maintenance.reapExpired>[0],
      )).resolves.toEqual({ status: 'unavailable' });
      await expect(h.maintenance.purgeRetained(
        input as Parameters<typeof h.maintenance.purgeRetained>[0],
      )).resolves.toEqual({ status: 'unavailable' });
    }
    expect(h.withIsolatedTenant).not.toHaveBeenCalled();
    await expect(h.maintenance.listDueCompanyIds({ lane: 'expiry', limit: 1_001 }))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(h.maintenance.listDueCompanyIds({
      lane: 'invalid' as 'expiry', limit: 1,
    })).resolves.toEqual({ status: 'unavailable' });
  });

  it('absorbe les erreurs SQL sans les exposer', async () => {
    const reap = harness([new Error('secret SQL detail')]);
    await expect(reap.maintenance.reapExpired({ companyId: COMPANY, limit: 1 })).resolves
      .toEqual({ status: 'unavailable' });

    const purge = harness([new Error('secret SQL detail')]);
    await expect(purge.maintenance.purgeRetained({ companyId: COMPANY, limit: 1 })).resolves
      .toEqual({ status: 'unavailable' });
  });
});
