import { randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NotificationDedupeConflictError,
  notificationPayloadFingerprint,
} from '../notification-jobs';
import { PrismaNotificationJobRepository } from './repositories';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_OUTBOX_CERT === 'true';
const WORKER_COUNT = 8;
const HISTORICAL_OUTBOX_RLS = `
  ALTER TABLE notification_jobs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE notification_jobs FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON notification_jobs;
  CREATE POLICY tenant_isolation ON notification_jobs
    USING ("companyId" = current_setting('app.current_company_id', true))
    WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
`;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!RUN_POSTGRES_CERT)('Notification outbox — certification PostgreSQL/RLS réelle', () => {
  const companyId = `outbox-cert-${randomUUID()}`;
  const siren = String(randomInt(100_000_000, 999_999_999));
  const siret = `${siren}00001`;
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let workers: PrismaService[] = [];

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workers = Array.from(
      { length: WORKER_COUNT },
      () => new PrismaService({ datasourceUrl: runtimeUrl }),
    );
    await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
    await admin.company.create({
      data: {
        id: companyId,
        name: 'Bob Outbox PostgreSQL Certification',
        legalForm: 'EI',
        siren,
        siret,
        trade: 'certification',
        vatRegime: 'reel_normal',
        addrLine1: '1 rue de la Certification',
        addrZip: '75001',
        addrCity: 'Paris',
      },
    });
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.notificationJob.deleteMany({ where: { companyId } }).catch(() => undefined);
      await admin.company.deleteMany({ where: { id: companyId } }).catch(() => undefined);
    }
    await Promise.allSettled([
      ...workers.map((worker) => worker.$disconnect()),
      ...(admin ? [admin.$disconnect()] : []),
    ]);
  });

  it('certifie migration, contrainte, index, READ COMMITTED et rôle FORCE RLS', async () => {
    const [role] = await workers[0]!.$queryRaw<Array<{
      userName: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      isolation: string;
    }>>`
      SELECT current_user AS "userName",
             rolsuper,
             rolbypassrls,
             current_setting('default_transaction_isolation') AS isolation
        FROM pg_roles
       WHERE rolname = current_user
    `;
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false, isolation: 'read committed' });

    const [shape] = await admin.$queryRaw<Array<{
      leaseNullable: string;
      rowSecurity: boolean;
      forceRowSecurity: boolean;
      constraintValidated: boolean;
      leaseConstraintValidated: boolean;
      migrationApplied: boolean;
      dueIndex: boolean;
      recentIndex: boolean;
      dueIndexDefinition: string;
      recentIndexDefinition: string;
      persistedProtocolGuc: boolean;
    }>>`
      SELECT
        (SELECT is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'notification_jobs'
            AND column_name = 'leaseToken') AS "leaseNullable",
        table_class.relrowsecurity AS "rowSecurity",
        table_class.relforcerowsecurity AS "forceRowSecurity",
        EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'notification_jobs'::regclass
             AND conname = 'notification_jobs_payload_shape'
             AND convalidated
        ) AS "constraintValidated",
        EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'notification_jobs'::regclass
             AND conname = 'notification_jobs_lease_shape'
             AND convalidated
        ) AS "leaseConstraintValidated",
        EXISTS (
          SELECT 1 FROM _prisma_migrations
           WHERE migration_name = '20260713043000_notification_job_lease_token'
             AND finished_at IS NOT NULL
             AND rolled_back_at IS NULL
        ) AS "migrationApplied",
        to_regclass('public.notification_jobs_due_deliverable_idx') IS NOT NULL AS "dueIndex",
        to_regclass('public.notification_jobs_recent_idx') IS NOT NULL AS "recentIndex",
        pg_get_indexdef('notification_jobs_due_deliverable_idx'::regclass) AS "dueIndexDefinition",
        pg_get_indexdef('notification_jobs_recent_idx'::regclass) AS "recentIndexDefinition",
        EXISTS (
          SELECT 1 FROM pg_db_role_setting setting,
               unnest(setting.setconfig) AS configured(value)
           WHERE configured.value LIKE 'app.notification_outbox_version=%'
        ) AS "persistedProtocolGuc"
      FROM pg_class AS table_class
      WHERE table_class.oid = 'notification_jobs'::regclass
    `;
    expect(shape).toEqual({
      leaseNullable: 'YES',
      rowSecurity: true,
      forceRowSecurity: true,
      constraintValidated: true,
      leaseConstraintValidated: true,
      migrationApplied: true,
      dueIndex: true,
      recentIndex: true,
      dueIndexDefinition: expect.stringContaining('("companyId", "nextAttemptAt", "createdAt")'),
      recentIndexDefinition: expect.stringContaining('("companyId", "createdAt" DESC)'),
      persistedProtocolGuc: false,
    });

    const invalidId = randomUUID();
    await expect(workers[0]!.withTenant(companyId, (tx) => tx.notificationJob.create({
      data: {
        id: invalidId,
        companyId,
        kind: 'invoice-relance',
        dedupeKey: `invalid-shape:${invalidId}`,
        channel: 'email',
        recipient: 'invalid@example.test',
        subject: 'Invalid',
        payload: {
          channel: 'email',
          to: 'invalid@example.test',
          subject: 'Invalid',
          body: 'Missing provider key',
        },
        payloadFingerprint: 'cert-invalid',
        nextAttemptAt: new Date(),
      },
    }))).rejects.toThrow();
  });

  it('upgrade réel : les jobs legacy ambigus sont backfillés puis mis en quarantaine', async () => {
    const databaseName = `outbox_upgrade_${randomUUID().replaceAll('-', '')}`;
    const upgradeUrl = new URL(directUrl);
    upgradeUrl.pathname = `/${databaseName}`;
    const migrationRoot = resolve(process.cwd(), 'prisma/migrations');
    let upgrade: PrismaClient | undefined;
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
      for (const migration of [
        '20260701000000_init',
        '20260701010000_documents',
        '20260701020000_document_archive_jobs',
        '20260701030000_agent_journal',
        '20260701040000_notification_jobs',
        '20260701050000_unique_invoice_parent_quote',
        '20260701060000_accounting_persistence',
        '20260701070000_supplier_memory',
        '20260703120000_document_tags',
        '20260703210000_invoice_deposit_deduction',
        '20260703230000_notifications_read_devices',
        '20260704020000_company_fiche_annuaire',
        '20260705120000_expense_facturx_reception',
        '20260712010000_cabinet_foundations',
      ]) {
        execFileSync('psql', [
          upgradeUrl.toString(),
          '-X',
          '-v',
          'ON_ERROR_STOP=1',
          '-f',
          resolve(migrationRoot, migration, 'migration.sql'),
        ], { stdio: 'pipe' });
      }
      execFileSync('psql', [upgradeUrl.toString(), '-X', '-v', 'ON_ERROR_STOP=1', '-c', `
        INSERT INTO companies (id, name, "legalForm", siren, siret, trade, "vatRegime", "addrLine1", "addrZip", "addrCity")
        VALUES ('legacy-co', 'Legacy', 'EI', '990000001', '99000000100001', 'cert', 'reel_normal', '1 rue A', '75001', 'Paris');
        INSERT INTO notification_jobs
          (id, "companyId", kind, "dedupeKey", channel, recipient, subject, payload, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
        VALUES
          ('legacy-non-uuid', 'legacy-co', 'invoice-relance', 'legacy:no-key', 'email', 'legacy@example.test', 'Legacy',
           '{"channel":"email","to":"legacy@example.test","subject":"Legacy","body":"Ambigu"}'::jsonb,
           'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('legacy-invalid', 'legacy-co', 'invoice-relance', 'legacy:invalid', 'email', 'invalid@example.test', 'Invalid',
           '{"unexpected":true}'::jsonb,
           'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('00000000-0000-4000-8000-000000000099', 'legacy-co', 'invoice-relance', 'legacy:already-keyed', 'email', 'safe@example.test', 'Safe',
           '{"channel":"email","to":"safe@example.test","subject":"Safe","body":"Sûr","idempotencyKey":"00000000-0000-4000-8000-000000000099"}'::jsonb,
           'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      `], { stdio: 'pipe' });
      const outboxMigrationPath = resolve(
        migrationRoot,
        '20260713043000_notification_job_lease_token',
        'migration.sql',
      );
      const migrationWithInjectedFailure = readFileSync(outboxMigrationPath, 'utf8').replace(
        '-- Avant v2 aucune tentative provider',
        'SELECT 1 / 0; -- faute injectée pour prouver le rollback intégral\n\n-- Avant v2 aucune tentative provider',
      );
      expect(() => execFileSync('psql', [
        upgradeUrl.toString(),
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        migrationWithInjectedFailure,
      ], { stdio: 'pipe' })).toThrow();
      const rolledBackShape = execFileSync('psql', [
        upgradeUrl.toString(),
        '-X',
        '-qAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `SELECT
           (SELECT count(*) FROM information_schema.columns
             WHERE table_name = 'notification_jobs'
               AND column_name IN ('leaseToken', 'providerAttemptedAt', 'payloadFingerprint', 'cutoverResumeAt'))
           +
           (SELECT count(*) FROM pg_trigger
             WHERE tgrelid = 'notification_jobs'::regclass
               AND tgname = 'notification_jobs_cutover_spool_v2');`,
      ], { encoding: 'utf8' }).trim();
      expect(rolledBackShape).toBe('0');

      execFileSync('psql', [
        upgradeUrl.toString(),
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        outboxMigrationPath,
      ], { stdio: 'pipe' });
      execFileSync('psql', [upgradeUrl.toString(), '-X', '-v', 'ON_ERROR_STOP=1', '-c', `
        INSERT INTO notification_jobs
          (id, "companyId", kind, "dedupeKey", channel, recipient, subject, payload, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
        VALUES
          ('00000000-0000-4000-8000-000000000088', 'legacy-co', 'invoice-relance', 'cutover:new-v1', 'email', 'cutover@example.test', 'Cutover',
           '{"channel":"email","to":"cutover@example.test","subject":"Cutover","body":"Créé pendant expand"}'::jsonb,
           'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      `], { stdio: 'pipe' });
      // Cette base représente strictement N-1 : les tables ajoutées après l'outbox n'y existent
      // volontairement pas. Rejouer le rls.sql courant couplerait ce test historique au schéma N
      // et le ferait casser à chaque nouvelle table. On réinstalle donc uniquement la policy
      // notification_jobs qui protégeait N-1, avant de tester le vrai cutover v2.
      execFileSync('psql', [
        upgradeUrl.toString(),
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        HISTORICAL_OUTBOX_RLS,
      ], { stdio: 'pipe' });
      execFileSync('sh', [resolve(process.cwd(), 'scripts/activate-notification-outbox-v2.sh')], {
        env: { ...process.env, DIRECT_URL: upgradeUrl.toString() },
        stdio: 'pipe',
      });
      // Le workflow de release rappelle l'opérateur après un cutover déjà acquis. La deuxième
      // exécution doit certifier l'état terminal sans tenter de relire la colonne expand supprimée.
      execFileSync('sh', [resolve(process.cwd(), 'scripts/activate-notification-outbox-v2.sh')], {
        env: { ...process.env, DIRECT_URL: upgradeUrl.toString() },
        stdio: 'pipe',
      });

      upgrade = new PrismaClient({ datasourceUrl: upgradeUrl.toString() });
      const [legacy, invalid, safe, cutover] = await Promise.all([
        upgrade.notificationJob.findUniqueOrThrow({ where: { id: 'legacy-non-uuid' } }),
        upgrade.notificationJob.findUniqueOrThrow({ where: { id: 'legacy-invalid' } }),
        upgrade.notificationJob.findUniqueOrThrow({ where: { id: '00000000-0000-4000-8000-000000000099' } }),
        upgrade.notificationJob.findUniqueOrThrow({ where: { id: '00000000-0000-4000-8000-000000000088' } }),
      ]);
      expect(legacy).toMatchObject({ status: 'failed', leaseToken: null, payload: null });
      expect(legacy.lastError).toContain('manual-review:legacy-provider-window-unknown');
      expect(legacy.nextAttemptAt.getUTCFullYear()).toBe(9999);
      expect(invalid).toMatchObject({ status: 'failed', payload: null, leaseToken: null });
      expect(invalid.lastError).toContain('manual-review:legacy-provider-window-unknown');
      expect(safe).toMatchObject({ status: 'failed', payload: null, leaseToken: null });
      expect(safe.lastError).toContain('manual-review:legacy-provider-window-unknown');
      expect(cutover).toMatchObject({ status: 'pending', lastError: null, leaseToken: null });
      expect(cutover.payload).toEqual(expect.objectContaining({
        idempotencyKey: '00000000-0000-4000-8000-000000000088',
      }));
      expect(cutover.payloadFingerprint).toMatch(/^cutover-md5:/);
      expect(cutover.nextAttemptAt.getUTCFullYear()).not.toBe(9999);

      const rollbackUnattemptedId = '00000000-0000-4000-8000-000000000077';
      const rollbackAttemptedId = '00000000-0000-4000-8000-000000000066';
      execFileSync('psql', [upgradeUrl.toString(), '-X', '-v', 'ON_ERROR_STOP=1', '-c', `
        INSERT INTO notification_jobs
          (id, "companyId", kind, "dedupeKey", channel, recipient, subject, payload,
           "payloadFingerprint", status, attempts, "nextAttemptAt", "providerAttemptedAt", "createdAt", "updatedAt")
        VALUES
          ('${rollbackUnattemptedId}', 'legacy-co', 'invoice-relance', 'rollback:unattempted',
           'email', 'unattempted@example.test', 'Unattempted',
           '{"channel":"email","to":"unattempted@example.test","subject":"Unattempted","body":"Jamais soumis","idempotencyKey":"${rollbackUnattemptedId}"}'::jsonb,
           'cert:rollback-unattempted', 'pending', 0, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('${rollbackAttemptedId}', 'legacy-co', 'invoice-relance', 'rollback:attempted',
           'email', 'attempted@example.test', 'Attempted',
           '{"channel":"email","to":"attempted@example.test","subject":"Attempted","body":"Issue ambiguë","idempotencyKey":"${rollbackAttemptedId}"}'::jsonb,
           'cert:rollback-attempted', 'failed', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      `], { stdio: 'pipe' });

      execFileSync('sh', [resolve(process.cwd(), 'scripts/deactivate-notification-outbox-v2.sh')], {
        env: { ...process.env, DIRECT_URL: upgradeUrl.toString() },
        stdio: 'pipe',
      });

      // Simulation exacte d'un writer N-1 : ni clé provider, ni fingerprint v2. Le trigger
      // de rollback complète l'intention puis la spool avant que la CHECK active ne s'applique.
      const rollbackNMinusOneId = '00000000-0000-4000-8000-000000000055';
      execFileSync('psql', [upgradeUrl.toString(), '-X', '-v', 'ON_ERROR_STOP=1', '-c', `
        INSERT INTO notification_jobs
          (id, "companyId", kind, "dedupeKey", channel, recipient, subject, payload,
           status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
        VALUES
          ('${rollbackNMinusOneId}', 'legacy-co', 'invoice-relance', 'rollback:n-minus-one',
           'email', 'n-minus-one@example.test', 'N-1',
           '{"channel":"email","to":"n-minus-one@example.test","subject":"N-1","body":"Créé pendant rollback"}'::jsonb,
           'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      `], { stdio: 'pipe' });

      const [spooled, uncertain, nMinusOneSpooled] = await Promise.all([
        upgrade.notificationJob.findUniqueOrThrow({ where: { id: rollbackUnattemptedId } }),
        upgrade.notificationJob.findUniqueOrThrow({ where: { id: rollbackAttemptedId } }),
        upgrade.notificationJob.findUniqueOrThrow({ where: { id: rollbackNMinusOneId } }),
      ]);
      expect(spooled.lastError).toContain('cutover-spooled:v2');
      expect(spooled.nextAttemptAt.getUTCFullYear()).toBe(9999);
      expect(uncertain.lastError).toContain('manual-review:rollback-provider-outcome-uncertain');
      expect(uncertain.nextAttemptAt.getUTCFullYear()).toBe(9999);
      expect(nMinusOneSpooled.lastError).toContain('cutover-spooled:v2');
      expect(nMinusOneSpooled.payload).toEqual(expect.objectContaining({
        idempotencyKey: rollbackNMinusOneId,
      }));
      expect(nMinusOneSpooled.payloadFingerprint).toMatch(/^cutover-md5:/);

      execFileSync('sh', [resolve(process.cwd(), 'scripts/activate-notification-outbox-v2.sh')], {
        env: { ...process.env, DIRECT_URL: upgradeUrl.toString() },
        stdio: 'pipe',
      });
      const [resumed, stillQuarantined, nMinusOneResumed] = await Promise.all([
        upgrade.notificationJob.findUniqueOrThrow({ where: { id: rollbackUnattemptedId } }),
        upgrade.notificationJob.findUniqueOrThrow({ where: { id: rollbackAttemptedId } }),
        upgrade.notificationJob.findUniqueOrThrow({ where: { id: rollbackNMinusOneId } }),
      ]);
      expect(resumed).toMatchObject({ status: 'pending', lastError: null });
      expect(resumed.nextAttemptAt.getUTCFullYear()).not.toBe(9999);
      expect(stillQuarantined.lastError).toContain('manual-review:rollback-provider-outcome-uncertain');
      expect(stillQuarantined.nextAttemptAt.getUTCFullYear()).toBe(9999);
      expect(nMinusOneResumed).toMatchObject({ status: 'pending', lastError: null });
      expect(nMinusOneResumed.nextAttemptAt.getUTCFullYear()).not.toBe(9999);

      // Un état mixte ne doit surtout pas être « réparé » silencieusement. On retire un index et
      // réintroduit seulement la colonne expand : l'opérateur refuse avant toute DDL, donc l'index
      // reste absent et la colonne reste présente pour un diagnostic explicite.
      execFileSync('psql', [
        upgradeUrl.toString(),
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'DROP INDEX "notification_jobs_recent_idx"; ALTER TABLE "notification_jobs" ADD COLUMN "cutoverResumeAt" TIMESTAMP(3);',
      ], { stdio: 'pipe' });
      expect(() => execFileSync(
        'sh',
        [resolve(process.cwd(), 'scripts/activate-notification-outbox-v2.sh')],
        {
          env: { ...process.env, DIRECT_URL: upgradeUrl.toString() },
          stdio: 'pipe',
        },
      )).toThrow();
      const rejectedMixedShape = execFileSync('psql', [
        upgradeUrl.toString(),
        '-X',
        '-qAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `SELECT format(
          '%s|%s',
          (SELECT count(*) FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'notification_jobs'
              AND column_name = 'cutoverResumeAt'),
          (SELECT count(*) FROM pg_class
            WHERE relkind = 'i' AND relname = 'notification_jobs_recent_idx')
        );`,
      ], { encoding: 'utf8' }).trim();
      expect(rejectedMixedShape).toBe('1|0');
    } finally {
      await upgrade?.$disconnect();
      await admin.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid()`,
      ).catch(() => undefined);
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
    }
  }, 30_000);

  it('bloque une révision N-1 sans version de protocole, même avec le bon tenant', async () => {
    const legacyCount = await workers[0]!.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      return tx.notificationJob.count({ where: { companyId } });
    });
    expect(legacyCount).toBe(0);

    const id = randomUUID();
    await expect(
      workers[0]!.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        await tx.notificationJob.create({
          data: {
            id,
            companyId,
            kind: 'invoice-relance',
            dedupeKey: `legacy:${id}`,
            channel: 'email',
            recipient: 'legacy@example.test',
            subject: 'Legacy forbidden',
            payload: {
              channel: 'email',
              to: 'legacy@example.test',
              subject: 'Legacy forbidden',
              body: 'Legacy forbidden',
              idempotencyKey: id,
            },
            nextAttemptAt: new Date(),
          },
        });
      }),
    ).rejects.toThrow();
  });

  it('huit transactions concurrentes relisent un gagnant unique sans empoisonnement P2002', async () => {
    const dedupeKey = `postgres-concurrency:${randomUUID()}`;
    const ids = Array.from({ length: WORKER_COUNT }, () => randomUUID());
    const gate = deferred();
    let ready = 0;

    const outcomes = await Promise.all(workers.map((worker, index) =>
      worker.withTenant(companyId, async (tx) => {
        ready += 1;
        if (ready === WORKER_COUNT) gate.resolve();
        await gate.promise;
        const id = ids[index]!;
        const inserted = await tx.notificationJob.createMany({
          data: [{
            id,
            companyId,
            kind: 'invoice-relance',
            dedupeKey,
            channel: 'email',
            recipient: 'concurrency@example.test',
            subject: `Concurrent ${index}`,
            payload: {
              channel: 'email',
              to: 'concurrency@example.test',
              subject: `Concurrent ${index}`,
              body: 'Certification PostgreSQL',
              idempotencyKey: id,
            },
            payloadFingerprint: `cert-concurrent-${index}`,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: new Date(),
          }],
          skipDuplicates: true,
        });
        // Cette lecture a lieu dans LA MÊME transaction que le conflit. Si createMany avait
        // déclenché P2002, PostgreSQL refuserait ce statement avec transaction aborted.
        const winner = await tx.notificationJob.findUnique({
          where: {
            uniq_notification_job: { companyId, kind: 'invoice-relance', dedupeKey },
          },
        });
        return { inserted: inserted.count, winnerId: winner?.id ?? null };
      }),
    ));

    expect(outcomes.reduce((sum, outcome) => sum + outcome.inserted, 0)).toBe(1);
    expect(new Set(outcomes.map((outcome) => outcome.winnerId)).size).toBe(1);
    expect(outcomes[0]!.winnerId).not.toBeNull();

    const hidden = await workers[0]!.withTenant(`${companyId}-other`, (tx) =>
      tx.notificationJob.count({ where: { dedupeKey } }),
    );
    expect(hidden).toBe(0);
  }, 30_000);

  it('l’adapter garde le payload immuable et utilise l’horloge DB pour le lease/fence', async () => {
    const repository = new PrismaNotificationJobRepository(workers[0]!);
    const id = randomUUID();
    const dedupeKey = `adapter:${randomUUID()}`;
    const enqueued = await workers[0]!.withTenant(companyId, () => repository.enqueue({
      id,
      companyId,
      kind: 'invoice-relance',
      dedupeKey,
      notification: {
        channel: 'email',
        to: 'adapter@example.test',
        subject: 'Payload A',
        body: 'Corps A',
        idempotencyKey: id,
      },
      now: new Date(Date.now() - 1_000).toISOString(),
    }));
    const conflictingId = randomUUID();
    await expect(workers[0]!.withTenant(companyId, () => repository.enqueue({
      id: conflictingId,
      companyId,
      kind: 'invoice-relance',
      dedupeKey,
      notification: {
        channel: 'email',
        to: 'adapter@example.test',
        subject: 'Payload B interdit',
        body: 'Corps B interdit',
        idempotencyKey: conflictingId,
      },
      now: new Date().toISOString(),
    }))).rejects.toBeInstanceOf(NotificationDedupeConflictError);

    const leaseToken = randomUUID();
    const claimed = await workers[0]!.withTenant(companyId, () => repository.claimForDelivery(
      id,
      companyId,
      enqueued.updatedAt,
      '2099-01-01T00:00:00.000Z',
      '2099-01-01T00:05:00.000Z',
      leaseToken,
    ));
    expect(claimed).toMatchObject({ outcome: 'claimed', job: { id, leaseToken } });
    if (claimed.outcome !== 'claimed') throw new Error('claim PostgreSQL attendu');
    expect(Date.parse(claimed.job.nextAttemptAt)).toBeLessThan(Date.parse('2090-01-01T00:00:00.000Z'));
    await expect(workers[0]!.withTenant(companyId, () =>
      repository.authorizeDeliveryAttempt(id, companyId, leaseToken, '1900-01-01T00:00:00.000Z'),
    )).resolves.toBe(true);

    await expect(workers[0]!.withTenant(companyId, () =>
      repository.markDone(id, companyId, randomUUID(), new Date().toISOString()),
    )).resolves.toBe(false);
    await expect(workers[0]!.withTenant(companyId, () =>
      repository.markDone(id, companyId, leaseToken, new Date().toISOString()),
    )).resolves.toBe(true);
  });

  it('snapshot non-lu et lecture batch restent atomiques sous horloge DB et concurrence réelle', async () => {
    const readCompanyId = `read-cert-${randomUUID()}`;
    const readSiren = String(randomInt(100_000_000, 999_999_999));
    const readSiret = `${readSiren}00001`;
    const repository = new PrismaNotificationJobRepository(workers[0]!);
    await admin.company.create({
      data: {
        id: readCompanyId,
        name: 'Bob Notification Read Certification',
        legalForm: 'EI',
        siren: readSiren,
        siret: readSiret,
        trade: 'certification',
        vatRegime: 'reel_normal',
        addrLine1: '2 rue de la Certification',
        addrZip: '75001',
        addrCity: 'Paris',
      },
    });
    try {
      const oldCreatedAt = new Date(Date.now() - 10_000);
      const ids = Array.from({ length: 75 }, () => randomUUID());
      await admin.notificationJob.createMany({
        data: ids.map((id, index) => ({
          id,
          companyId: readCompanyId,
          kind: 'invoice-relance' as const,
          dedupeKey: `read-batch:${index}:${id}`,
          channel: 'email' as const,
          recipient: 'read-cert@example.test',
          subject: `Lecture ${index}`,
          payload: {
            channel: 'email',
            to: 'read-cert@example.test',
            subject: `Lecture ${index}`,
            body: 'Certification lecture batch',
            idempotencyKey: id,
          },
          payloadFingerprint: `cert-read-${index}`,
          status: 'pending' as const,
          attempts: 0,
          nextAttemptAt: new Date('9999-12-31T23:59:59.999Z'),
          createdAt: oldCreatedAt,
        })),
      });

      const preview = await workers[0]!.withTenant(readCompanyId, () =>
        repository.previewUnread(readCompanyId, '2099-01-01T00:00:00.000Z'),
      );
      expect(preview.unreadCount).toBe(75);

      const atCutoffId = randomUUID();
      const afterCutoffId = randomUUID();
      await admin.notificationJob.createMany({
        data: [
          {
            id: atCutoffId,
            companyId: readCompanyId,
            kind: 'invoice-relance',
            dedupeKey: `read-at-cutoff:${atCutoffId}`,
            channel: 'email',
            recipient: 'read-cert@example.test',
            subject: 'Même milliseconde',
            payload: {
              channel: 'email',
              to: 'read-cert@example.test',
              subject: 'Même milliseconde',
              body: 'Hors snapshot',
              idempotencyKey: atCutoffId,
            },
            payloadFingerprint: 'cert-read-at-cutoff',
            status: 'pending',
            attempts: 0,
            nextAttemptAt: new Date('9999-12-31T23:59:59.999Z'),
            createdAt: new Date(preview.throughCreatedAt),
          },
          {
            id: afterCutoffId,
            companyId: readCompanyId,
            kind: 'invoice-relance',
            dedupeKey: `read-after-cutoff:${afterCutoffId}`,
            channel: 'email',
            recipient: 'read-cert@example.test',
            subject: 'Après cutoff',
            payload: {
              channel: 'email',
              to: 'read-cert@example.test',
              subject: 'Après cutoff',
              body: 'Hors snapshot',
              idempotencyKey: afterCutoffId,
            },
            payloadFingerprint: 'cert-read-after-cutoff',
            status: 'pending',
            attempts: 0,
            nextAttemptAt: new Date('9999-12-31T23:59:59.999Z'),
            createdAt: new Date(Date.parse(preview.throughCreatedAt) + 1),
          },
        ],
      });

      const batch = await workers[0]!.withTenant(readCompanyId, () =>
        repository.markReadThrough(readCompanyId, preview.throughCreatedAt, '1900-01-01T00:00:00.000Z'),
      );
      expect(batch).toMatchObject({ updatedCount: 75, cutoffAccepted: true });
      const replay = await workers[0]!.withTenant(readCompanyId, () =>
        repository.markReadThrough(readCompanyId, preview.throughCreatedAt, '2099-01-01T00:00:00.000Z'),
      );
      expect(replay).toMatchObject({ updatedCount: 0, cutoffAccepted: true });
      const [atCutoff, afterCutoff] = await Promise.all([
        admin.notificationJob.findUniqueOrThrow({ where: { id: atCutoffId } }),
        admin.notificationJob.findUniqueOrThrow({ where: { id: afterCutoffId } }),
      ]);
      expect(atCutoff.readAt).toBeNull();
      expect(afterCutoff.readAt).toBeNull();

      const concurrentId = randomUUID();
      await admin.notificationJob.create({
        data: {
          id: concurrentId,
          companyId: readCompanyId,
          kind: 'invoice-relance',
          dedupeKey: `read-concurrent:${concurrentId}`,
          channel: 'email',
          recipient: 'read-cert@example.test',
          subject: 'Lecture concurrente',
          payload: {
            channel: 'email',
            to: 'read-cert@example.test',
            subject: 'Lecture concurrente',
            body: 'Certification concurrence',
            idempotencyKey: concurrentId,
          },
          payloadFingerprint: 'cert-read-concurrent',
          status: 'pending',
          attempts: 0,
          nextAttemptAt: new Date('9999-12-31T23:59:59.999Z'),
          createdAt: oldCreatedAt,
        },
      });
      const candidateReadAt = workers.map((_, index) =>
        new Date(Date.parse('2026-07-13T03:00:00.000Z') + index).toISOString(),
      );
      const outcomes = await Promise.all(workers.map((worker, index) =>
        worker.withTenant(readCompanyId, () =>
          new PrismaNotificationJobRepository(worker).markRead(
            concurrentId,
            readCompanyId,
            candidateReadAt[index]!,
          ),
        ),
      ));
      const observed = outcomes.map((outcome) => outcome?.readAt ?? null);
      expect(new Set(observed).size).toBe(1);
      expect(candidateReadAt).toContain(observed[0]);
      const stored = await admin.notificationJob.findUniqueOrThrow({ where: { id: concurrentId } });
      expect(stored.readAt?.toISOString()).toBe(observed[0]);
    } finally {
      await admin.notificationJob.deleteMany({ where: { companyId: readCompanyId } }).catch(() => undefined);
      await admin.company.deleteMany({ where: { id: readCompanyId } }).catch(() => undefined);
    }
  }, 30_000);

  it('quarantaine atomiquement avec l’horloge DB une fenêtre provider expirée', async () => {
    const repository = new PrismaNotificationJobRepository(workers[0]!);
    const id = randomUUID();
    const leaseToken = randomUUID();
    await admin.notificationJob.create({
      data: {
        id,
        companyId,
        kind: 'invoice-relance',
        dedupeKey: `uncertain:${id}`,
        channel: 'email',
        recipient: 'uncertain@example.test',
        subject: 'Résultat incertain',
        payload: {
          channel: 'email',
          to: 'uncertain@example.test',
          subject: 'Résultat incertain',
          body: 'Résultat incertain',
          idempotencyKey: id,
        },
        payloadFingerprint: notificationPayloadFingerprint({
          channel: 'email',
          to: 'uncertain@example.test',
          subject: 'Résultat incertain',
          body: 'Résultat incertain',
          idempotencyKey: id,
        }),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1_000),
        leaseToken: null,
        providerAttemptedAt: new Date(Date.now() - 26 * 60_000),
      },
    });
    const uncertain = await admin.notificationJob.findUniqueOrThrow({ where: { id } });

    await expect(workers[0]!.withTenant(companyId, () =>
      repository.claimForDelivery(
        id,
        companyId,
        uncertain.updatedAt.toISOString(),
        '1900-01-01T00:00:00.000Z',
        '1900-01-01T00:05:00.000Z',
        leaseToken,
      ),
    )).resolves.toEqual({ outcome: 'quarantined', reason: 'provider-window-expired' });
    const quarantined = await admin.notificationJob.findUniqueOrThrow({ where: { id } });
    expect(quarantined).toMatchObject({ status: 'failed', leaseToken: null });
    expect(quarantined.lastError).toContain('manual-review:provider-outcome-uncertain');
    expect(quarantined.nextAttemptAt.getUTCFullYear()).toBe(9999);
  });
});
