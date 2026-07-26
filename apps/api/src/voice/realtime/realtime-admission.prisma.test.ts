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
  globalCapacity: {
    providerId: 'openai', providerModel: 'gpt-realtime-2.1',
    globalMaxSessions: 1_000, providerMaxSessions: 1_000, configVersion: 1,
  },
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

function harness(
  queryResults: readonly unknown[],
  existingCancellationFences: readonly { cancelledAt: Date }[] = [],
  liveSessionFences: readonly { subjectHash: string }[] = [],
) {
  const queries = [...queryResults];
  const queryRaw = vi.fn(async (strings: readonly string[]) => {
    const sql = strings.join('');
    if (sql.includes("set_config('statement_timeout'")) {
      return [{ statementTimeout: '3s', lockTimeout: '1s' }];
    }
    if (sql.includes('realtime_reaper_tenant_schedule') && sql.includes('FOR UPDATE')) {
      return [];
    }
    if (
      sql.includes('FROM realtime_admission_cancellation_fences')
      && sql.includes('SELECT "cancelledAt"')
    ) {
      return existingCancellationFences;
    }
    if (
      sql.includes('FROM realtime_admission_cancellation_fences')
      && sql.includes('SELECT "subjectHash"')
    ) {
      return liveSessionFences;
    }
    if (queries.length === 0) throw new Error('Unexpected SQL query.');
    return queries.shift();
  });
  const executeRaw = vi.fn(async () => 1);
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;
  const withTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  const withIsolatedTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  return {
    value: new PrismaRealtimeAdmission(
      { withTenant, withIsolatedTenant } as unknown as PrismaService,
      policy,
    ),
    queryRaw,
    executeRaw,
    withIsolatedTenant,
  };
}

