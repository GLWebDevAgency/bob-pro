import { randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RealtimeAdmissionPolicy } from './realtime-admission';
import { PrismaRealtimeAdmission } from './realtime-admission.prisma';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaRealtimeReaperDirectory } from './realtime-reaper-directory.prisma';
import type { RealtimeReaperDirectoryListResult } from './realtime-reaper-directory';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_REALTIME_ADMISSION_CERT === 'true';

function explainUsesIndex(plan: Prisma.JsonValue, indexName: string): boolean {
  return JSON.stringify(plan).includes(`"Index Name":"${indexName}"`);
}

function explainExecutionMs(plan: Prisma.JsonValue): number | null {
  if (!Array.isArray(plan)) return null;
  const root = plan[0];
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const value = root['Execution Time'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForBlockedBy(
  observer: PrismaClient,
  blockedPid: number,
  blockingPid: number,
): Promise<void> {
  // La fonction trigger possède lock_timeout=1s. On observe donc la vraie arête de verrou puis on
  // libère immédiatement le reconciler, sans utiliser un sleep comme hypothèse de synchronisation.
  const deadlineAt = Date.now() + 750;
  let lastState: { waitEventType: string | null; expectedBlocker: boolean } | undefined;
  do {
    [lastState] = await observer.$queryRaw<Array<{
      waitEventType: string | null;
      expectedBlocker: boolean;
    }>>`
      SELECT activity.wait_event_type AS "waitEventType",
             ${blockingPid}::integer = ANY(
               pg_catalog.pg_blocking_pids(activity.pid)
             ) AS "expectedBlocker"
        FROM pg_catalog.pg_stat_activity AS activity
       WHERE activity.pid = ${blockedPid}
    `;
    if (lastState?.waitEventType === 'Lock' && lastState.expectedBlocker) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (Date.now() < deadlineAt);
  throw new Error(
    `Writer ${blockedPid} was not observed waiting for reconciler ${blockingPid}: `
      + JSON.stringify(lastState),
  );
}

interface ReaperScheduleTestAccess {
  reconcileReaperSchedule(
    tx: Prisma.TransactionClient,
    companyId: string,
  ): Promise<void>;
}

async function resetRealtimeReaperCursor(admin: PrismaClient): Promise<void> {
  await admin.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE bob_realtime_reaper_directory`;
    await tx.$executeRaw`
      UPDATE realtime_reaper_directory_cursor
         SET "afterAdmissionCompanyId" = NULL,
             "cycleUpperAdmissionCompanyId" = NULL,
             "cycleAdmissionCutoffAt" = NULL,
             "afterLeaseCompanyId" = NULL,
             "cycleUpperLeaseCompanyId" = NULL,
             "cycleLeaseCutoffAt" = NULL,
             "preferLease" = TRUE,
             "pendingCompanyIds" = ARRAY[]::text[],
             "pendingAfterAdmissionCompanyId" = NULL,
             "pendingAfterLeaseCompanyId" = NULL,
             "pendingAdmissionHasMore" = NULL,
             "pendingLeaseHasMore" = NULL,
             "pendingPreferLease" = NULL,
             "claimId" = NULL,
             "claimExpiresAt" = NULL,
             revision = revision + 1
       WHERE singleton
    `;
  });
}

const policy: RealtimeAdmissionPolicy = {
  globalCapacity: {
    providerId: 'openai', providerModel: 'gpt-realtime-2.1',
    globalMaxSessions: 1_000, providerMaxSessions: 1_000, configVersion: 1,
  },
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
  let directories: PrismaRealtimeReaperDirectory[] = [];
  const directoryCompanyIds: string[] = [];

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
    directories = workers.map((worker) => new PrismaRealtimeReaperDirectory(worker));
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
      const allCompanyIds = [companyId, otherCompanyId, ...directoryCompanyIds];
      await admin.realtimeSessionLease.deleteMany({ where: { companyId: { in: allCompanyIds } } }).catch(() => undefined);
      await admin.realtimeAdmissionEvent.deleteMany({ where: { companyId: { in: allCompanyIds } } }).catch(() => undefined);
      await admin.company.deleteMany({ where: { id: { in: allCompanyIds } } }).catch(() => undefined);
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
      providerIdentityUnique: boolean;
      legacyProviderUniqueAbsent: boolean;
      admissionMigrationApplied: boolean;
      providerMigrationApplied: boolean;
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
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'realtime_session_leases'::regclass
             AND conname = 'realtime_session_leases_provider_call_identity_key'
             AND contype = 'u'
        ) AS "providerIdentityUnique",
        NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'realtime_session_leases'::regclass
             AND conname = 'realtime_session_leases_provider_call_id_key'
        ) AS "legacyProviderUniqueAbsent",
        EXISTS (
          SELECT 1 FROM _prisma_migrations
           WHERE migration_name = '20260713220000_realtime_admission_leases'
             AND finished_at IS NOT NULL AND rolled_back_at IS NULL
        ) AS "admissionMigrationApplied",
        EXISTS (
          SELECT 1 FROM _prisma_migrations
           WHERE migration_name = '20260714020000_realtime_provider_identity'
             AND finished_at IS NOT NULL AND rolled_back_at IS NULL
        ) AS "providerMigrationApplied"
    `;
    expect(indexes).toEqual({
      subjectIndex: true,
      tenantIndex: true,
      sessionHandleUnique: true,
      providerIdentityUnique: true,
      legacyProviderUniqueAbsent: true,
      admissionMigrationApplied: true,
      providerMigrationApplied: true,
    });
  });

  it('pagine plus de 100 tenants sans famine et fence le claim entre deux répliques', async () => {
    const tenantCount = 125;
    const sirenBase = randomInt(200_000_000, 700_000_000);
    const now = Date.now();
    const companies = Array.from({ length: tenantCount }, (_, index) => {
      const id = `reaper-directory-${String(index).padStart(4, '0')}-${randomUUID()}`;
      directoryCompanyIds.push(id);
      const siren = String(sirenBase + index);
      return {
        id,
        name: `Bob Reaper Directory Certification ${index}`,
        legalForm: 'EI' as const,
        siren,
        siret: `${siren}${String(index).padStart(5, '0')}`,
        trade: 'certification',
        vatRegime: 'reel_normal' as const,
        addrLine1: `${index + 1} rue de la Certification`,
        addrZip: '75001',
        addrCity: 'Paris',
      };
    });
    await admin.company.createMany({ data: companies });
    await admin.realtimeAdmissionEvent.createMany({
      data: companies.map((company, index) => ({
        id: randomUUID(),
        companyId: company.id,
        subjectHash: index.toString(16).padStart(64, '0'),
        sessionId: randomUUID(),
        admittedAt: new Date(now - 3 * 60 * 60 * 1_000 + index),
      })),
    });
    // Un tenant très bruyant ne doit compter qu'une fois dans une page globale.
    await admin.realtimeAdmissionEvent.createMany({
      data: Array.from({ length: 250 }, (_, index) => ({
        id: randomUUID(),
        companyId: companies[0]!.id,
        subjectHash: `f${index.toString(16).padStart(63, '0')}`,
        sessionId: randomUUID(),
        admittedAt: new Date(now - 4 * 60 * 60 * 1_000 + index),
      })),
    });

    // Une lease due reste prioritaire même si la lane admission contient déjà plus d'une page.
    const leaseOnlyCompanyId = `reaper-directory-lease-${randomUUID()}`;
    const leaseOnlySiren = String(sirenBase + tenantCount + 10);
    directoryCompanyIds.push(leaseOnlyCompanyId);
    await admin.company.create({
      data: {
        id: leaseOnlyCompanyId,
        name: 'Bob Reaper Lease Lane Certification',
        legalForm: 'EI',
        siren: leaseOnlySiren,
        siret: `${leaseOnlySiren}${String(tenantCount + 10).padStart(5, '0')}`,
        trade: 'certification',
        vatRegime: 'reel_normal',
        addrLine1: `${tenantCount + 11} rue de la Certification`,
        addrZip: '75001',
        addrCity: 'Paris',
      },
    });
    await admin.realtimeSessionLease.create({
      data: {
        companyId: leaseOnlyCompanyId,
        subjectHash: 'e'.repeat(64),
        sessionId: randomUUID(),
        leaseTokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        state: 'reserved',
        reservedAt: new Date(now - 60_000),
        leaseExpiresAt: new Date(now - 30_000),
        hardExpiresAt: new Date(now + 60_000),
        updatedAt: new Date(now - 30_000),
      },
    });

    const contenders = await Promise.all(
      directories.map((directory) => directory.listDueCompanyIds({ limit: 25 })),
    );
    const first = contenders.find((result) =>
      result.status === 'succeeded' && result.companyIds.length > 0);
    const blocked = contenders.find((result) =>
      result.status === 'succeeded' && result.companyIds.length === 0);
    expect(first).toEqual(expect.objectContaining({
      status: 'succeeded', hasMore: true,
    }));
    expect(blocked).toEqual({
      status: 'succeeded', companyIds: [], hasMore: false, claimId: null,
    });
    if (!first || first.status !== 'succeeded' || first.claimId === null) {
      throw new Error('Realtime reaper first page missing.');
    }
    expect(first.companyIds).toContain(leaseOnlyCompanyId);

    const [frozenCycle] = await admin.$queryRaw<Array<{
      cycleAdmissionCutoffAt: Date;
      cycleUpperAdmissionCompanyId: string;
      pendingAfterAdmissionCompanyId: string;
    }>>`
      SELECT "cycleAdmissionCutoffAt", "cycleUpperAdmissionCompanyId",
             "pendingAfterAdmissionCompanyId"
        FROM realtime_reaper_directory_cursor
       WHERE singleton
    `;
    if (
      !frozenCycle?.cycleAdmissionCutoffAt
      || !frozenCycle.cycleUpperAdmissionCompanyId
      || !frozenCycle.pendingAfterAdmissionCompanyId
    ) {
      throw new Error('Realtime reaper frozen admission cycle missing.');
    }
    const cutoffCompanyId = `reaper-directory-0060z-${randomUUID()}`;
    const cutoffSiren = String(sirenBase + tenantCount + 20);
    directoryCompanyIds.push(cutoffCompanyId);
    await admin.company.create({
      data: {
        id: cutoffCompanyId,
        name: 'Bob Reaper Frozen Cutoff Certification',
        legalForm: 'EI',
        siren: cutoffSiren,
        siret: `${cutoffSiren}${String(tenantCount + 20).padStart(5, '0')}`,
        trade: 'certification',
        vatRegime: 'reel_normal',
        addrLine1: `${tenantCount + 21} rue de la Certification`,
        addrZip: '75001',
        addrCity: 'Paris',
      },
    });
    await admin.realtimeAdmissionEvent.create({
      data: {
        id: randomUUID(),
        companyId: cutoffCompanyId,
        subjectHash: 'd'.repeat(64),
        sessionId: randomUUID(),
        admittedAt: new Date(frozenCycle.cycleAdmissionCutoffAt.getTime() + 1),
      },
    });
    expect(cutoffCompanyId > frozenCycle.pendingAfterAdmissionCompanyId).toBe(true);
    expect(cutoffCompanyId < frozenCycle.cycleUpperAdmissionCompanyId).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const replayedCompanyIds = [...first.companyIds];
    await admin.$executeRaw`
      UPDATE realtime_reaper_directory_cursor
         SET "claimExpiresAt" = statement_timestamp() - interval '1 microsecond'
       WHERE singleton
    `;
    await expect(directories[0]!.renewClaim({ claimId: first.claimId })).resolves.toEqual({
      status: 'succeeded', renewed: false,
    });
    // Une page louée reste byte-for-byte rejouable même si la configuration vient de passer
    // de 25 à 5. La nouvelle borne ne s'appliquera qu'à la page suivante.
    const [replay, expiredAck] = await Promise.all([
      directories[1]!.listDueCompanyIds({ limit: 5 }),
      directories[0]!.acknowledgeClaim({ claimId: first.claimId }),
    ]);
    expect(expiredAck).toEqual({ status: 'succeeded', acknowledged: false });
    expect(replay).toEqual(expect.objectContaining({
      status: 'succeeded', companyIds: replayedCompanyIds, hasMore: true,
    }));
    expect(replayedCompanyIds.length).toBeGreaterThan(5);
    if (replay.status !== 'succeeded' || replay.claimId === null) {
      throw new Error('Realtime reaper replay claim missing.');
    }
    expect(replay.claimId).not.toBe(first.claimId);
    await expect(directories[0]!.acknowledgeClaim({ claimId: first.claimId })).resolves.toEqual({
      status: 'succeeded', acknowledged: false,
    });

    const reached = new Set<string>();
    const visits = new Map<string, number>();
    const lateCompanyIds: string[] = [];
    let page: RealtimeReaperDirectoryListResult = replay;
    for (
      let pageIndex = 0;
      pageIndex < 10 && page.status === 'succeeded' && page.companyIds.length > 0;
      pageIndex += 1
    ) {
      // Trois arrivées plus récentes deviennent dues pendant le cycle. La borne haute figée doit
      // permettre de finir les 125 lignes initiales, puis de les reprendre au cycle suivant sans
      // famine ni extension infinie du scan courant.
      if (pageIndex < 3) {
        // Le préfixe z place ces tenants au-delà de la borne haute figée du cycle courant.
        const lateCompanyId = `reaper-directory-z-late-${randomUUID()}`;
        const lateSiren = String(sirenBase + tenantCount + pageIndex);
        lateCompanyIds.push(lateCompanyId);
        directoryCompanyIds.push(lateCompanyId);
        await admin.company.create({
          data: {
            id: lateCompanyId,
            name: `Bob Reaper Late Arrival ${pageIndex}`,
            legalForm: 'EI',
            siren: lateSiren,
            siret: `${lateSiren}${String(tenantCount + pageIndex).padStart(5, '0')}`,
            trade: 'certification',
            vatRegime: 'reel_normal',
            addrLine1: `${tenantCount + pageIndex + 1} rue de la Certification`,
            addrZip: '75001',
            addrCity: 'Paris',
          },
        });
        await admin.realtimeAdmissionEvent.create({
          data: {
            id: randomUUID(),
            companyId: lateCompanyId,
            subjectHash: String(tenantCount + pageIndex).padStart(64, '0'),
            sessionId: randomUUID(),
            admittedAt: new Date(now - 3 * 60 * 60 * 1_000 + 10_000 + pageIndex),
          },
        });
      }
      if (page.hasMore) {
        expect(page.companyIds).not.toEqual(
          expect.arrayContaining([cutoffCompanyId, ...lateCompanyIds]),
        );
      }
      for (const dueCompanyId of page.companyIds) {
        reached.add(dueCompanyId);
        visits.set(dueCompanyId, (visits.get(dueCompanyId) ?? 0) + 1);
        await expect(admissions[0]!.claimExpired({ companyId: dueCompanyId, limit: 2 }))
          .resolves.toEqual({ ok: true, claims: [] });
      }
      await expect(directories[0]!.renewClaim({ claimId: page.claimId! })).resolves.toEqual({
        status: 'succeeded', renewed: true,
      });
      await expect(directories[0]!.acknowledgeClaim({ claimId: page.claimId! })).resolves.toEqual({
        status: 'succeeded', acknowledged: true,
      });
      page = await directories[0]!.listDueCompanyIds({ limit: 25 });
      if (page.status !== 'succeeded') throw new Error('Realtime reaper pagination unavailable.');
    }
    expect(reached).toEqual(new Set(directoryCompanyIds));
    expect(visits.get(companies[0]!.id)).toBe(1);
    expect(page).toEqual({
      status: 'succeeded', companyIds: [], hasMore: false, claimId: null,
    });

    const [cursor] = await admin.$queryRaw<Array<{
      claimId: string | null;
      afterAdmissionCompanyId: string | null;
      cycleUpperAdmissionCompanyId: string | null;
      cycleAdmissionCutoffAt: Date | null;
      afterLeaseCompanyId: string | null;
      cycleUpperLeaseCompanyId: string | null;
      cycleLeaseCutoffAt: Date | null;
      revision: bigint;
    }>>`
      SELECT "claimId", "afterAdmissionCompanyId", "cycleUpperAdmissionCompanyId",
             "cycleAdmissionCutoffAt", "afterLeaseCompanyId", "cycleUpperLeaseCompanyId",
             "cycleLeaseCutoffAt", revision
        FROM realtime_reaper_directory_cursor
       WHERE singleton
    `;
    expect(cursor).toEqual(expect.objectContaining({
      claimId: null,
      afterAdmissionCompanyId: null,
      cycleUpperAdmissionCompanyId: null,
      cycleAdmissionCutoffAt: null,
      afterLeaseCompanyId: null,
      cycleUpperLeaseCompanyId: null,
      cycleLeaseCutoffAt: null,
    }));
    expect(cursor?.revision).toBeGreaterThan(0n);
  }, 60_000);

  it('alterne les deux lanes avec limit=1 et remplit une page lease-only', async () => {
    const sirenBase = randomInt(710_000_000, 850_000_000);
    const now = Date.now();
    const leaseCompanies = Array.from({ length: 7 }, (_, index) => {
      const id = `reaper-fair-lease-${String(index).padStart(2, '0')}-${randomUUID()}`;
      directoryCompanyIds.push(id);
      const siren = String(sirenBase + index);
      return {
        id,
        name: `Bob Reaper Fair Lease ${index}`,
        legalForm: 'EI' as const,
        siren,
        siret: `${siren}${String(index + 300).padStart(5, '0')}`,
        trade: 'certification',
        vatRegime: 'reel_normal' as const,
        addrLine1: `${index + 300} rue de la Certification`,
        addrZip: '75001',
        addrCity: 'Paris',
      };
    });
    const admissionOnlyCompanyId = `reaper-fair-admission-${randomUUID()}`;
    const admissionSiren = String(sirenBase + 20);
    directoryCompanyIds.push(admissionOnlyCompanyId);
    await admin.company.createMany({
      data: [
        ...leaseCompanies,
        {
          id: admissionOnlyCompanyId,
          name: 'Bob Reaper Fair Admission',
          legalForm: 'EI' as const,
          siren: admissionSiren,
          siret: `${admissionSiren}${String(320).padStart(5, '0')}`,
          trade: 'certification',
          vatRegime: 'reel_normal' as const,
          addrLine1: '320 rue de la Certification',
          addrZip: '75001',
          addrCity: 'Paris',
        },
      ],
    });
    await admin.realtimeSessionLease.createMany({
      data: leaseCompanies.map((company, index) => ({
        companyId: company.id,
        subjectHash: (index + 20).toString(16).padStart(64, '0'),
        sessionId: randomUUID(),
        leaseTokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        state: 'reserved',
        reservedAt: new Date(now - 60_000),
        leaseExpiresAt: new Date(now - 30_000),
        hardExpiresAt: new Date(now + 60_000),
        updatedAt: new Date(now - 30_000),
      })),
    });
    await admin.realtimeAdmissionEvent.create({
      data: {
        id: randomUUID(),
        companyId: admissionOnlyCompanyId,
        subjectHash: 'c'.repeat(64),
        sessionId: randomUUID(),
        admittedAt: new Date(now - 3 * 60 * 60 * 1_000),
      },
    });
    await admin.$executeRaw`
      UPDATE realtime_reaper_directory_cursor
         SET "afterAdmissionCompanyId" = NULL,
             "cycleUpperAdmissionCompanyId" = NULL,
             "cycleAdmissionCutoffAt" = NULL,
             "afterLeaseCompanyId" = NULL,
             "cycleUpperLeaseCompanyId" = NULL,
             "cycleLeaseCutoffAt" = NULL,
             "preferLease" = TRUE,
             "pendingCompanyIds" = ARRAY[]::text[],
             "pendingAfterAdmissionCompanyId" = NULL,
             "pendingAfterLeaseCompanyId" = NULL,
             "pendingAdmissionHasMore" = NULL,
             "pendingLeaseHasMore" = NULL,
             "pendingPreferLease" = NULL,
             "claimId" = NULL,
             "claimExpiresAt" = NULL
       WHERE singleton
    `;

    const leaseTurn = await directories[0]!.listDueCompanyIds({ limit: 1 });
    expect(leaseTurn).toEqual(expect.objectContaining({
      status: 'succeeded', companyIds: [leaseCompanies[0]!.id], hasMore: true,
    }));
    if (leaseTurn.status !== 'succeeded' || leaseTurn.claimId === null) {
      throw new Error('Realtime reaper lease turn missing.');
    }
    await expect(directories[0]!.acknowledgeClaim({ claimId: leaseTurn.claimId })).resolves
      .toEqual({ status: 'succeeded', acknowledged: true });

    const admissionTurn = await directories[0]!.listDueCompanyIds({ limit: 1 });
    expect(admissionTurn).toEqual(expect.objectContaining({
      status: 'succeeded', companyIds: [admissionOnlyCompanyId], hasMore: true,
    }));
    if (admissionTurn.status !== 'succeeded' || admissionTurn.claimId === null) {
      throw new Error('Realtime reaper admission turn missing.');
    }
    await expect(directories[0]!.acknowledgeClaim({ claimId: admissionTurn.claimId })).resolves
      .toEqual({ status: 'succeeded', acknowledged: true });

    await admin.realtimeAdmissionEvent.deleteMany({ where: { companyId: admissionOnlyCompanyId } });
    await expect(admissions[0]!.claimExpired({ companyId: admissionOnlyCompanyId, limit: 1 }))
      .resolves.toEqual({ ok: true, claims: [] });
    await admin.$executeRaw`
      UPDATE realtime_reaper_directory_cursor
         SET "afterAdmissionCompanyId" = NULL,
             "cycleUpperAdmissionCompanyId" = NULL,
             "cycleAdmissionCutoffAt" = NULL,
             "afterLeaseCompanyId" = NULL,
             "cycleUpperLeaseCompanyId" = NULL,
             "cycleLeaseCutoffAt" = NULL,
             "preferLease" = TRUE
       WHERE singleton
    `;
    const leaseOnlyPage = await directories[0]!.listDueCompanyIds({ limit: 5 });
    expect(leaseOnlyPage).toEqual(expect.objectContaining({
      status: 'succeeded', companyIds: leaseCompanies.slice(0, 5).map(({ id }) => id),
      hasMore: true,
    }));
    if (leaseOnlyPage.status !== 'succeeded' || leaseOnlyPage.claimId === null) {
      throw new Error('Realtime reaper full lease-only page missing.');
    }
    await expect(directories[0]!.acknowledgeClaim({ claimId: leaseOnlyPage.claimId })).resolves
      .toEqual({ status: 'succeeded', acknowledged: true });
    await admin.realtimeSessionLease.deleteMany({
      where: { companyId: { in: leaseCompanies.map(({ id }) => id) } },
    });
    for (const company of leaseCompanies) {
      await expect(admissions[0]!.claimExpired({ companyId: company.id, limit: 1 }))
        .resolves.toEqual({ ok: true, claims: [] });
    }
    await admin.$executeRaw`
      UPDATE realtime_reaper_directory_cursor
         SET "afterAdmissionCompanyId" = NULL,
             "cycleUpperAdmissionCompanyId" = NULL,
             "cycleAdmissionCutoffAt" = NULL,
             "afterLeaseCompanyId" = NULL,
             "cycleUpperLeaseCompanyId" = NULL,
             "cycleLeaseCutoffAt" = NULL,
             "preferLease" = TRUE
       WHERE singleton
    `;
  }, 30_000);

  it('fige aussi le cutoff lease pendant un cycle puis reprend la nouvelle échéance', async () => {
    const suffix = randomUUID();
    const ids = {
      first: `reaper-freeze-lease-${suffix}-a`,
      late: `reaper-freeze-lease-${suffix}-b`,
      last: `reaper-freeze-lease-${suffix}-c`,
    } as const;
    directoryCompanyIds.push(ids.first, ids.late, ids.last);
    const sirenBase = randomInt(500_000_000, 800_000_000);
    await admin.company.createMany({
      data: Object.values(ids).map((id, index) => {
        const siren = String(sirenBase + index);
        return {
          id,
          name: `Bob Reaper Frozen Lease ${index}`,
          legalForm: 'EI' as const,
          siren,
          siret: `${siren}${String(index + 700).padStart(5, '0')}`,
          trade: 'certification',
          vatRegime: 'reel_normal' as const,
          addrLine1: `${index + 700} rue de la Certification`,
          addrZip: '75001',
          addrCity: 'Paris',
        };
      }),
    });
    const expiredAt = new Date(Date.now() - 30_000);
    await admin.realtimeSessionLease.createMany({
      data: [ids.first, ids.last].map((tenantId, index) => ({
        companyId: tenantId,
        subjectHash: (index + 800).toString(16).padStart(64, '0'),
        sessionId: randomUUID(),
        leaseTokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        state: 'reserved',
        reservedAt: new Date(expiredAt.getTime() - 30_000),
        leaseExpiresAt: expiredAt,
        hardExpiresAt: new Date(Date.now() + 60_000),
        updatedAt: expiredAt,
      })),
    });

    const first = await directories[0]!.listDueCompanyIds({ limit: 1 });
    expect(first).toEqual(expect.objectContaining({
      status: 'succeeded', companyIds: [ids.first], hasMore: true,
    }));
    if (first.status !== 'succeeded' || first.claimId === null) {
      throw new Error('Realtime reaper frozen lease first page missing.');
    }
    const [cycle] = await admin.$queryRaw<Array<{
      cutoffAt: Date;
      upperCompanyId: string;
    }>>`
      SELECT "cycleLeaseCutoffAt" AS "cutoffAt",
             "cycleUpperLeaseCompanyId" AS "upperCompanyId"
        FROM realtime_reaper_directory_cursor
       WHERE singleton
    `;
    if (!cycle?.cutoffAt || cycle.upperCompanyId !== ids.last) {
      throw new Error('Realtime reaper frozen lease cursor missing.');
    }
    await admin.realtimeSessionLease.create({
      data: {
        companyId: ids.late,
        subjectHash: 'f'.repeat(64),
        sessionId: randomUUID(),
        leaseTokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        state: 'reserved',
        reservedAt: cycle.cutoffAt,
        leaseExpiresAt: new Date(cycle.cutoffAt.getTime() + 20),
        hardExpiresAt: new Date(cycle.cutoffAt.getTime() + 60_000),
        updatedAt: cycle.cutoffAt,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(admissions[0]!.claimExpired({ companyId: ids.first, limit: 1 }))
      .resolves.toEqual({ ok: true, claims: [] });
    await expect(directories[0]!.acknowledgeClaim({ claimId: first.claimId })).resolves
      .toEqual({ status: 'succeeded', acknowledged: true });

    const last = await directories[0]!.listDueCompanyIds({ limit: 1 });
    expect(last).toEqual(expect.objectContaining({
      status: 'succeeded', companyIds: [ids.last], hasMore: false,
    }));
    if (last.status !== 'succeeded' || last.claimId === null) {
      throw new Error('Realtime reaper frozen lease last page missing.');
    }
    await expect(admissions[0]!.claimExpired({ companyId: ids.last, limit: 1 }))
      .resolves.toEqual({ ok: true, claims: [] });
    await expect(directories[0]!.acknowledgeClaim({ claimId: last.claimId })).resolves
      .toEqual({ status: 'succeeded', acknowledged: true });

    const nextCycle = await directories[0]!.listDueCompanyIds({ limit: 1 });
    expect(nextCycle).toEqual(expect.objectContaining({
      status: 'succeeded', companyIds: [ids.late], hasMore: false,
    }));
    if (nextCycle.status !== 'succeeded' || nextCycle.claimId === null) {
      throw new Error('Realtime reaper late lease page missing.');
    }
    await expect(admissions[0]!.claimExpired({ companyId: ids.late, limit: 1 }))
      .resolves.toEqual({ ok: true, claims: [] });
    await expect(directories[0]!.acknowledgeClaim({ claimId: nextCycle.claimId })).resolves
      .toEqual({ status: 'succeeded', acknowledged: true });
  }, 30_000);

  it('prouve la projection keyset sous RLS à capacité pleine avec un historique très bruyant', async () => {
    const tenantCount = 1_000;
    const hotAdmissionRows = 20_000;
    const sirenBase = randomInt(100_000_000, 500_000_000);
    const now = Date.now();
    const companies = Array.from({ length: tenantCount }, (_, index) => {
      const id = `reaper-plan-${String(index).padStart(4, '0')}-${randomUUID()}`;
      directoryCompanyIds.push(id);
      const siren = String(sirenBase + index);
      return {
        id,
        name: `Bob Reaper Plan ${index}`,
        legalForm: 'EI' as const,
        siren,
        siret: `${siren}${String(index + 1_000).padStart(5, '0')}`,
        trade: 'certification',
        vatRegime: 'reel_normal' as const,
        addrLine1: `${index + 1_000} rue de la Certification`,
        addrZip: '75001',
        addrCity: 'Paris',
      };
    });
    const companyIds = companies.map(({ id }) => id);
    try {
      await resetRealtimeReaperCursor(admin);
      await admin.company.createMany({ data: companies });
      await admin.realtimeAdmissionEvent.createMany({
        data: companies.map((company, index) => ({
          id: randomUUID(),
          companyId: company.id,
          subjectHash: (index + 1_000).toString(16).padStart(64, '0'),
          sessionId: randomUUID(),
          admittedAt: new Date(now - 3 * 60 * 60 * 1_000 + index),
        })),
      });
      await admin.realtimeSessionLease.createMany({
        data: companies.map((company, index) => ({
          companyId: company.id,
          subjectHash: (index + 2_000).toString(16).padStart(64, '0'),
          sessionId: randomUUID(),
          leaseTokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
          state: 'reserved',
          reservedAt: new Date(now - 60_000),
          leaseExpiresAt: new Date(now - 30_000),
          hardExpiresAt: new Date(now + 60_000),
          updatedAt: new Date(now - 30_000),
        })),
      });
      await admin.$executeRaw`
        INSERT INTO realtime_admission_events (
          id, "companyId", "subjectHash", "sessionId", "admittedAt"
        )
        SELECT gen_random_uuid(), ${companies[0]!.id},
               (md5('event-a-' || source.position::text)
                 || md5('event-b-' || source.position::text))::char(64),
               gen_random_uuid(), CASE
                 WHEN source.position <= ${hotAdmissionRows / 2}
                   THEN statement_timestamp() - interval '3 hours'
                 ELSE statement_timestamp()
               END
          FROM generate_series(1, ${hotAdmissionRows}) AS source(position)
      `;
      await admin.$executeRaw`ANALYZE realtime_admission_events`;
      await admin.$executeRaw`ANALYZE realtime_session_leases`;
      await admin.$executeRaw`ANALYZE realtime_reaper_tenant_schedule`;

      const [scheduleProjection] = await admin.$queryRaw<Array<{
        tenants: number;
      }>>`
        SELECT count(*)::int AS tenants
          FROM realtime_reaper_tenant_schedule
         WHERE "companyId" LIKE 'reaper-plan-%'
      `;
      const [capacityProjection] = await admin.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE bob_realtime_capacity`;
        return tx.$queryRaw<Array<{
          usedSessions: number;
          globalMaxSessions: number | null;
          capacityMode: string;
        }>>`
          SELECT capacity."usedSessions",
                 capacity."globalMaxSessions",
                 capacity.mode AS "capacityMode"
            FROM realtime_global_capacity AS capacity
           WHERE capacity.id = 1
        `;
      });
      const projection = { ...scheduleProjection, ...capacityProjection };
      expect(projection).toEqual({
        tenants: tenantCount,
        usedSessions: tenantCount,
        globalMaxSessions: tenantCount,
        capacityMode: 'active',
      });

      const plans = await admin.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE bob_realtime_reaper_directory`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '4s'`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
        const admissionUpperQuery = Prisma.sql`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT schedule."companyId"
            FROM realtime_reaper_tenant_schedule AS schedule
           WHERE schedule."oldestAdmissionAt" <= statement_timestamp() - interval '2 hours'
           ORDER BY schedule."companyId" DESC
           LIMIT 1
        `;
        const leaseUpperQuery = Prisma.sql`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT schedule."companyId"
            FROM realtime_reaper_tenant_schedule AS schedule
           WHERE schedule."nextLeaseDueAt" <= statement_timestamp()
           ORDER BY schedule."companyId" DESC
           LIMIT 1
        `;
        const admissionPageQuery = Prisma.sql`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT schedule."companyId"
            FROM realtime_reaper_tenant_schedule AS schedule
           WHERE schedule."oldestAdmissionAt" <= statement_timestamp() - interval '2 hours'
             AND schedule."companyId" <= ${companies.at(-1)!.id}
           ORDER BY schedule."companyId"
           LIMIT 101
        `;
        const leasePageQuery = Prisma.sql`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT schedule."companyId"
            FROM realtime_reaper_tenant_schedule AS schedule
           WHERE schedule."nextLeaseDueAt" <= statement_timestamp()
             AND schedule."companyId" <= ${companies.at(-1)!.id}
           ORDER BY schedule."companyId"
           LIMIT 101
        `;
        const admissionMiddlePageQuery = Prisma.sql`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT schedule."companyId"
            FROM realtime_reaper_tenant_schedule AS schedule
           WHERE schedule."oldestAdmissionAt" <= statement_timestamp() - interval '2 hours'
             AND schedule."companyId" > ${companies[Math.floor(tenantCount / 2)]!.id}
             AND schedule."companyId" <= ${companies.at(-1)!.id}
           ORDER BY schedule."companyId"
           LIMIT 101
        `;
        const leaseMiddlePageQuery = Prisma.sql`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT schedule."companyId"
            FROM realtime_reaper_tenant_schedule AS schedule
           WHERE schedule."nextLeaseDueAt" <= statement_timestamp()
             AND schedule."companyId" > ${companies[Math.floor(tenantCount / 2)]!.id}
             AND schedule."companyId" <= ${companies.at(-1)!.id}
           ORDER BY schedule."companyId"
           LIMIT 101
        `;
        const run = (query: Prisma.Sql) => tx.$queryRaw<
          Array<{ 'QUERY PLAN': Prisma.JsonValue }>
        >(query).then((rows) => rows[0]?.['QUERY PLAN']);
        const admissionUpper = await run(admissionUpperQuery);
        const leaseUpper = await run(leaseUpperQuery);
        const admissionPage = await run(admissionPageQuery);
        const leasePage = await run(leasePageQuery);
        const admissionMiddlePage = await run(admissionMiddlePageQuery);
        const leaseMiddlePage = await run(leaseMiddlePageQuery);
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        const forcedAdmissionPage = await run(admissionPageQuery);
        const forcedLeasePage = await run(leasePageQuery);
        await tx.$executeRaw`SET LOCAL enable_seqscan = on`;
        const claimId = randomUUID();
        const directoryPlan = await run(Prisma.sql`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT * FROM public.list_realtime_reaper_tenants_v1(100, ${claimId}::uuid)
        `);
        await tx.$queryRaw`
          SELECT public.ack_realtime_reaper_tenants_v1(${claimId}::uuid)
        `;
        return {
          admissionUpper,
          leaseUpper,
          admissionPage,
          leasePage,
          admissionMiddlePage,
          leaseMiddlePage,
          forcedAdmissionPage,
          forcedLeasePage,
          directoryPlan,
        };
      });

      for (const plan of [
        plans.admissionUpper,
        plans.leaseUpper,
        plans.admissionPage,
        plans.leasePage,
        plans.admissionMiddlePage,
        plans.leaseMiddlePage,
        plans.directoryPlan,
      ]) {
        expect(plan).toBeDefined();
        expect(explainExecutionMs(plan!)).toBeLessThan(100);
        expect(JSON.stringify(plan)).not.toMatch(
          /realtime_(?:admission_events|session_leases)/u,
        );
      }
      expect(explainUsesIndex(
        plans.forcedAdmissionPage!, 'realtime_reaper_schedule_admission_due_idx',
      ) || explainUsesIndex(
        plans.forcedAdmissionPage!, 'realtime_reaper_tenant_schedule_pkey',
      )).toBe(true);
      expect(explainUsesIndex(
        plans.forcedLeasePage!, 'realtime_reaper_schedule_lease_due_idx',
      ) || explainUsesIndex(
        plans.forcedLeasePage!, 'realtime_reaper_tenant_schedule_pkey',
      )).toBe(true);
      // Le choix naturel reste volontairement cost-based : sur 1 000 lignes toutes dues,
      // PostgreSQL peut préférer un scan de la seule projection en moins d'une milliseconde.
      // Les assertions ci-dessus bornent ce plan et interdisent tout accès aux historiques ; les
      // deux plans `enable_seqscan = off` prouvent séparément que chaque requête reste indexable.
      // Le planner demeure libre de choisir le PK keyset ou l'index partiel ; leurs définitions,
      // validité et readiness exactes sont certifiées indépendamment par le certificat release.
    } finally {
      try {
        await admin.realtimeSessionLease.deleteMany({ where: { companyId: { in: companyIds } } });
        await admin.realtimeAdmissionEvent.deleteMany({ where: { companyId: { in: companyIds } } });
        await admin.company.deleteMany({ where: { id: { in: companyIds } } });
      } finally {
        await resetRealtimeReaperCursor(admin);
      }
    }
  }, 60_000);

  it('ne perd pas une échéance insérée pendant la réconciliation exacte', async () => {
    const raceCompanyId = `reaper-schedule-race-${randomUUID()}`;
    const siren = String(randomInt(100_000_000, 999_999_999));
    directoryCompanyIds.push(raceCompanyId);
    await admin.company.create({
      data: {
        id: raceCompanyId,
        name: 'Bob Reaper Schedule Race Certification',
        legalForm: 'EI',
        siren,
        siret: `${siren}${String(randomInt(0, 99_999)).padStart(5, '0')}`,
        trade: 'certification',
        vatRegime: 'reel_normal',
        addrLine1: '1 rue de la Concurrence',
        addrZip: '75001',
        addrCity: 'Paris',
      },
    });

    const baselineAt = new Date(Date.now() - 30 * 60 * 1_000);
    const concurrentAt = new Date(baselineAt.getTime() - 3 * 60 * 60 * 1_000);
    await admin.realtimeAdmissionEvent.create({
      data: {
        id: randomUUID(),
        companyId: raceCompanyId,
        subjectHash: '7'.repeat(64),
        sessionId: randomUUID(),
        admittedAt: baselineAt,
      },
    });

    const scheduleLocked = deferred<{ pid: number }>();
    const continueReconciliation = deferred<void>();
    const reconcilerPromise = workers[0]!.withIsolatedTenant(
      raceCompanyId,
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ pid: number; companyId: string }>>`
          SELECT pg_catalog.pg_backend_pid()::integer AS pid,
                 schedule."companyId"
            FROM realtime_reaper_tenant_schedule AS schedule
           WHERE schedule."companyId" = ${raceCompanyId}
           FOR UPDATE
        `;
        if (locked.length !== 1) {
          throw new Error('Schedule row required before race certification.');
        }
        scheduleLocked.resolve({ pid: locked[0]!.pid });
        await continueReconciliation.promise;
        await (admissions[0]! as unknown as ReaperScheduleTestAccess)
          .reconcileReaperSchedule(tx, raceCompanyId);
      },
      { maxWaitMs: 1_000, timeoutMs: 5_000 },
    ).catch((error: unknown) => {
      scheduleLocked.reject(error);
      throw error;
    });

    const { pid: reconcilerPid } = await scheduleLocked.promise;
    const writerStarted = deferred<{ pid: number }>();
    const writerPromise = workers[1]!.withIsolatedTenant(
      raceCompanyId,
      async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_catalog.pg_backend_pid()::integer AS pid
        `;
        if (!backend) throw new Error('Writer backend PID missing.');
        writerStarted.resolve(backend);
        await tx.$executeRaw`
          INSERT INTO realtime_admission_events (
            id, "companyId", "subjectHash", "sessionId", "admittedAt"
          ) VALUES (
            ${randomUUID()}::uuid, ${raceCompanyId}, ${'8'.repeat(64)},
            ${randomUUID()}::uuid, ${concurrentAt}
          )
        `;
      },
      { maxWaitMs: 1_000, timeoutMs: 5_000 },
    ).catch((error: unknown) => {
      writerStarted.reject(error);
      throw error;
    });

    let observationError: unknown;
    try {
      const { pid: writerPid } = await writerStarted.promise;
      await waitForBlockedBy(admin, writerPid, reconcilerPid);
    } catch (error) {
      observationError = error;
    } finally {
      continueReconciliation.resolve(undefined);
    }

    const outcomes = await Promise.allSettled([reconcilerPromise, writerPromise]);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
    if (observationError) throw observationError;

    const [projection] = await admin.$queryRaw<Array<{
      scheduledAt: Date | null;
      sourceMinimumAt: Date | null;
    }>>`
      SELECT schedule."oldestAdmissionAt" AS "scheduledAt",
             (
               SELECT min(event."admittedAt")
                 FROM realtime_admission_events AS event
                WHERE event."companyId" = ${raceCompanyId}
             ) AS "sourceMinimumAt"
        FROM realtime_reaper_tenant_schedule AS schedule
       WHERE schedule."companyId" = ${raceCompanyId}
    `;
    expect(projection?.sourceMinimumAt).toEqual(concurrentAt);
    expect(projection?.scheduledAt).toEqual(concurrentAt);
  }, 30_000);

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
    expect(await admissions[0]!.bindProvider({ ...forged, providerId: 'openai', providerCallId: 'rtc_cert_1' })).toEqual({ ok: false, reason: 'rejected' });
    const bound = await admissions[0]!.bindProvider({ ...result.lease, providerId: 'openai', providerCallId: 'rtc_cert_1' });
    expect(bound.ok).toBe(true);
    expect(await admissions[1]!.bindProvider({ ...result.lease, providerId: 'openai', providerCallId: 'rtc_cert_1' })).toEqual(bound);
    expect(await admissions[0]!.bindProvider({ ...result.lease, providerId: 'mistral', providerCallId: 'rtc_cert_1' })).toEqual({ ok: false, reason: 'rejected' });
    expect(await admissions[0]!.bindProvider({ ...result.lease, providerId: 'openai', providerCallId: 'rtc_other' })).toEqual({ ok: false, reason: 'rejected' });
    expect(await admissions[0]!.release({ ...result.lease, providerTermination: 'not_created' })).toEqual({ ok: false, reason: 'rejected' });
    const activated = await admissions[1]!.activate(result.lease);
    expect(activated.ok).toBe(true);
    expect(await admissions[0]!.activate(result.lease)).toEqual(activated);
    expect((await admissions[0]!.renew(result.lease)).ok).toBe(true);
    expect(await admissions[1]!.release({ ...result.lease, providerTermination: 'confirmed' })).toEqual({ ok: true, reason: null });
  });

  it('compose provider + session distante, et rend cette identité immuable après bind', async () => {
    const remoteSessionId = `shared_${randomUUID()}`;
    const openai = await admissions[0]!.reserve({
      companyId,
      subjectHash: '9'.repeat(64),
      maxSessionSeconds: 60,
    });
    const mistral = await admissions[1]!.reserve({
      companyId,
      subjectHash: 'a'.repeat(64),
      maxSessionSeconds: 60,
    });
    if (!openai.allowed || !mistral.allowed) throw new Error('Provider identity leases missing.');
    expect(await admissions[0]!.bindProvider({
      ...openai.lease,
      providerId: 'openai',
      providerCallId: remoteSessionId,
    })).toMatchObject({ ok: true });
    expect(await admissions[1]!.bindProvider({
      ...mistral.lease,
      providerId: 'mistral',
      providerCallId: remoteSessionId,
    })).toMatchObject({ ok: true });

    const duplicate = await admissions[0]!.reserve({
      companyId,
      subjectHash: 'b'.repeat(64),
      maxSessionSeconds: 60,
    });
    if (!duplicate.allowed) throw new Error('Duplicate identity test lease missing.');
    expect(await admissions[0]!.bindProvider({
      ...duplicate.lease,
      providerId: 'openai',
      providerCallId: remoteSessionId,
    })).toEqual({ ok: false, reason: 'rejected' });

    await expect(admin.$executeRaw`
      UPDATE realtime_session_leases
         SET "providerCallId" = ${`${remoteSessionId}_mutated`}
       WHERE "companyId" = ${companyId}
         AND "subjectHash" = ${'9'.repeat(64)}
    `).rejects.toThrow(/bound provider identity is immutable/u);

    await admissions[0]!.release({ ...openai.lease, providerTermination: 'confirmed' });
    await admissions[1]!.release({ ...mistral.lease, providerTermination: 'confirmed' });
    await admissions[0]!.release({ ...duplicate.lease, providerTermination: 'not_created' });
  });

  it('fence le reaper et isole strictement les deux tenants', async () => {
    const subjectHash = '4'.repeat(64);
    const result = await admissions[0]!.reserve({ companyId, subjectHash, maxSessionSeconds: 60 });
    if (!result.allowed) throw new Error(`Unexpected denial ${result.denial}`);
    await admissions[0]!.bindProvider({ ...result.lease, providerId: 'mistral', providerCallId: 'rtc_cert_stale' });
    await admin.$executeRaw`
      UPDATE realtime_session_leases
         SET "leaseExpiresAt" = "reservedAt" + interval '1 microsecond'
       WHERE "companyId" = ${companyId} AND "subjectHash" = ${subjectHash}
    `;
    const blocked = await admissions[1]!.reserve({ companyId, subjectHash, maxSessionSeconds: 60 });
    expect(blocked).toMatchObject({ allowed: false, denial: 'session_reaping' });
    if (blocked.allowed || !blocked.reapingClaim) throw new Error('Reaping claim missing.');
    expect(blocked.reapingClaim.providerId).toBe('mistral');
    expect(blocked.reapingClaim.hardExpiryProof).toBeNull();
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

  it('émet la preuve hard-expired depuis clock_timestamp et la lie à l’identité complète', async () => {
    const subjectHash = '6'.repeat(64);
    const result = await admissions[0]!.reserve({ companyId, subjectHash, maxSessionSeconds: 60 });
    if (!result.allowed) throw new Error(`Unexpected denial ${result.denial}`);
    await admissions[0]!.bindProvider({
      ...result.lease,
      providerId: 'mistral',
      providerCallId: 'rtc_cert_hard_expired',
    });
    await admin.$executeRaw`
      UPDATE realtime_session_leases
         SET "leaseExpiresAt" = "reservedAt" + interval '1 microsecond',
             "hardExpiresAt" = "reservedAt" + interval '1 microsecond'
       WHERE "companyId" = ${companyId} AND "subjectHash" = ${subjectHash}
    `;

    const batch = await admissions[1]!.claimExpired({ companyId, limit: 10 });
    expect(batch.ok).toBe(true);
    if (!batch.ok) throw new Error('Hard-expired reaping batch missing.');
    const claim = batch.claims.find((candidate) => candidate.sessionId === result.lease.sessionId);
    expect(claim?.hardExpiryProof).toEqual(expect.objectContaining({
      source: 'database_hard_expiry',
      companyId,
      subjectHash,
      sessionId: result.lease.sessionId,
      providerId: 'mistral',
      providerCallId: 'rtc_cert_hard_expired',
    }));
    const proof = claim?.hardExpiryProof;
    if (!claim || !proof) throw new Error('Database hard-expiry proof missing.');
    expect(Date.parse(proof.databaseObservedAt)).toBeGreaterThanOrEqual(Date.parse(proof.hardExpiresAt));
    expect(await admissions[0]!.completeReaping({
      companyId,
      subjectHash,
      sessionId: result.lease.sessionId,
      reaperToken: claim.reaperToken,
    })).toEqual({ ok: true, reason: null });
  });

  it('réclame une terminaison explicite depuis une autre réplique sans exposer le callId au client', async () => {
    const subjectHash = '5'.repeat(64);
    const result = await admissions[0]!.reserve({ companyId, subjectHash, maxSessionSeconds: 60 });
    if (!result.allowed) throw new Error(`Unexpected denial ${result.denial}`);
    await admissions[0]!.bindProvider({ ...result.lease, providerId: 'mistral', providerCallId: 'rtc_cross_replica' });
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
    expect(termination.claim.providerId).toBe('mistral');
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
    await admissions[0]!.bindProvider({ ...result.lease, providerId: 'openai', providerCallId: 'rtc_context_replica' });
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
