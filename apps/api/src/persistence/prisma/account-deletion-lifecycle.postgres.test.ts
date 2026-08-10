import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Company } from '@bob/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authUserDeletionSubjectHash,
  type AuthUserDeletionJobRepository,
} from '../auth-user-deletion-jobs';
import { notificationPayloadFingerprint } from '../notification-jobs';
import { PrismaAuthUserDeletionJobRepository } from './auth-user-deletion-jobs.prisma';
import { PrismaCompanyRepository } from './repositories';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT =
  process.env.RUN_POSTGRES_ACCOUNT_DELETION_LIFECYCLE_CERT === 'true';
const CLOSED_AT = new Date('2026-08-02T10:00:00.000Z');

interface CompanyFixture {
  readonly companyId: string;
  readonly userId: string;
  readonly name: string;
}

function deferred() {
  let resolve = (): void => undefined;
  let reject = (_reason?: unknown): void => undefined;
  const promise = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

async function waitUntilBlockedBy(input: {
  admin: PrismaClient;
  blockedPid: number;
  blockerPid: number;
  context: string;
}): Promise<void> {
  const deadline = Date.now() + 900;
  let lastBlockers: number[] = [];
  while (Date.now() < deadline) {
    const [observation] = await input.admin.$queryRaw<Array<{ blockerPids: number[] }>>`
      SELECT pg_catalog.pg_blocking_pids(${input.blockedPid}::integer) AS "blockerPids"
    `;
    lastBlockers = observation?.blockerPids ?? [];
    if (lastBlockers.length === 1 && lastBlockers[0] === input.blockerPid) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(
    `${input.context}: backend ${input.blockedPid} non bloqué exclusivement par ` +
      `${input.blockerPid}; blockers=${JSON.stringify(lastBlockers)}`,
  );
}

function withLuhnCheckDigit(prefix: string): string {
  let sum = 0;
  let double = true;
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    let digit = Number(prefix[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return `${prefix}${(10 - (sum % 10)) % 10}`;
}

function randomValidSiren(): string {
  const entropy = Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 12), 16);
  return withLuhnCheckDigit(String(10_000_000 + (entropy % 90_000_000)));
}

function validSiret(siren: string): string {
  const establishment = Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 6), 16);
  return withLuhnCheckDigit(`${siren}${String(establishment % 10_000).padStart(4, '0')}`);
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Account deletion lifecycle — certification PostgreSQL/RLS non-superuser',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const companyIds: string[] = [];
    const cabinetIds: string[] = [];
    let admin: PrismaClient;
    let concurrentAdmin: PrismaClient;
    let firstWorker: PrismaService;
    let secondWorker: PrismaService;
    let firstJobs: AuthUserDeletionJobRepository;
    let secondJobs: AuthUserDeletionJobRepository;

    async function seedCompany(label: string): Promise<CompanyFixture> {
      const userId = `o7-${randomUUID()}`;
      const companyId = `company-${userId}`;
      const siren = randomValidSiren();
      const name = `O7 ${label} ${userId.slice(-8)}`;
      await admin.company.create({
        data: {
          id: companyId,
          name,
          legalForm: 'EI',
          siren,
          siret: validSiret(siren),
          trade: 'autre',
          vatRegime: 'reel_normal',
          addrLine1: '7 rue de la Certification',
          addrZip: '75007',
          addrCity: 'Paris',
        },
      });
      companyIds.push(companyId);
      return { companyId, userId, name };
    }

    async function requestInTenant(
      worker: PrismaService,
      jobs: AuthUserDeletionJobRepository,
      fixture: CompanyFixture,
      requestId: string,
    ) {
      return worker.withTenant(fixture.companyId, () =>
        jobs.ensureRequested({
          requestId,
          companyId: fixture.companyId,
          userId: fixture.userId,
          requestedAt: CLOSED_AT.toISOString(),
        }),
      );
    }

    async function closeWithRequest(
      worker: PrismaService,
      jobs: AuthUserDeletionJobRepository,
      fixture: CompanyFixture,
      requestId: string,
    ) {
      return worker.withTenant(fixture.companyId, async () => {
        const requested = await jobs.ensureRequested({
          requestId,
          companyId: fixture.companyId,
          userId: fixture.userId,
          requestedAt: CLOSED_AT.toISOString(),
        });
        if (requested.outcome === 'rejected') return requested;
        const updated = await worker.client().$executeRaw`
          UPDATE public.companies
             SET "closedAt" = ${CLOSED_AT},
                 "closureReason" = 'certification O7'
           WHERE id = ${fixture.companyId}
             AND "closedAt" IS NULL
        `;
        if (updated !== 1) throw new Error('O7_COMPANY_CLOSE_NOT_APPLIED');
        return requested;
      });
    }

    async function closeAsWriterN1(
      worker: PrismaService,
      fixture: CompanyFixture,
    ): Promise<void> {
      await worker.withTenant(fixture.companyId, async () => {
        // Chemin exact du writer N-1 : repository Company historique, sans aucune RPC/outbox O7.
        const companies = new PrismaCompanyRepository(worker);
        const current = await companies.lockById(fixture.companyId);
        if (!current) throw new Error('O7_N1_COMPANY_MISSING');
        const closed = Company.of({
          ...current.toProps(),
          closedAt: CLOSED_AT.toISOString(),
          closureReason: 'writer N-1',
        });
        if (!closed.ok) throw new Error('O7_N1_COMPANY_INVALID');
        await companies.save(closed.value);
      });
    }

    async function seedNotification(
      fixture: CompanyFixture,
      suffix: string,
    ): Promise<string> {
      // L'outbox email v2 impose une clé provider stable exactement égale à l'UUID du job.
      const id = randomUUID();
      const notification = {
        channel: 'email' as const,
        to: `${suffix}@example.com`,
        subject: `Sujet personnel ${suffix}`,
        body: `Contenu personnel ${suffix}`,
        idempotencyKey: id,
      };
      await admin.notificationJob.create({
        data: {
          id,
          companyId: fixture.companyId,
          kind: 'invoice-relance',
          dedupeKey: `invoice:${suffix}:relance:o7`,
          channel: notification.channel,
          recipient: notification.to,
          subject: notification.subject,
          payload: notification,
          payloadFingerprint: notificationPayloadFingerprint(notification),
          status: 'pending',
          attempts: 0,
          nextAttemptAt: new Date('2026-08-02T09:00:00.000Z'),
        },
      });
      return id;
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL runtime et DIRECT_URL deployer sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
      concurrentAdmin = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
      firstWorker = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      secondWorker = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      firstJobs = new PrismaAuthUserDeletionJobRepository(firstWorker);
      secondJobs = new PrismaAuthUserDeletionJobRepository(secondWorker);
      await Promise.all([
        admin.$connect(),
        concurrentAdmin.$connect(),
        firstWorker.$connect(),
        secondWorker.$connect(),
      ]);

      const runtime = await firstWorker.$queryRaw<
        Array<{
          superuser: boolean;
          bypassRls: boolean;
          directTable: boolean;
          canSetAuthority: boolean;
        }>
      >`
        SELECT role.rolsuper AS superuser,
               role.rolbypassrls AS "bypassRls",
               has_table_privilege(
                 current_user,
                 'public.auth_user_deletion_jobs',
                 'SELECT,INSERT,UPDATE,DELETE'
               ) AS "directTable",
               pg_has_role(current_user, 'bob_auth_user_deletion_authority', 'SET')
                 AS "canSetAuthority"
          FROM pg_roles AS role
         WHERE role.rolname = current_user
      `;
      expect(runtime).toEqual([
        { superuser: false, bypassRls: false, directTable: false, canSetAuthority: false },
      ]);
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin && (companyIds.length > 0 || cabinetIds.length > 0)) {
          await admin.$transaction(async (tx) => {
            await tx.authUserDeletionJob.deleteMany({
              where: { companyId: { in: companyIds } },
            });
            await tx.notificationJob.deleteMany({ where: { companyId: { in: companyIds } } });
            // Réouverture technique limitée aux fixtures : neutralise le trigger uniquement pour
            // cet UPDATE, puis réactive triggers et FK AVANT chaque DELETE. Une nouvelle dépendance
            // oubliée doit faire échouer le certificat, jamais devenir orpheline silencieusement.
            await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
            await tx.company.updateMany({
              where: { id: { in: companyIds } },
              data: { closedAt: null, closureReason: null },
            });
            await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
            if (cabinetIds.length > 0) {
              await tx.cabinetMember.deleteMany({ where: { cabinetId: { in: cabinetIds } } });
              await tx.cabinet.deleteMany({ where: { id: { in: cabinetIds } } });
            }
            await tx.company.deleteMany({ where: { id: { in: companyIds } } });
          });
        }
      } finally {
        await Promise.allSettled([
          firstWorker?.$disconnect(),
          secondWorker?.$disconnect(),
          concurrentAdmin?.$disconnect(),
          admin?.$disconnect(),
        ]);
      }
    });

    it('preflight ouverte = zéro outbox ; même transaction de clôture = requestId exact ; cross-tenant refusé', async () => {
      const fixture = await seedCompany('preflight');
      const other = await seedCompany('cross-tenant');
      const standaloneRequestId = randomUUID();

      await expect(
        requestInTenant(firstWorker, firstJobs, fixture, standaloneRequestId),
      ).resolves.toEqual({
        outcome: 'accepted',
        request: {
          requestId: standaloneRequestId,
          status: 'pending',
          alreadyRequested: false,
        },
      });
      expect(
        await admin.authUserDeletionJob.count({ where: { companyId: fixture.companyId } }),
      ).toBe(0);

      const crossTenant = await firstWorker.withTenant(fixture.companyId, () =>
        firstJobs.ensureRequested({
          requestId: randomUUID(),
          companyId: other.companyId,
          userId: other.userId,
          requestedAt: CLOSED_AT.toISOString(),
        }),
      );
      expect(crossTenant).toEqual({
        outcome: 'rejected',
        reason: 'company_owner_binding_mismatch',
      });
      expect(
        await admin.authUserDeletionJob.count({ where: { companyId: other.companyId } }),
      ).toBe(0);

      const committedRequestId = randomUUID();
      const closed = await closeWithRequest(
        firstWorker,
        firstJobs,
        fixture,
        committedRequestId,
      );
      expect(closed).toEqual({
        outcome: 'accepted',
        request: {
          requestId: committedRequestId,
          status: 'pending',
          alreadyRequested: false,
        },
      });
      expect(
        await admin.authUserDeletionJob.findUniqueOrThrow({ where: { id: committedRequestId } }),
      ).toMatchObject({
        companyId: fixture.companyId,
        userId: fixture.userId,
        subjectHash: authUserDeletionSubjectHash(fixture.userId),
        status: 'pending',
        attempts: 0,
      });
      const [databaseHash] = await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE bob_auth_user_deletion_authority');
        return tx.$queryRaw<Array<{ subjectHash: string }>>`
          SELECT public.auth_user_deletion_subject_hash_v1(${fixture.userId}) AS "subjectHash"
        `;
      });
      expect(databaseHash?.subjectHash).toBe(authUserDeletionSubjectHash(fixture.userId));
    });

    it('writer N-1 crée le reçu, minimise A, refuse post-close et laisse le tenant B intact', async () => {
      const tenantA = await seedCompany('notification-a');
      const tenantB = await seedCompany('notification-b');
      const notificationA = await seedNotification(tenantA, `a-${randomUUID()}`);
      const notificationB = await seedNotification(tenantB, `b-${randomUUID()}`);

      await closeAsWriterN1(firstWorker, tenantA);

      const job = await admin.authUserDeletionJob.findUniqueOrThrow({
        where: { companyId: tenantA.companyId },
      });
      expect(job).toMatchObject({
        companyId: tenantA.companyId,
        userId: tenantA.userId,
        subjectHash: authUserDeletionSubjectHash(tenantA.userId),
        status: 'pending',
      });
      expect(await admin.notificationJob.findUniqueOrThrow({ where: { id: notificationA } }))
        .toMatchObject({
          status: 'cancelled',
          payload: null,
          recipient: '[redacted]',
          subject: '[redacted]',
          payloadFingerprint: null,
          leaseToken: null,
          lastError: null,
        });
      expect(await admin.notificationJob.findUniqueOrThrow({ where: { id: notificationB } }))
        .toMatchObject({ status: 'pending', recipient: expect.stringContaining('@example.com') });

      await expect(seedNotification(tenantA, `post-close-${randomUUID()}`)).rejects.toThrow(
        /NOTIFICATION_COMPANY_CLOSED/u,
      );
      await expect(
        admin.notificationJob.update({
          where: { id: notificationA },
          data: { subject: 'Réhydratation interdite' },
        }),
      ).rejects.toThrow(/NOTIFICATION_COMPANY_CLOSED|notification_jobs_open_company_fence/u);
    });

    it('claim global prouve SKIP LOCKED, ignore toute Company ouverte et fence retry/lease expirée', async () => {
      const closedA = await seedCompany('claim-a');
      const closedB = await seedCompany('claim-b');
      const open = await seedCompany('claim-open');
      await closeAsWriterN1(firstWorker, closedA);
      await closeAsWriterN1(secondWorker, closedB);

      const openJobId = randomUUID();
      await admin.authUserDeletionJob.create({
        data: {
          id: openJobId,
          companyId: open.companyId,
          provider: 'supabase',
          userId: open.userId,
          subjectHash: authUserDeletionSubjectHash(open.userId),
          status: 'pending',
          attempts: 0,
          nextAttemptAt: new Date('1800-01-01T00:00:00.000Z'),
        },
      });
      const closedJobs = await admin.authUserDeletionJob.findMany({
        where: { companyId: { in: [closedA.companyId, closedB.companyId] } },
      });
      expect(closedJobs).toHaveLength(2);
      await admin.authUserDeletionJob.update({
        where: { companyId: closedA.companyId },
        data: { nextAttemptAt: new Date('1900-01-01T00:00:00.000Z') },
      });
      await admin.authUserDeletionJob.update({
        where: { companyId: closedB.companyId },
        data: { nextAttemptAt: new Date('1900-01-02T00:00:00.000Z') },
      });

      const lockedJob = closedJobs.find((job) => job.companyId === closedA.companyId)!;
      const unlockedJob = closedJobs.find((job) => job.companyId === closedB.companyId)!;
      const rowLocked = deferred();
      const releaseRow = deferred();
      const lockTransaction = concurrentAdmin.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT id
             FROM public.auth_user_deletion_jobs
             WHERE id = ${lockedJob.id}::uuid
             FOR UPDATE
          `;
          rowLocked.resolve();
          await releaseRow.promise;
        },
        { maxWait: 2_000, timeout: 5_000 },
      );
      await rowLocked.promise;

      let firstClaim: Awaited<ReturnType<AuthUserDeletionJobRepository['claimDue']>> = [];
      try {
        firstClaim = await firstJobs.claimDue(1);
        expect(firstClaim).toHaveLength(1);
        expect(firstClaim[0]?.id).toBe(unlockedJob.id);
      } finally {
        releaseRow.resolve();
        await lockTransaction;
      }
      const secondClaim = await secondJobs.claimDue(1);
      expect(firstClaim).toHaveLength(1);
      expect(secondClaim).toHaveLength(1);
      const claims = [...firstClaim, ...secondClaim];
      expect(new Set(claims.map((claim) => claim.id))).toEqual(
        new Set(closedJobs.map((job) => job.id)),
      );
      expect(claims.map((claim) => claim.companyId)).not.toContain(open.companyId);
      expect(
        await admin.authUserDeletionJob.findUniqueOrThrow({ where: { id: openJobId } }),
      ).toMatchObject({ attempts: 0, leaseToken: null });

      const staleClaim = claims[0]!;
      await admin.authUserDeletionJob.update({
        where: { id: staleClaim.id },
        data: { nextAttemptAt: new Date('1900-01-03T00:00:00.000Z') },
      });
      const reclaimed = await firstJobs.claimDue(1);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]).toMatchObject({ id: staleClaim.id, attempts: 2 });
      expect(reclaimed[0]!.leaseToken).not.toBe(staleClaim.leaseToken);
      await expect(firstJobs.markDone(staleClaim.id, staleClaim.leaseToken)).resolves.toBe(false);
      await expect(
        firstJobs.markDone(reclaimed[0]!.id, reclaimed[0]!.leaseToken),
      ).resolves.toBe(true);

      const otherClaim = claims.find((claim) => claim.id !== staleClaim.id)!;
      await expect(firstJobs.markFailed(otherClaim.id, randomUUID(), 'http_5xx', 60_000))
        .resolves.toBe(false);
      expect(
        await admin.authUserDeletionJob.findUniqueOrThrow({ where: { id: otherClaim.id } }),
      ).toMatchObject({ status: 'pending', leaseToken: otherClaim.leaseToken, lastErrorCode: null });
      await expect(firstJobs.markFailed(otherClaim.id, otherClaim.leaseToken, 'http_5xx', 60_000))
        .resolves.toBe(true);
      expect(
        await admin.authUserDeletionJob.findUniqueOrThrow({ where: { id: otherClaim.id } }),
      ).toMatchObject({ status: 'failed', leaseToken: null, lastErrorCode: 'http_5xx' });
      expect(
        await admin.authUserDeletionJob.findUniqueOrThrow({ where: { id: staleClaim.id } }),
      ).toMatchObject({ status: 'done', userId: null, leaseToken: null });
    });

    it('course Cabinet gagnante : la clôture timeoute sans mutation puis le retry est rejeté métier', async () => {
      const fixture = await seedCompany('cabinet-race');
      const cabinetId = `o7-cabinet-${randomUUID()}`;
      cabinetIds.push(cabinetId);
      await admin.cabinet.create({
        data: {
          id: cabinetId,
          name: 'Cabinet O7 certification',
          timeZone: 'Europe/Paris',
          status: 'active',
          createdByUserId: fixture.userId,
          bootstrapCompletedAt: CLOSED_AT,
          version: 1,
          createdAt: CLOSED_AT,
          updatedAt: CLOSED_AT,
        },
      });

      const membershipInserted = deferred();
      const releaseMembership = deferred();
      const membership = concurrentAdmin.$transaction(
        async (tx) => {
          await tx.cabinetMember.create({
            data: {
              id: `o7-member-${randomUUID()}`,
              cabinetId,
              userId: fixture.userId,
              role: 'admin',
              status: 'active',
              joinedAt: CLOSED_AT,
              version: 1,
              createdAt: CLOSED_AT,
              updatedAt: CLOSED_AT,
            },
          });
          membershipInserted.resolve();
          await releaseMembership.promise;
        },
        { maxWait: 2_000, timeout: 5_000 },
      );
      await membershipInserted.promise;

      try {
        await expect(
          closeWithRequest(firstWorker, firstJobs, fixture, randomUUID()),
        ).rejects.toThrow(/lock timeout|canceling statement due to lock timeout/u);
      } finally {
        releaseMembership.resolve();
        await membership;
      }

      expect(
        await admin.company.findUniqueOrThrow({ where: { id: fixture.companyId } }),
      ).toMatchObject({ closedAt: null, closureReason: null });
      expect(
        await admin.authUserDeletionJob.count({ where: { companyId: fixture.companyId } }),
      ).toBe(0);
      await expect(
        requestInTenant(firstWorker, firstJobs, fixture, randomUUID()),
      ).resolves.toEqual({ outcome: 'rejected', reason: 'active_cabinet_memberships' });
    });

    it('course suppression gagnante : membership bloquée puis refusée par le reçu durable exact', async () => {
      const fixture = await seedCompany('deletion-wins');
      const cabinetId = `o7-cabinet-${randomUUID()}`;
      const requestId = randomUUID();
      cabinetIds.push(cabinetId);
      await admin.cabinet.create({
        data: {
          id: cabinetId,
          name: 'Cabinet O7 deletion-wins',
          timeZone: 'Europe/Paris',
          status: 'active',
          createdByUserId: fixture.userId,
          bootstrapCompletedAt: CLOSED_AT,
          version: 1,
          createdAt: CLOSED_AT,
          updatedAt: CLOSED_AT,
        },
      });

      let closerPid = 0;
      const closeApplied = deferred();
      const releaseClose = deferred();
      const closing = firstWorker.withTenant(fixture.companyId, async () => {
        const [pidRow] = await firstWorker.client().$queryRaw<Array<{ pid: number }>>`
          SELECT pg_catalog.pg_backend_pid() AS pid
        `;
        closerPid = pidRow?.pid ?? 0;
        if (closerPid <= 0) throw new Error('O7_CLOSER_PID_UNAVAILABLE');
        const requested = await firstJobs.ensureRequested({
          requestId,
          companyId: fixture.companyId,
          userId: fixture.userId,
          requestedAt: CLOSED_AT.toISOString(),
        });
        if (requested.outcome === 'rejected') throw new Error(requested.reason);
        const updated = await firstWorker.client().$executeRaw`
          UPDATE public.companies
             SET "closedAt" = ${CLOSED_AT},
                 "closureReason" = 'deletion wins'
           WHERE id = ${fixture.companyId}
             AND "closedAt" IS NULL
        `;
        if (updated !== 1) throw new Error('O7_DELETION_WIN_CLOSE_NOT_APPLIED');
        closeApplied.resolve();
        await releaseClose.promise;
        return requested;
      });
      await Promise.race([
        closeApplied.promise,
        closing.then(() => {
          throw new Error('O7_DELETION_WIN_COMMITTED_BEFORE_GATE');
        }),
      ]);

      let memberPid = 0;
      const memberStarted = deferred();
      const memberId = `o7-member-${randomUUID()}`;
      const membership = concurrentAdmin.$transaction(
        async (tx) => {
          const [pidRow] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_catalog.pg_backend_pid() AS pid
          `;
          memberPid = pidRow?.pid ?? 0;
          if (memberPid <= 0) throw new Error('O7_MEMBER_PID_UNAVAILABLE');
          memberStarted.resolve();
          await tx.$executeRaw`
            INSERT INTO public.cabinet_members (
              id, "cabinetId", "userId", role, status, "joinedAt", version,
              "createdAt", "updatedAt"
            ) VALUES (
              ${memberId}, ${cabinetId}, ${fixture.userId}, 'admin', 'active', ${CLOSED_AT}, 1,
              ${CLOSED_AT}, ${CLOSED_AT}
            )
          `;
        },
        { maxWait: 2_000, timeout: 5_000 },
      );
      const membershipOutcome = membership.then(
        () => ({ ok: true as const, error: null }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await memberStarted.promise;

      let blockingError: unknown;
      try {
        await waitUntilBlockedBy({
          admin,
          blockedPid: memberPid,
          blockerPid: closerPid,
          context: 'O7 deletion-wins membership',
        });
      } catch (error) {
        blockingError = error;
      } finally {
        releaseClose.resolve();
      }

      const [closed, memberResult] = await Promise.all([closing, membershipOutcome]);
      if (blockingError) throw blockingError;
      expect(closed).toEqual({
        outcome: 'accepted',
        request: { requestId, status: 'pending', alreadyRequested: false },
      });
      expect(memberResult.ok).toBe(false);
      const failure = memberResult.error as {
        code?: unknown;
        message?: unknown;
        meta?: { code?: unknown; message?: unknown };
      };
      expect(failure.code).toBe('P2010');
      expect(failure.meta?.code).toBe('23514');
      expect(failure.meta?.message).toMatch(/CABINET_MEMBER_AUTH_SUBJECT_DELETION_REQUESTED/u);
      const closedCompany = await admin.company.findUniqueOrThrow({
        where: { id: fixture.companyId },
      });
      expect(closedCompany.closedAt).not.toBeNull();
      expect(closedCompany.closureReason).toBe('deletion wins');
      expect(
        await admin.authUserDeletionJob.count({ where: { companyId: fixture.companyId } }),
      ).toBe(1);
      expect(
        await admin.cabinetMember.count({ where: { id: memberId } }),
      ).toBe(0);
    }, 10_000);
  },
);
