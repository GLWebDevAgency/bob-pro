import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RealtimeAdmissionPolicy } from './realtime-admission';
import { PrismaRealtimeAdmission } from './realtime-admission.prisma';
import { PrismaService } from '../../persistence/prisma/prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_REALTIME_ADMISSION_CERT === 'true';

const policy: RealtimeAdmissionPolicy = {
  userLimitPerMinute: 2,
  userLimitPerHour: 3,
  tenantLimitPerMinute: 100,
  tenantLimitPerHour: 1_000,
  reservationTtlSeconds: 15,
  activeLeaseSeconds: 30,
  heartbeatSeconds: 10,
  reaperLeaseSeconds: 30,
};

describe.skipIf(!RUN_POSTGRES_CERT)('Bob Live admission — certification PostgreSQL/RLS réelle', () => {
  const companyId = `realtime-cert-${randomUUID()}`;
  const otherCompanyId = `realtime-cert-${randomUUID()}`;
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let workers: PrismaService[] = [];
  let admissions: PrismaRealtimeAdmission[] = [];

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workers = [
      new PrismaService({ datasourceUrl: runtimeUrl }),
      new PrismaService({ datasourceUrl: runtimeUrl }),
    ];
    admissions = workers.map((worker) => new PrismaRealtimeAdmission(worker, policy));
    await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
    for (const [id, suffix] of [[companyId, 1], [otherCompanyId, 2]] as const) {
      const siren = String(randomInt(100_000_000, 999_999_999));
      await admin.company.create({
        data: {
          id,
          name: `Bob Realtime PostgreSQL Certification ${suffix}`,
          legalForm: 'EI',
          siren,
          siret: `${siren}${String(suffix).padStart(5, '0')}`,
          trade: 'certification',
          vatRegime: 'reel_normal',
          addrLine1: `${suffix} rue de la Certification`,
          addrZip: '75001',
          addrCity: 'Paris',
        },
      });
    }
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.realtimeSessionLease.deleteMany({ where: { companyId: { in: [companyId, otherCompanyId] } } }).catch(() => undefined);
      await admin.realtimeAdmissionEvent.deleteMany({ where: { companyId: { in: [companyId, otherCompanyId] } } }).catch(() => undefined);
      await admin.company.deleteMany({ where: { id: { in: [companyId, otherCompanyId] } } }).catch(() => undefined);
    }
    await Promise.allSettled([
      ...workers.map((worker) => worker.$disconnect()),
      ...(admin ? [admin.$disconnect()] : []),
    ]);
  });

  it('certifie migration, FORCE RLS, index de fenêtre et absence de secrets bruts', async () => {
    const [role] = await workers[0]!.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

    const shape = await admin.$queryRaw<Array<{
      tableName: string;
      rowSecurity: boolean;
      forceRowSecurity: boolean;
    }>>`
      SELECT relname AS "tableName", relrowsecurity AS "rowSecurity", relforcerowsecurity AS "forceRowSecurity"
        FROM pg_class
       WHERE oid IN ('realtime_admission_events'::regclass, 'realtime_session_leases'::regclass)
       ORDER BY relname
    `;
    expect(shape).toEqual([
      { tableName: 'realtime_admission_events', rowSecurity: true, forceRowSecurity: true },
      { tableName: 'realtime_session_leases', rowSecurity: true, forceRowSecurity: true },
    ]);
    const columns = await admin.$queryRaw<Array<{ columnName: string }>>`
      SELECT lower(column_name) AS "columnName"
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('realtime_admission_events', 'realtime_session_leases')
    `;
    expect(columns.map((column) => column.columnName)).not.toEqual(expect.arrayContaining([
      'userid', 'user_id', 'leasetoken', 'reapertoken',
    ]));
    const [indexes] = await admin.$queryRaw<Array<{
      subjectIndex: boolean;
      tenantIndex: boolean;
      sessionHandleUnique: boolean;
      migrationApplied: boolean;
    }>>`
      SELECT
        to_regclass('public.realtime_admission_events_subject_window_idx') IS NOT NULL AS "subjectIndex",
        to_regclass('public.realtime_admission_events_tenant_window_idx') IS NOT NULL AS "tenantIndex",
        EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'realtime_admission_events'::regclass
             AND conname = 'realtime_admission_events_session_id_key'
             AND contype = 'u'
        ) AS "sessionHandleUnique",
        EXISTS (
          SELECT 1 FROM _prisma_migrations
           WHERE migration_name = '20260713220000_realtime_admission_leases'
             AND finished_at IS NOT NULL AND rolled_back_at IS NULL
        ) AS "migrationApplied"
    `;
    expect(indexes).toEqual({
      subjectIndex: true,
      tenantIndex: true,
      sessionHandleUnique: true,
      migrationApplied: true,
    });
  });

  it('sérialise deux réservations du même sujet entre répliques', async () => {
    const subjectHash = '1'.repeat(64);
    const results = await Promise.all(admissions.map((admission) => admission.reserve({
      companyId,
      subjectHash,
      maxSessionSeconds: 900,
    })));
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toEqual([
      expect.objectContaining({ allowed: false, denial: 'active_lease' }),
    ]);
    const winner = results.find((result) => result.allowed);
    if (!winner?.allowed) throw new Error('Concurrent reserve winner missing.');
    expect(await admissions[0]!.release({ ...winner.lease, providerTermination: 'not_created' })).toEqual({ ok: true, reason: null });
  }, 30_000);

  it('partage le quota glissant utilisateur entre répliques et utilise l’horloge DB', async () => {
    const subjectHash = '2'.repeat(64);
    for (let index = 0; index < 2; index += 1) {
      const result = await admissions[index]!.reserve({ companyId, subjectHash, maxSessionSeconds: 900 });
      if (!result.allowed) throw new Error(`Unexpected denial ${result.denial}`);
      await admissions[index]!.release({ ...result.lease, providerTermination: 'not_created' });
    }
    const denied = await admissions[0]!.reserve({ companyId, subjectHash, maxSessionSeconds: 900 });
    expect(denied).toMatchObject({ allowed: false, denial: 'user_minute' });
    if (denied.allowed) throw new Error('Expected sliding-window denial.');
    expect(Date.parse(denied.retryAt!)).toBeGreaterThan(Date.now() - 5_000);
  });

  it('fence les transitions CAS et ne libère pas un provider sans hangup confirmé', async () => {
    const subjectHash = '3'.repeat(64);
    const result = await admissions[0]!.reserve({ companyId, subjectHash, maxSessionSeconds: 60 });
    if (!result.allowed) throw new Error(`Unexpected denial ${result.denial}`);
    const forged = { ...result.lease, leaseToken: `${result.lease.leaseToken}-forged` };
    expect(await admissions[0]!.bindProvider({ ...forged, providerCallId: 'rtc_cert_1' })).toEqual({ ok: false, reason: 'rejected' });
    const bound = await admissions[0]!.bindProvider({ ...result.lease, providerCallId: 'rtc_cert_1' });
    expect(bound.ok).toBe(true);
    expect(await admissions[1]!.bindProvider({ ...result.lease, providerCallId: 'rtc_cert_1' })).toEqual(bound);
    expect(await admissions[0]!.bindProvider({ ...result.lease, providerCallId: 'rtc_other' })).toEqual({ ok: false, reason: 'rejected' });
    expect(await admissions[0]!.release({ ...result.lease, providerTermination: 'not_created' })).toEqual({ ok: false, reason: 'rejected' });
    const activated = await admissions[1]!.activate(result.lease);
    expect(activated.ok).toBe(true);
    expect(await admissions[0]!.activate(result.lease)).toEqual(activated);
    expect((await admissions[0]!.renew(result.lease)).ok).toBe(true);
    expect(await admissions[1]!.release({ ...result.lease, providerTermination: 'confirmed' })).toEqual({ ok: true, reason: null });
  });

  it('fence le reaper et isole strictement les deux tenants', async () => {
    const subjectHash = '4'.repeat(64);
    const result = await admissions[0]!.reserve({ companyId, subjectHash, maxSessionSeconds: 60 });
    if (!result.allowed) throw new Error(`Unexpected denial ${result.denial}`);
    await admissions[0]!.bindProvider({ ...result.lease, providerCallId: 'rtc_cert_stale' });
    await admin.$executeRaw`
      UPDATE realtime_session_leases
         SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
       WHERE "companyId" = ${companyId} AND "subjectHash" = ${subjectHash}
    `;
    const blocked = await admissions[1]!.reserve({ companyId, subjectHash, maxSessionSeconds: 60 });
    expect(blocked).toMatchObject({ allowed: false, denial: 'session_reaping' });
    if (blocked.allowed || !blocked.reapingClaim) throw new Error('Reaping claim missing.');
    expect(await admissions[0]!.completeReaping({
      companyId,
      subjectHash,
      sessionId: result.lease.sessionId,
      reaperToken: `${blocked.reapingClaim.reaperToken}-forged`,
    })).toEqual({ ok: false, reason: 'rejected' });

    const hiddenFromOtherTenant = await workers[0]!.withTenant(otherCompanyId, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM realtime_session_leases WHERE "companyId" = ${companyId}
      `;
      return row?.count ?? -1;
    });
    expect(hiddenFromOtherTenant).toBe(0);
    expect(await admissions[0]!.completeReaping({
      companyId,
      subjectHash,
      sessionId: result.lease.sessionId,
      reaperToken: blocked.reapingClaim.reaperToken,
    })).toEqual({ ok: true, reason: null });
  });

  it('réclame une terminaison explicite depuis une autre réplique sans exposer le callId au client', async () => {
    const subjectHash = '5'.repeat(64);
    const result = await admissions[0]!.reserve({ companyId, subjectHash, maxSessionSeconds: 60 });
    if (!result.allowed) throw new Error(`Unexpected denial ${result.denial}`);
    await admissions[0]!.bindProvider({ ...result.lease, providerCallId: 'rtc_cross_replica' });
    await admissions[0]!.activate(result.lease);

    expect(await admissions[1]!.claimTermination({
      companyId,
      subjectHash,
      sessionId: '00000000-0000-4000-8000-999999999999',
    })).toEqual({ ok: true, claim: null, pending: false });
    const termination = await admissions[1]!.claimTermination({
      companyId,
      subjectHash,
      sessionId: result.lease.sessionId,
    });
    expect(termination.ok).toBe(true);
    if (!termination.ok || !termination.claim) throw new Error('Cross-replica termination claim missing.');
    expect(termination.claim.providerCallId).toBe('rtc_cross_replica');
    expect(await admissions[0]!.completeReaping({
      companyId,
      subjectHash,
      sessionId: result.lease.sessionId,
      reaperToken: termination.claim.reaperToken,
    })).toEqual({ ok: true, reason: null });
  });

  it('persiste le contexte écran entre répliques avec révision et RLS fail-closed', async () => {
    const subjectHash = '8'.repeat(64);
    const result = await admissions[0]!.reserve({ companyId, subjectHash, maxSessionSeconds: 60 });
    if (!result.allowed) throw new Error(`Unexpected denial ${result.denial}`);
    await admissions[0]!.bindProvider({ ...result.lease, providerCallId: 'rtc_context_replica' });
    const identity = { companyId, subjectHash, sessionId: result.lease.sessionId };
    const context = {
      screen: { name: 'Détail facture', instanceId: 'invoice:cert-42' },
      entities: [{ type: 'invoice', id: 'cert-42', label: 'Facture <FA-42>' }],
      capabilities: ['screen.read', 'invoice.read'],
    };

    expect(await admissions[0]!.updateContext({
      ...identity,
      version: 1,
      revision: 3,
      context,
    })).toEqual({ ok: true, status: 'updated', revision: 3 });
    expect(await admissions[1]!.updateContext({
      ...identity,
      version: 1,
      revision: 3,
      context,
    })).toEqual({ ok: true, status: 'idempotent', revision: 3 });
    expect(await admissions[1]!.updateContext({
      ...identity,
      version: 1,
      revision: 2,
      context,
    })).toEqual({ ok: false, reason: 'stale' });
    expect(await admissions[1]!.updateContext({
      ...identity,
      version: 1,
      revision: 3,
      context: { ...context, screen: { ...context.screen, name: 'Autre écran' } },
    })).toEqual({ ok: false, reason: 'conflict' });
    expect(await admissions[1]!.readContext(identity)).toEqual({ ok: false, reason: 'rejected' });

    await admissions[1]!.activate(result.lease);
    expect(await admissions[0]!.readContext(identity)).toEqual({
      ok: true,
      snapshot: {
        version: 1,
        revision: 3,
        context: {
          ...context,
          entities: [{ type: 'invoice', id: 'cert-42', label: 'Facture FA-42' }],
        },
      },
    });
    expect(await admissions[0]!.readContext({ ...identity, companyId: otherCompanyId })).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(await admissions[0]!.release({ ...result.lease, providerTermination: 'confirmed' })).toEqual({
      ok: true,
      reason: null,
    });
  });

  it('fence les retries bootstrap par le session handle UUID fourni par le mobile', async () => {
    const subjectHash = '6'.repeat(64);
    const sessionId = randomUUID();
    const input = { companyId, subjectHash, sessionId, maxSessionSeconds: 60 };
    const results = await Promise.all([
      admissions[0]!.reserve(input),
      admissions[1]!.reserve(input),
    ]);
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toEqual([
      expect.objectContaining({ allowed: false, denial: 'active_lease' }),
    ]);
    const winner = results.find((result) => result.allowed);
    if (!winner?.allowed) throw new Error('Mobile handle winner missing.');
    expect(winner.lease.sessionId).toBe(sessionId);
    await admissions[0]!.release({ ...winner.lease, providerTermination: 'not_created' });
    expect(await admissions[1]!.reserve(input)).toEqual({ allowed: false, denial: 'active_lease', retryAt: null });
    expect(await admissions[0]!.reserve({ ...input, subjectHash: '7'.repeat(64) })).toEqual({
      allowed: false,
      denial: 'unavailable',
      retryAt: null,
    });
    expect(await admissions[0]!.reserve({ ...input, sessionId: 'invalid' })).toEqual({
      allowed: false,
      denial: 'unavailable',
      retryAt: null,
    });
  }, 30_000);
});