function sqlAt(mock: ReturnType<typeof vi.fn>, index: number): string {
  const strings = mock.mock.calls[index]?.[0] as readonly string[] | undefined;
  return strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

function reserveHarness(options: {
  cancelled?: boolean;
  flagAccepted?: boolean;
  insertedCapabilityHash?: string | null;
} = {}) {
  const now = new Date('2026-07-26T12:00:00.000Z');
  const queryRaw = vi.fn(async (strings: readonly string[]) => {
    const sql = strings.join(' ');
    if (sql.includes("set_config('statement_timeout'")) {
      return [{ statementTimeout: '3s', lockTimeout: '1s' }];
    }
    if (sql.includes('SELECT clock_timestamp() AS now')) return [{ now }];
    if (sql.includes('FROM realtime_admission_cancellation_fences')) {
      return options.cancelled ? [{ subjectHash: SUBJECT }] : [];
    }
    if (sql.includes('FROM realtime_session_leases') && sql.includes('FOR UPDATE')) return [];
    if (sql.includes('FROM realtime_admission_events') && sql.includes('"sessionId"')) return [];
    if (sql.includes('AS "userMinute"')) {
      return [{
        userMinute: 0,
        userHour: 0,
        tenantMinute: 0,
        tenantHour: 0,
        userMinuteOldest: null,
        userHourOldest: null,
        tenantMinuteOldest: null,
        tenantHourOldest: null,
      }];
    }
    if (sql.includes('revalidate_agent_mission_release_flag_v1')) {
      return [{ accepted: options.flagAccepted ?? true }];
    }
    if (sql.includes('preflight_realtime_global_capacity_v1')) {
      return [{ status: 'allowed', retryAt: null }];
    }
    if (sql.includes('INSERT INTO realtime_session_leases')) {
      const capabilityHash = options.insertedCapabilityHash
        ?? 'c'.repeat(64);
      return [{
        leaseExpiresAt: new Date(now.getTime() + 15_000),
        hardExpiresAt: new Date(now.getTime() + 60_000),
        agentMissionProtocolVersion: 1,
        agentMissionProtocolBoundAt: now,
        agentMissionCapabilityHash: capabilityHash,
        agentMissionReleaseFlagVersion: 7,
      }];
    }
    throw new Error(`Unexpected SQL query: ${sql}`);
  });
  const executeRaw = vi.fn(async () => 1);
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;
  const withIsolatedTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  return {
    value: new PrismaRealtimeAdmission(
      {
        withTenant: vi.fn(),
        withIsolatedTenant,
      } as unknown as PrismaService,
      policy,
    ),
    queryRaw,
    executeRaw,
    withIsolatedTenant,
  };
}

function missionReserveInput() {
  return {
    companyId: COMPANY,
    subjectHash: SUBJECT,
    subjectHashCandidates: [SUBJECT, 'b'.repeat(64)],
    principalBindingHash: 'd'.repeat(64),
    agentMissionBinding: {
      protocolVersion: 1 as const,
      capabilityHash: 'c'.repeat(64),
      releaseFlagKey: 'bob.agent_missions.quote.v1' as const,
      releaseEnvironment: 'staging' as const,
      releaseFlagVersion: 7,
      principalBindingHash: 'd'.repeat(64),
    },
    sessionId: SESSION,
    maxSessionSeconds: 60,
  };
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
    const claimSql = sqlAt(h.queryRaw, 2);
    expect(claimSql).toContain('clock_timestamp() AS "databaseNow"');
    expect(claimSql).toContain('AND version =');
    expect(claimSql).toContain('AND "providerId" =');
    expect(claimSql).toContain('AND "providerCallId" =');
    expect(h.executeRaw).toHaveBeenCalledTimes(6);
    expect(h.executeRaw.mock.calls.some((call) => JSON.stringify(call).includes(
      'realtime_admission_cancellation_fences',
    ))).toBe(true);
    expect(h.withIsolatedTenant).toHaveBeenCalledWith(
      COMPANY,
      expect.any(Function),
      { maxWaitMs: 1_000, timeoutMs: 4_000 },
    );
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

describe('PrismaRealtimeAdmission — résolution après rotation HMAC', () => {
  it('verrouille le principal puis retourne l’identité historique réellement persistée', async () => {
    const historicalSubjectHash = 'b'.repeat(64);
    const h = harness([[
      {
        companyId: COMPANY,
        subjectHash: historicalSubjectHash,
        sessionId: SESSION,
      },
    ]]);

    await expect(h.value.resolveSession({
      companyId: COMPANY,
      subjectHashCandidates: [SUBJECT, historicalSubjectHash],
      principalBindingHash: 'd'.repeat(64),
      sessionId: SESSION,
    })).resolves.toEqual({
      ok: true,
      identity: {
        companyId: COMPANY,
        subjectHash: historicalSubjectHash,
        sessionId: SESSION,
      },
    });
    expect(JSON.stringify(h.executeRaw.mock.calls)).toContain('bob-live:principal:');
    const lookupSql = h.queryRaw.mock.calls
      .map((_, index) => sqlAt(h.queryRaw, index))
      .find((sql) => sql.includes('FROM realtime_session_leases'));
    expect(lookupSql).toContain('"subjectHash" IN');
    expect(lookupSql).toContain("state = 'active'");
    expect(lookupSql).toContain('"providerId" IS NOT NULL');
    expect(lookupSql).toContain('"providerCallId" IS NOT NULL');
    expect(lookupSql).toContain('"leaseExpiresAt" > clock_timestamp()');
    expect(lookupSql).toContain('"hardExpiresAt" > clock_timestamp()');
    expect(lookupSql).toContain('ORDER BY "subjectHash", "sessionId"');
    expect(h.withIsolatedTenant).toHaveBeenCalledWith(
      COMPANY,
      expect.any(Function),
      { maxWaitMs: 1_000, timeoutMs: 4_000 },
    );
  });

  it('échoue fermé si deux leases portent le même handle parmi les candidats', async () => {
    const h = harness([[
      { companyId: COMPANY, subjectHash: SUBJECT, sessionId: SESSION },
      { companyId: COMPANY, subjectHash: 'b'.repeat(64), sessionId: SESSION },
    ]]);

    await expect(h.value.resolveSession({
      companyId: COMPANY,
      subjectHashCandidates: [SUBJECT, 'b'.repeat(64)],
      principalBindingHash: 'd'.repeat(64),
      sessionId: SESSION,
    })).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('rend une session annulée introuvable avant de lire sa lease', async () => {
    const h = harness([], [], [{ subjectHash: SUBJECT }]);

    await expect(h.value.resolveSession({
      companyId: COMPANY,
      subjectHashCandidates: [SUBJECT, 'b'.repeat(64)],
      principalBindingHash: 'd'.repeat(64),
      sessionId: SESSION,
    })).resolves.toEqual({ ok: true, identity: null });

    const sql = h.queryRaw.mock.calls
      .map((_, index) => sqlAt(h.queryRaw, index))
      .join('\n');
    expect(sql).toContain('realtime_admission_cancellation_fences');
    expect(sql).not.toContain('SELECT "companyId", "subjectHash", "sessionId" FROM realtime_session_leases');
  });
});

describe('PrismaRealtimeAdmission — fence d’annulation bootstrap', () => {
  it('écrit tous les hashes sans UPDATE avant de déclarer une session absente terminée', async () => {
    const now = new Date('2026-07-26T12:00:00.000Z');
    const h = harness([[{ now }], []]);

    await expect(h.value.claimTermination({
      companyId: COMPANY,
      subjectHashCandidates: [SUBJECT, 'b'.repeat(64)],
      principalBindingHash: 'd'.repeat(64),
      sessionId: SESSION,
    })).resolves.toEqual({ ok: true, claim: null, pending: false });

    const sql = h.executeRaw.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(sql).toContain('realtime_admission_cancellation_fences');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
    expect(sql).toContain(SUBJECT);
    expect(sql).toContain('b'.repeat(64));
    expect(h.withIsolatedTenant).toHaveBeenCalledWith(
      COMPANY,
      expect.any(Function),
      { maxWaitMs: 1_000, timeoutMs: 4_000 },
    );
  });

  it('persiste les fences même si plusieurs leases corrompues empêchent tout choix', async () => {
    const now = new Date('2026-07-26T12:00:00.000Z');
    const h = harness([[{ now }], [
      { ...staleLease(), subjectHash: SUBJECT },
      { ...staleLease(), subjectHash: 'b'.repeat(64) },
    ]]);

    await expect(h.value.claimTermination({
      companyId: COMPANY,
      subjectHashCandidates: [SUBJECT, 'b'.repeat(64)],
      principalBindingHash: 'd'.repeat(64),
      sessionId: SESSION,
    })).resolves.toEqual({ ok: false, reason: 'unavailable' });

    const sql = h.executeRaw.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(sql).toContain('realtime_admission_cancellation_fences');
    expect(sql).toContain(SUBJECT);
    expect(sql).toContain('b'.repeat(64));
    expect(sql).not.toContain('DELETE FROM realtime_session_leases');
  });

  it('hérite du premier cancelledAt quand la rotation ajoute un nouveau hash', async () => {
    const now = new Date('2026-07-26T13:00:00.000Z');
    const firstCancelledAt = new Date('2026-07-26T12:00:00.000Z');
    const h = harness([[{ now }], []], [{ cancelledAt: firstCancelledAt }]);

    await expect(h.value.claimTermination({
      companyId: COMPANY,
      subjectHashCandidates: [SUBJECT, 'b'.repeat(64), 'c'.repeat(64)],
      principalBindingHash: 'd'.repeat(64),
      sessionId: SESSION,
    })).resolves.toEqual({ ok: true, claim: null, pending: false });

    const values = JSON.stringify(h.executeRaw.mock.calls);
    expect(values).toContain(firstCancelledAt.toISOString());
    expect(values).not.toContain(now.toISOString());
  });

  it('refuse un reserve clôturé avant capacité, lease et événement', async () => {
    const h = reserveHarness({ cancelled: true });

    await expect(h.value.reserve(missionReserveInput())).resolves.toEqual({
      allowed: false,
      denial: 'active_lease',
      retryAt: null,
    });
    const sql = h.queryRaw.mock.calls.map((call) =>
      (call[0] as readonly string[]).join(' ')).join('\n');
    expect(sql).toContain('realtime_admission_cancellation_fences');
    expect(sql).not.toContain('preflight_realtime_global_capacity_v1');
    expect(sql).not.toContain('INSERT INTO realtime_session_leases');
    expect(JSON.stringify(h.executeRaw.mock.calls)).not.toContain(
      'INSERT INTO realtime_admission_events',
    );
  });
});

describe('PrismaRealtimeAdmission — capability AgentMission atomique', () => {
  it('verrouille le principal et tous les sujets avant de revalider puis insérer le quartet', async () => {
    const h = reserveHarness();

    await expect(h.value.reserve(missionReserveInput())).resolves.toMatchObject({
      allowed: true,
      agentMissionProof: {
        protocolVersion: 1,
        capabilityHash: 'c'.repeat(64),
        releaseFlagVersion: 7,
      },
      lease: {
        companyId: COMPANY,
        subjectHash: SUBJECT,
        sessionId: SESSION,
      },
    });

    const queries = h.queryRaw.mock.calls.map((call) =>
      (call[0] as readonly string[]).join(' ').replace(/\s+/gu, ' ').trim());
    const leases = queries.find((sql) =>
      sql.includes('FROM realtime_session_leases') && sql.includes('FOR UPDATE'));
    expect(leases).toContain('ORDER BY "subjectHash", "sessionId"');
    expect(leases).toContain('"subjectHash" IN');
    const quota = queries.find((sql) => sql.includes('AS "userMinute"'));
    expect(quota?.match(/"subjectHash" IN/g)).toHaveLength(4);
    const revalidateIndex = queries.findIndex((sql) =>
      sql.includes('revalidate_agent_mission_release_flag_v1'));
    const capacityIndex = queries.findIndex((sql) =>
      sql.includes('preflight_realtime_global_capacity_v1'));
    const insertIndex = queries.findIndex((sql) =>
      sql.includes('INSERT INTO realtime_session_leases'));
    expect(revalidateIndex).toBeGreaterThan(0);
    expect(capacityIndex).toBe(revalidateIndex + 1);
    expect(insertIndex).toBe(capacityIndex + 1);

    const executeSql = h.executeRaw.mock.calls.map((call) =>
      ((call as unknown as readonly unknown[])[0] as readonly string[])
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim());
    expect(JSON.stringify(h.executeRaw.mock.calls[0])).toContain('bob-live:tenant:');
    expect(JSON.stringify(h.executeRaw.mock.calls[1])).toContain('bob-live:principal:');
    expect(executeSql.at(-1)).toContain('INSERT INTO realtime_admission_events');
    expect(JSON.stringify(h.queryRaw.mock.calls)).not.toContain('bam1_');
  });

  it('n’appelle ni capacité ni INSERT lorsque la revalidation du flag refuse', async () => {
    const h = reserveHarness({ flagAccepted: false });

    await expect(h.value.reserve(missionReserveInput())).resolves.toEqual({
      allowed: false,
      denial: 'unavailable',
      retryAt: null,
    });

    const sql = h.queryRaw.mock.calls.map((call) =>
      (call[0] as readonly string[]).join(' ')).join('\n');
    expect(sql).toContain('revalidate_agent_mission_release_flag_v1');
    expect(sql).not.toContain('preflight_realtime_global_capacity_v1');
    expect(sql).not.toContain('INSERT INTO realtime_session_leases');
  });

  it('échoue fermé avant SQL sur une identité ou une preuve partielle', async () => {
    const h = reserveHarness();
    const valid = missionReserveInput();

    for (const invalid of [
      { ...valid, subjectHashCandidates: [] },
      { ...valid, subjectHashCandidates: [SUBJECT, SUBJECT] },
      { ...valid, subjectHashCandidates: ['b'.repeat(64)] },
      { ...valid, principalBindingHash: 'invalid' },
      {
        ...valid,
        agentMissionBinding: {
          ...valid.agentMissionBinding,
          principalBindingHash: 'e'.repeat(64),
        },
      },
    ]) {
      await expect(h.value.reserve(invalid)).resolves.toEqual({
        allowed: false,
        denial: 'unavailable',
        retryAt: null,
      });
    }
    expect(h.withIsolatedTenant).not.toHaveBeenCalled();
  });

  it('refuse une preuve INSERT discordante sans publier de résultat autorisé', async () => {
    const h = reserveHarness({ insertedCapabilityHash: 'e'.repeat(64) });

    await expect(h.value.reserve(missionReserveInput())).resolves.toEqual({
      allowed: false,
      denial: 'unavailable',
      retryAt: null,
    });
    const eventWrites = h.executeRaw.mock.calls.filter((call) =>
      ((call as unknown as readonly unknown[])[0] as readonly string[])
        .join(' ')
        .includes('INSERT INTO realtime_admission_events'));
    expect(eventWrites).toHaveLength(0);
  });
});
