import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type { RealtimeAdmissionPolicy } from './realtime-admission';
import { PrismaRealtimeAdmission } from './realtime-admission.prisma';

const COMPANY = 'company-1';
const SUBJECT = 'a'.repeat(64);
const SESSION = '11111111-1111-4111-8111-111111111111';
const PROVIDER_SESSION = 'mistral_session_1';
const HARD_EXPIRES_AT = new Date('2026-07-14T10:00:00.000Z');
const policy: RealtimeAdmissionPolicy = {
  userLimitPerMinute: 3,
  userLimitPerHour: 30,
  tenantLimitPerMinute: 50,
  tenantLimitPerHour: 1_000,
  reservationTtlSeconds: 15,
  activeLeaseSeconds: 30,
  heartbeatSeconds: 10,
  reaperLeaseSeconds: 30,
};

function staleLease() {
  return {
    companyId: COMPANY,
    subjectHash: SUBJECT,
    sessionId: SESSION,
    state: 'active',
    providerId: 'mistral',
    providerCallId: PROVIDER_SESSION,
    leaseExpiresAt: new Date('2026-07-14T09:59:59.000Z'),
    hardExpiresAt: HARD_EXPIRES_AT,
    version: 3,
  };
}

function claimed(databaseNow: Date) {
  return {
    ...staleLease(),
    state: 'reaping',
    leaseExpiresAt: new Date(databaseNow.getTime() + 30_000),
    reaperLeaseExpiresAt: new Date(databaseNow.getTime() + 30_000),
    databaseNow,
    version: 4,
  };
}

function harness(queryResults: readonly unknown[]) {
  const queries = [...queryResults];
  const queryRaw = vi.fn(async () => {
    if (queries.length === 0) throw new Error('Unexpected SQL query.');
    return queries.shift();
  });
  const executeRaw = vi.fn(async () => 1);
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;
  const withTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  return {
    value: new PrismaRealtimeAdmission({ withTenant } as unknown as PrismaService, policy),
    queryRaw,
    executeRaw,
  };
}

function sqlAt(mock: ReturnType<typeof vi.fn>, index: number): string {
  const strings = mock.mock.calls[index]?.[0] as readonly string[] | undefined;
  return strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

describe('PrismaRealtimeAdmission — preuve hard-expired', () => {
  it('produit la preuve uniquement depuis clock_timestamp retourné par le claim CAS', async () => {
    const databaseNow = new Date(HARD_EXPIRES_AT.getTime() + 1);
    const h = harness([[staleLease()], [claimed(databaseNow)]]);

    const result = await h.value.claimExpired({ companyId: COMPANY, limit: 1 });

    expect(result).toEqual({
      ok: true,
      claims: [expect.objectContaining({
        companyId: COMPANY,
        subjectHash: SUBJECT,
        sessionId: SESSION,
        providerId: 'mistral',
        providerCallId: PROVIDER_SESSION,
        hardExpiryProof: {
          source: 'database_hard_expiry',
          companyId: COMPANY,
          subjectHash: SUBJECT,
          sessionId: SESSION,
          providerId: 'mistral',
          providerCallId: PROVIDER_SESSION,
          hardExpiresAt: HARD_EXPIRES_AT.toISOString(),
          databaseObservedAt: databaseNow.toISOString(),
          leaseVersion: 4,
        },
      })],
    });
    const claimSql = sqlAt(h.queryRaw, 1);
    expect(claimSql).toContain('clock_timestamp() AS "databaseNow"');
    expect(claimSql).toContain('AND version =');
    expect(claimSql).toContain('AND "providerId" =');
    expect(claimSql).toContain('AND "providerCallId" =');
    expect(h.executeRaw).toHaveBeenCalledTimes(4);
  });

  it('laisse la preuve à null quand seul le heartbeat est expiré avant le hard cap', async () => {
    const databaseNow = new Date(HARD_EXPIRES_AT.getTime() - 1);
    const h = harness([[staleLease()], [claimed(databaseNow)]]);

    await expect(h.value.claimExpired({ companyId: COMPANY, limit: 1 })).resolves.toEqual({
      ok: true,
      claims: [expect.objectContaining({ hardExpiryProof: null })],
    });
  });

  it('échoue fermé si l’horloge DB retournée est absente ou corrompue', async () => {
    const h = harness([[staleLease()], [{ ...claimed(HARD_EXPIRES_AT), databaseNow: null }]]);
    await expect(h.value.claimExpired({ companyId: COMPANY, limit: 1 }))
      .resolves.toEqual({ ok: true, claims: [] });
  });
});
