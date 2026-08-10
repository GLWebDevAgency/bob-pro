import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  CloseAccount,
  Company,
  DEFAULT_DOCUMENT_FOLDERS,
  type AppError,
  type CompanyRegistrationInput,
  type DocumentFolderRepository,
  type OcrPort,
  type PaymentGatewayPort,
  type PdfRendererPort,
  type Result,
} from '@bob/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendService } from '../../backend.service';
import type { SupabaseAdminPort } from '../../auth/supabase-admin';
import type { NotificationDeliveryService } from '../../jobs/notification-delivery.service';
import { requestContext, type AppLogger, type Principal } from '../../observability/logger';
import type { Metrics } from '../../observability/metrics';
import type { Persistence, ServerCompanyRepository } from '../persistence';
import { PrismaPersistence } from './prisma-persistence';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_COMPANY_MUTATION_LIFECYCLE_CERT === 'true';
const CERT_NOW = '2026-07-18T08:00:00.000Z';
const CLOSE_NOW = '2026-07-18T08:00:01.000Z';
const CLOSE_REASON = 'certification concurrence mutations company';
const SIREN = randomValidSiren();
const UPDATED_IBAN = 'FR7630006000011234567890189';
const UPDATED_BIC = 'AGRIFRPP';

interface Fixture {
  readonly companyId: string;
  readonly userId: string;
  readonly companyName: string;
  readonly siren: string;
  readonly siret: string;
  readonly subscriptionId: string;
}

interface Gate<T> {
  readonly acquired: ReturnType<typeof deferred<T>>;
  readonly release: ReturnType<typeof deferred<void>>;
}

interface BlockingObservation {
  readonly blockerPids: number[];
  readonly query: string;
  readonly state: string;
  readonly waitEvent: string | null;
  readonly waitEventType: string | null;
}

type WriterKind = 'profile' | 'billing' | 'settings';

const WRITERS: readonly { kind: WriterKind; label: string }[] = [
  { kind: 'profile', label: 'profil' },
  { kind: 'billing', label: 'RIB' },
  { kind: 'settings', label: 'réglages de facturation' },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function asPrincipal<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
  return requestContext.run(
    { correlationId: `company-lifecycle-cert-${randomUUID()}`, principal },
    fn,
  );
}

async function backendPid(worker: PrismaService): Promise<number> {
  if (!worker.inTransaction()) {
    throw new Error('PostgreSQL backend PID must be read inside the certified transaction.');
  }
  const rows = await worker.client().$queryRaw<Array<{ pid: number }>>`
    SELECT pg_backend_pid() AS pid
  `;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('PostgreSQL backend PID unavailable.');
  return pid;
}

function normalizedSql(query: string): string {
  return query.replaceAll('"', '').replace(/\s+/g, ' ').trim().toUpperCase();
}

function targetsCompanyTable(query: string, keyword: 'FROM' | 'INTO'): boolean {
  const sql = normalizedSql(query);
  return new RegExp(`\\b${keyword}\\s+(?:[A-Z0-9_$]+\\.)?COMPANIES\\b`, 'u').test(sql);
}

function isCompanyForUpdate(query: string): boolean {
  const sql = normalizedSql(query);
  return targetsCompanyTable(sql, 'FROM') && sql.includes('FOR UPDATE');
}

function isCompanyProvisioningQuery(query: string): boolean {
  const sql = normalizedSql(query);
  return (
    (targetsCompanyTable(sql, 'INTO') && sql.includes('INSERT') && sql.includes('ON CONFLICT')) ||
    (targetsCompanyTable(sql, 'FROM') && sql.includes('FOR UPDATE'))
  );
}

async function waitUntilBlockedBy(input: {
  admin: PrismaClient;
  blockedPid: number;
  blockerPid: number;
  context: string;
  expectedQuery: (query: string) => boolean;
}): Promise<BlockingObservation> {
  const deadline = Date.now() + 5_000;
  let lastObservation: BlockingObservation | null = null;
  while (Date.now() < deadline) {
    const rows = await input.admin.$queryRaw<BlockingObservation[]>`
      SELECT
        pg_blocking_pids(CAST(${input.blockedPid} AS integer)) AS "blockerPids",
        query,
        state,
        wait_event AS "waitEvent",
        wait_event_type AS "waitEventType"
      FROM pg_stat_activity
      WHERE pid = ${input.blockedPid}
    `;
    lastObservation = rows[0] ?? null;
    const exactBlocker =
      lastObservation?.blockerPids.length === 1 &&
      lastObservation.blockerPids[0] === input.blockerPid;
    if (
      exactBlocker &&
      lastObservation?.state === 'active' &&
      lastObservation.waitEventType === 'Lock' &&
      input.expectedQuery(lastObservation.query)
    ) {
      return lastObservation;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `${input.context}: backend ${input.blockedPid} was not blocked exclusively by ` +
      `${input.blockerPid} on the expected company query; ` +
      `last observation=${JSON.stringify(lastObservation)}`,
  );
}

async function waitForGateOrFailure<T>(
  gate: Promise<T>,
  operation: Promise<unknown>,
  label: string,
): Promise<T> {
  let gateReached = false;
  const operationBeforeGate = operation.then(
    (value) => {
      if (!gateReached) {
        throw new Error(
          `${label} completed before acquiring the expected lock: ${JSON.stringify(value)}`,
        );
      }
      return new Promise<never>(() => undefined);
    },
    (error: unknown) => {
      if (!gateReached) throw error;
      return new Promise<never>(() => undefined);
    },
  );
  return Promise.race([
    gate.then((value) => {
      gateReached = true;
      return value;
    }),
    operationBeforeGate,
  ]);
}

function gateCompanyLock(input: {
  repository: ServerCompanyRepository;
  worker: PrismaService;
  companyId: string;
  gate: Gate<number>;
}): ServerCompanyRepository {
  let armed = true;
  return {
    findById: (id) => input.repository.findById(id),
    lockById: async (id) => {
      const company = await input.repository.lockById(id);
      if (armed && id === input.companyId) {
        armed = false;
        if (!input.worker.inTransaction()) {
          throw new Error('Lifecycle row lock acquired outside an active transaction.');
        }
        input.gate.acquired.resolve(await backendPid(input.worker));
        await input.gate.release.promise;
      }
      return company;
    },
    lockForShareById: (id) => input.repository.lockForShareById(id),
    list: () => input.repository.list(),
    createIfAbsentOpen: (company) => input.repository.createIfAbsentOpen(company),
    save: (company) => input.repository.save(company),
  };
}

function persistenceWith(base: PrismaPersistence, overrides: Partial<Persistence>): Persistence {
  return new Proxy(base as Persistence, {
    get(target, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return Reflect.get(overrides, property);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function persistenceObservingFirstTenantStart(input: {
  base: PrismaPersistence;
  worker: PrismaService;
  started: ReturnType<typeof deferred<number>>;
}): Persistence {
  let armed = true;
  const runWithTenant: Persistence['runWithTenant'] = <T>(
    companyId: string,
    fn: () => Promise<T>,
  ) =>
    input.base.runWithTenant(companyId, async () => {
      if (armed) {
        armed = false;
        input.started.resolve(await backendPid(input.worker));
      }
      return fn();
    });
  return persistenceWith(input.base, { runWithTenant });
}

function failSecondFolderSave(input: {
  repository: DocumentFolderRepository;
  attempts: { value: number };
}): DocumentFolderRepository {
  return new Proxy(input.repository, {
    get(target, property, receiver) {
      if (property === 'save') {
        return async (...args: Parameters<DocumentFolderRepository['save']>) => {
          input.attempts.value += 1;
          if (input.attempts.value === 2) return { status: 'name_conflict' as const };
          return target.save(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function makeBackend(persistence: Persistence): {
  readonly service: BackendService;
  readonly effects: { metadataWrites: number; authDeletes: number; audits: number };
} {
  const effects = { metadataWrites: 0, authDeletes: 0, audits: 0 };
  const supabaseAdmin: SupabaseAdminPort = {
    setUserCompanyId: async () => {
      effects.metadataWrites += 1;
    },
    deleteUser: async () => {
      effects.authDeletes += 1;
    },
  };
  const logger = {
    audit: () => {
      effects.audits += 1;
    },
    error: () => undefined,
    warn: () => undefined,
    log: () => undefined,
  } as unknown as AppLogger;
  return {
    service: new BackendService(
      persistence,
      { subscriptionBillingAvailable: false } as PaymentGatewayPort,
      {} as PdfRendererPort,
      {} as OcrPort,
      supabaseAdmin,
      {} as NotificationDeliveryService,
      {} as Metrics,
      logger,
    ),
    effects,
  };
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
  const eightDigits = 10_000_000 + (entropy % 90_000_000);
  return withLuhnCheckDigit(String(eightDigits));
}

function validSiret(siren: string, establishmentSequence: number): string {
  const nic = String(establishmentSequence % 10_000).padStart(4, '0');
  return withLuhnCheckDigit(`${siren}${nic}`);
}

function registrationInput(fixture: Fixture, name: string): CompanyRegistrationInput {
  return {
    name,
    legalForm: 'EI',
    siren: fixture.siren,
    siret: fixture.siret,
    trade: 'electricien',
    vatRegime: 'franchise',
    address: {
      line1: '9 rue du Retry',
      zip: '75009',
      city: 'Paris',
    },
  };
}

async function runTenantAction<T>(input: {
  worker: PrismaService;
  companyId: string;
  action: () => Promise<T>;
  onStart?: (pid: number) => void;
}): Promise<T> {
  return input.worker.withTenant(input.companyId, async () => {
    if (input.onStart) input.onStart(await backendPid(input.worker));
    return asPrincipal(
      { userId: `owner-${input.companyId}`, companyId: input.companyId },
      input.action,
    );
  });
}

function invokeWriter(
  kind: WriterKind,
  service: BackendService,
): Promise<Result<unknown, AppError>> {
  switch (kind) {
    case 'profile':
      return service.updateCompanyProfile({
        trade: 'plombier',
        vatRegime: 'franchise',
        customerPortfolio: 'mixte',
      });
    case 'billing':
      return service.updateCompanyBilling({ iban: UPDATED_IBAN, bic: UPDATED_BIC });
    case 'settings':
      return service.updateCompanyBillingSettings({
        expectedRevision: 1,
        patch: { defaultDepositPercent: 42 },
      });
  }
}

async function runCloseAccount(input: {
  worker: PrismaService;
  persistence: PrismaPersistence;
  fixture: Fixture;
  companies?: ServerCompanyRepository;
  onStart?: (pid: number) => void;
}) {
  return input.worker.withTenant(input.fixture.companyId, async () => {
    if (input.onStart) input.onStart(await backendPid(input.worker));
    return new CloseAccount({
      companies: input.companies ?? input.persistence.companies,
      subscriptions: input.persistence.subscriptions,
      publicAccessTokens: input.persistence.publicAccessTokens,
      identityDeletionOutbox: {
        ensureRequested: async ({ requestId }) => ({
          outcome: 'accepted' as const,
          request: { requestId, status: 'pending' as const, alreadyRequested: false },
        }),
      },
      uow: input.persistence,
    }).execute({
      companyId: input.fixture.companyId,
      userId: input.fixture.userId,
      identityDeletionRequestId: randomUUID(),
      confirmationText: input.fixture.companyName,
      reason: CLOSE_REASON,
      now: CLOSE_NOW,
    });
  });
}

type CompanySqlFenceMutation =
  | 'closure_reason_without_close'
  | 'close_and_rename'
  | 'reopen'
  | 'rename_after_close'
  | 'delete_closed';

/** Exécute la mutation directe puis certifie SQLSTATE et contrainte exacts. */
async function certifyCompanySqlFence(
  admin: PrismaClient,
  companyId: string,
  mutation: CompanySqlFenceMutation,
): Promise<void> {
  const definition: { readonly statement: string; readonly constraint: string } = (() => {
    switch (mutation) {
      case 'closure_reason_without_close':
        return {
          statement:
            'UPDATE "companies" SET "closureReason" = \'motif forgé\' WHERE id = current_setting(\'bob.cert_company_id\')',
          constraint: 'companies_closure_reason_requires_closed_at',
        };
      case 'close_and_rename':
        return {
          statement:
            "UPDATE \"companies\" SET \"closedAt\" = current_setting('bob.cert_close_now')::timestamptz, name = name || ' forgé' WHERE id = current_setting('bob.cert_company_id')",
          constraint: 'companies_close_identity_immutable',
        };
      case 'reopen':
        return {
          statement:
            'UPDATE "companies" SET "closedAt" = NULL WHERE id = current_setting(\'bob.cert_company_id\')',
          constraint: 'companies_closed_immutable',
        };
      case 'rename_after_close':
        return {
          statement:
            "UPDATE \"companies\" SET name = name || ' forgé' WHERE id = current_setting('bob.cert_company_id')",
          constraint: 'companies_closed_immutable',
        };
      case 'delete_closed':
        return {
          statement: 'DELETE FROM "companies" WHERE id = current_setting(\'bob.cert_company_id\')',
          constraint: 'companies_closed_delete_forbidden',
        };
    }
  })();
  await admin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('bob.cert_company_id', ${companyId}, true)`;
    await tx.$executeRaw`SELECT set_config('bob.cert_close_now', ${CLOSE_NOW}, true)`;
    await tx.$executeRawUnsafe(`
      DO $company_lifecycle_cert$
      DECLARE
        caught_state text;
        caught_constraint text;
      BEGIN
        BEGIN
          ${definition.statement};
          RAISE EXCEPTION 'CERT_EXPECTED_COMPANY_FENCE_${mutation}';
        EXCEPTION
          WHEN check_violation THEN
            GET STACKED DIAGNOSTICS
              caught_state = RETURNED_SQLSTATE,
              caught_constraint = CONSTRAINT_NAME;
            IF caught_state <> '23514'
               OR caught_constraint <> '${definition.constraint}' THEN
              RAISE EXCEPTION
                'CERT_WRONG_COMPANY_CLOSURE_DIAGNOSTIC state=% constraint=%',
                caught_state,
                caught_constraint;
            END IF;
        END;
      END
      $company_lifecycle_cert$;
    `);
  });
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Company — certification PostgreSQL/RLS anti-résurrection et sérialisation des mutations',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const companyIds: string[] = [];
    let fixtureSequence =
      10_000 + (parseInt(randomUUID().replaceAll('-', '').slice(0, 8), 16) % 80_000);
    let admin!: PrismaClient;
    let firstWorker!: PrismaService;
    let secondWorker!: PrismaService;
    let firstPersistence!: PrismaPersistence;
    let secondPersistence!: PrismaPersistence;
    let sentinel!: Fixture;

    async function seedFixture(
      label: string,
      explicitCompanyId?: string,
      withDependencies = true,
    ): Promise<Fixture> {
      const suffix = randomUUID();
      const companyId = explicitCompanyId ?? `company-company-mutation-${suffix}`;
      const fixture: Fixture = {
        companyId,
        userId: companyId.slice('company-'.length),
        companyName: `Certification Company ${label} ${suffix.slice(0, 8)}`,
        siren: SIREN,
        siret: validSiret(SIREN, fixtureSequence),
        subscriptionId: `company-mutation-subscription-${suffix}`,
      };
      fixtureSequence += 1;
      await admin.$transaction(async (tx) => {
        await tx.company.create({
          data: {
            id: fixture.companyId,
            name: fixture.companyName,
            legalForm: 'EI',
            siren: fixture.siren,
            siret: fixture.siret,
            trade: 'autre',
            vatRegime: 'reel_normal',
            addrLine1: '1 rue de la Certification',
            addrZip: '75001',
            addrCity: 'Paris',
          },
        });
        if (withDependencies) {
          await tx.companyBillingSettings.create({ data: { companyId: fixture.companyId } });
          await tx.subscription.create({
            data: {
              id: fixture.subscriptionId,
              companyId: fixture.companyId,
              plan: 'business',
              status: 'active',
              store: 'none',
              createdAt: new Date(CERT_NOW),
              updatedAt: new Date(CERT_NOW),
            },
          });
        }
      });
      companyIds.push(fixture.companyId);
      return fixture;
    }

    async function assertClosed(fixture: Fixture): Promise<void> {
      const [company, subscription] = await Promise.all([
        admin.company.findUniqueOrThrow({ where: { id: fixture.companyId } }),
        admin.subscription.findUniqueOrThrow({ where: { companyId: fixture.companyId } }),
      ]);
      expect(company.closedAt?.toISOString()).toBe(CLOSE_NOW);
      expect(company.closureReason).toBe(CLOSE_REASON);
      expect(subscription.status).toBe('canceled');
    }

    async function assertWriterState(
      fixture: Fixture,
      kind: WriterKind,
      expected: 'won' | 'rejected',
    ): Promise<void> {
      const [company, settings] = await Promise.all([
        admin.company.findUniqueOrThrow({ where: { id: fixture.companyId } }),
        admin.companyBillingSettings.findUniqueOrThrow({
          where: { companyId: fixture.companyId },
        }),
      ]);
      if (kind === 'profile') {
        expect(company).toMatchObject(
          expected === 'won'
            ? { trade: 'plombier', vatRegime: 'franchise', customerPortfolio: 'mixte' }
            : { trade: 'autre', vatRegime: 'reel_normal', customerPortfolio: null },
        );
      } else if (kind === 'billing') {
        expect(company).toMatchObject(
          expected === 'won' ? { iban: UPDATED_IBAN, bic: UPDATED_BIC } : { iban: null, bic: null },
        );
      } else {
        expect(settings).toMatchObject(
          expected === 'won'
            ? { revision: 2, defaultDepositPercent: 42 }
            : { revision: 1, defaultDepositPercent: 30 },
        );
      }
    }

    async function assertSentinelUntouched(): Promise<void> {
      const [company, settings, subscription, folders] = await Promise.all([
        admin.company.findUniqueOrThrow({ where: { id: sentinel.companyId } }),
        admin.companyBillingSettings.findUniqueOrThrow({
          where: { companyId: sentinel.companyId },
        }),
        admin.subscription.findUniqueOrThrow({ where: { companyId: sentinel.companyId } }),
        admin.documentFolder.count({ where: { companyId: sentinel.companyId } }),
      ]);
      expect(company).toMatchObject({
        name: sentinel.companyName,
        closedAt: null,
        closureReason: null,
        trade: 'autre',
        iban: null,
      });
      expect(settings).toMatchObject({ revision: 1, defaultDepositPercent: 30 });
      expect(subscription.status).toBe('active');
      expect(folders).toBe(0);
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      firstWorker = new PrismaService({ datasourceUrl: runtimeUrl });
      secondWorker = new PrismaService({ datasourceUrl: runtimeUrl });
      firstPersistence = new PrismaPersistence(firstWorker);
      secondPersistence = new PrismaPersistence(secondWorker);
      await Promise.all([admin.$connect(), firstWorker.$connect(), secondWorker.$connect()]);
      sentinel = await seedFixture('sentinel-second-tenant');
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin && companyIds.length > 0) {
          const where = { companyId: { in: companyIds } };
          await admin.$transaction(async (tx) => {
            await tx.authUserDeletionJob.deleteMany({ where });
            // Réouverture technique locale des seules fixtures : neutralise le trigger de cycle
            // de vie, puis réactive immédiatement tous les triggers/FK AVANT les DELETE. Ainsi,
            // une future dépendance oubliée fait échouer le cleanup au lieu de devenir orpheline.
            await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
            await tx.company.updateMany({
              where: { id: { in: companyIds } },
              data: { closedAt: null, closureReason: null },
            });
            await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
            await tx.documentFolderDeletionPlan.deleteMany({ where });
            await tx.documentFolder.deleteMany({ where });
            await tx.publicAccessToken.deleteMany({ where });
            await tx.subscription.deleteMany({ where });
            await tx.companyBillingSettings.deleteMany({ where });
            await tx.company.deleteMany({ where: { id: { in: companyIds } } });
          });
        }
      } finally {
        await Promise.allSettled([
          firstWorker?.$disconnect(),
          secondWorker?.$disconnect(),
          admin?.$disconnect(),
        ]);
      }
    });

    it('exécute sous un rôle runtime sans superuser/bypass RLS, avec FORCE RLS et le trigger de clôture', async () => {
      const roleRows = await firstWorker.$queryRaw<
        Array<{
          roleName: string;
          superuser: boolean;
          bypassRls: boolean;
          canDeleteCompanies: boolean;
        }>
      >`
        SELECT
          current_user AS "roleName",
          rolsuper AS superuser,
          rolbypassrls AS "bypassRls",
          has_table_privilege(current_user, 'public.companies', 'DELETE') AS "canDeleteCompanies"
        FROM pg_roles
        WHERE rolname = current_user
      `;
      expect(roleRows).toHaveLength(1);
      expect(roleRows[0]).toMatchObject({
        superuser: false,
        bypassRls: false,
        canDeleteCompanies: false,
      });

      const rlsRows = await firstWorker.$queryRaw<
        Array<{ tableName: string; enabled: boolean; forced: boolean }>
      >`
        SELECT
          class.relname AS "tableName",
          class.relrowsecurity AS enabled,
          class.relforcerowsecurity AS forced
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'public'
          AND class.relname IN (
            'companies',
            'company_billing_settings',
            'document_folders',
            'public_access_tokens',
            'subscriptions'
          )
        ORDER BY class.relname
      `;
      expect(rlsRows).toEqual([
        { tableName: 'companies', enabled: true, forced: true },
        { tableName: 'company_billing_settings', enabled: true, forced: true },
        { tableName: 'document_folders', enabled: true, forced: true },
        { tableName: 'public_access_tokens', enabled: true, forced: true },
        { tableName: 'subscriptions', enabled: true, forced: true },
      ]);

      const closureFence = await admin.$queryRaw<
        Array<{ constraintName: string; triggerName: string; enabled: string }>
      >`
        SELECT
          constraint_row.conname AS "constraintName",
          trigger_row.tgname AS "triggerName",
          trigger_row.tgenabled AS enabled
        FROM pg_constraint constraint_row
        JOIN pg_class company_table ON company_table.oid = constraint_row.conrelid
        JOIN pg_namespace company_namespace ON company_namespace.oid = company_table.relnamespace
        JOIN pg_trigger trigger_row ON trigger_row.tgrelid = company_table.oid
        WHERE company_namespace.nspname = 'public'
          AND company_table.relname = 'companies'
          AND constraint_row.conname = 'companies_closure_reason_requires_closed_at'
          AND trigger_row.tgname = 'companies_closure_monotonicity'
          AND NOT trigger_row.tgisinternal
      `;
      expect(closureFence).toEqual([
        {
          constraintName: 'companies_closure_reason_requires_closed_at',
          triggerName: 'companies_closure_monotonicity',
          enabled: 'O',
        },
      ]);
      const deleteFence = await admin.$queryRaw<Array<{ triggerName: string; enabled: string }>>`
        SELECT trigger_row.tgname AS "triggerName", trigger_row.tgenabled AS enabled
        FROM pg_trigger trigger_row
        JOIN pg_class company_table ON company_table.oid = trigger_row.tgrelid
        JOIN pg_namespace company_namespace ON company_namespace.oid = company_table.relnamespace
        WHERE company_namespace.nspname = 'public'
          AND company_table.relname = 'companies'
          AND trigger_row.tgname = 'companies_closed_delete_fence'
          AND NOT trigger_row.tgisinternal
      `;
      expect(deleteFence).toEqual([{ triggerName: 'companies_closed_delete_fence', enabled: 'O' }]);

      const foreign = await seedFixture('rls-foreign-tenant');
      const visible = await firstWorker.withTenant(sentinel.companyId, async () => ({
        ownCompany: await firstPersistence.companies.findById(sentinel.companyId),
        foreignCompany: await firstPersistence.companies.findById(foreign.companyId),
        ownSettings: await firstPersistence.billingSettings.findByCompanyId(sentinel.companyId),
        foreignSettings: await firstPersistence.billingSettings.findByCompanyId(foreign.companyId),
      }));
      expect(visible.ownCompany?.id).toBe(sentinel.companyId);
      expect(visible.ownSettings?.companyId).toBe(sentinel.companyId);
      expect(visible.foreignCompany).toBeNull();
      expect(visible.foreignSettings).toBeNull();

      const deleteTarget = await seedFixture('runtime-delete-forbidden', undefined, false);
      await firstWorker.withTenant(deleteTarget.companyId, () =>
        firstWorker.client().$executeRawUnsafe(`
          DO $runtime_company_delete_cert$
          BEGIN
            BEGIN
              DELETE FROM companies
              WHERE id = current_setting('app.current_company_id', true);
              RAISE EXCEPTION 'CERT_RUNTIME_COMPANY_DELETE_WAS_ALLOWED';
            EXCEPTION
              WHEN insufficient_privilege THEN NULL;
            END;
          END
          $runtime_company_delete_cert$;
        `),
      );
      expect(
        await admin.company.findUnique({ where: { id: deleteTarget.companyId } }),
      ).not.toBeNull();
    });

    it('refuse save/createIfAbsentOpen hors transaction et ne modifie aucune row', async () => {
      const fixture = await seedFixture('repository-outside-transaction');
      const original = await firstWorker.withTenant(fixture.companyId, () =>
        firstPersistence.companies.findById(fixture.companyId),
      );
      if (!original) throw new Error('Company fixture invisible sous son propre tenant.');
      const forged = Company.of({ ...original.toProps(), name: 'Nom forgé hors transaction' });
      if (!forged.ok) throw new Error('Company forgée invalide.');

      await expect(firstPersistence.companies.save(forged.value)).rejects.toThrow(
        'Company lifecycle write requires an active transaction.',
      );

      const candidateId = `company-mutation-outside-${randomUUID()}`;
      companyIds.push(candidateId);
      const candidate = Company.of({
        ...original.toProps(),
        id: candidateId,
        name: 'Création hors transaction',
        siret: validSiret(SIREN, fixtureSequence),
        closedAt: undefined,
        closureReason: undefined,
      });
      fixtureSequence += 1;
      if (!candidate.ok) throw new Error('Candidate Company invalide.');
      await expect(firstPersistence.companies.createIfAbsentOpen(candidate.value)).rejects.toThrow(
        'Company create-if-absent requires an active transaction.',
      );

      expect(
        await admin.company.findUniqueOrThrow({ where: { id: fixture.companyId } }),
      ).toMatchObject({ name: fixture.companyName, closedAt: null, closureReason: null });
      expect(await admin.company.findUnique({ where: { id: candidateId } })).toBeNull();
      await assertSentinelUntouched();
    });

    it.each(WRITERS)(
      '$label gagnant : la clôture attend exactement le SELECT companies FOR UPDATE, puis committe après le writer',
      async ({ kind }) => {
        const fixture = await seedFixture(`${kind}-wins`);
        const gate: Gate<number> = {
          acquired: deferred<number>(),
          release: deferred<void>(),
        };
        const gatedCompanies = gateCompanyLock({
          repository: firstPersistence.companies,
          worker: firstWorker,
          companyId: fixture.companyId,
          gate,
        });
        const { service } = makeBackend(
          persistenceWith(firstPersistence, { companies: gatedCompanies }),
        );
        const writerPromise = runTenantAction({
          worker: firstWorker,
          companyId: fixture.companyId,
          action: () => invokeWriter(kind, service),
        });
        const writerPid = await waitForGateOrFailure(
          gate.acquired.promise,
          writerPromise,
          `${kind}-wins:writer`,
        );

        const closePid = deferred<number>();
        const closePromise = runCloseAccount({
          worker: secondWorker,
          persistence: secondPersistence,
          fixture,
          onStart: (pid) => closePid.resolve(pid),
        });
        let blockingError: unknown;
        let observation: BlockingObservation | undefined;
        try {
          const blockedPid = await waitForGateOrFailure(
            closePid.promise,
            closePromise,
            `${kind}-wins:closer-start`,
          );
          observation = await waitUntilBlockedBy({
            admin,
            blockedPid,
            blockerPid: writerPid,
            context: `${kind}-wins`,
            expectedQuery: isCompanyForUpdate,
          });
        } catch (error) {
          blockingError = error;
        } finally {
          gate.release.resolve(undefined);
        }

        const [written, closed] = await Promise.all([writerPromise, closePromise]);
        if (blockingError) throw blockingError;
        expect(observation?.blockerPids).toEqual([writerPid]);
        expect(observation?.waitEventType).toBe('Lock');
        expect(isCompanyForUpdate(observation?.query ?? '')).toBe(true);
        expect(written.ok).toBe(true);
        expect(closed.ok).toBe(true);
        await assertWriterState(fixture, kind, 'won');
        await assertClosed(fixture);
        await assertSentinelUntouched();
      },
      30_000,
    );

    it.each(WRITERS)(
      'clôture gagnante contre $label : le writer attend exactement le SELECT companies FOR UPDATE puis refuse la row clôturée',
      async ({ kind }) => {
        const fixture = await seedFixture(`close-wins-${kind}`);
        const gate: Gate<number> = {
          acquired: deferred<number>(),
          release: deferred<void>(),
        };
        const gatedCompanies = gateCompanyLock({
          repository: firstPersistence.companies,
          worker: firstWorker,
          companyId: fixture.companyId,
          gate,
        });
        const closePromise = runCloseAccount({
          worker: firstWorker,
          persistence: firstPersistence,
          fixture,
          companies: gatedCompanies,
        });
        const closerPid = await waitForGateOrFailure(
          gate.acquired.promise,
          closePromise,
          `close-wins-${kind}:closer`,
        );

        const { service } = makeBackend(secondPersistence);
        const writerPid = deferred<number>();
        const writerPromise = runTenantAction({
          worker: secondWorker,
          companyId: fixture.companyId,
          action: () => invokeWriter(kind, service),
          onStart: (pid) => writerPid.resolve(pid),
        });
        let blockingError: unknown;
        let observation: BlockingObservation | undefined;
        try {
          const blockedPid = await waitForGateOrFailure(
            writerPid.promise,
            writerPromise,
            `close-wins-${kind}:writer-start`,
          );
          observation = await waitUntilBlockedBy({
            admin,
            blockedPid,
            blockerPid: closerPid,
            context: `close-wins-${kind}`,
            expectedQuery: isCompanyForUpdate,
          });
        } catch (error) {
          blockingError = error;
        } finally {
          gate.release.resolve(undefined);
        }

        const [closed, written] = await Promise.all([closePromise, writerPromise]);
        if (blockingError) throw blockingError;
        expect(observation?.blockerPids).toEqual([closerPid]);
        expect(observation?.waitEventType).toBe('Lock');
        expect(isCompanyForUpdate(observation?.query ?? '')).toBe(true);
        expect(closed.ok).toBe(true);
        expect(written).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
        await assertWriterState(fixture, kind, 'rejected');
        await assertClosed(fixture);
        await assertSentinelUntouched();
      },
      30_000,
    );

    it('retry de provisioning gagnant : la clôture attend son verrou puis ferme sans écraser la première identité', async () => {
      const userId = randomUUID();
      const fixture = await seedFixture('provisioning-wins', `company-${userId}`);
      const gate: Gate<number> = {
        acquired: deferred<number>(),
        release: deferred<void>(),
      };
      const gatedCompanies = gateCompanyLock({
        repository: firstPersistence.companies,
        worker: firstWorker,
        companyId: fixture.companyId,
        gate,
      });
      const { service, effects } = makeBackend(
        persistenceWith(firstPersistence, { companies: gatedCompanies }),
      );
      const registerPromise = asPrincipal({ userId, companyId: null }, () =>
        service.registerCompany(registrationInput(fixture, 'Nom forgé au retry')),
      );
      const provisioningPid = await waitForGateOrFailure(
        gate.acquired.promise,
        registerPromise,
        'provisioning-wins:retry',
      );

      const closePid = deferred<number>();
      const closePromise = runCloseAccount({
        worker: secondWorker,
        persistence: secondPersistence,
        fixture,
        onStart: (pid) => closePid.resolve(pid),
      });
      let blockingError: unknown;
      let observation: BlockingObservation | undefined;
      try {
        observation = await waitUntilBlockedBy({
          admin,
          blockedPid: await waitForGateOrFailure(
            closePid.promise,
            closePromise,
            'provisioning-wins:closer-start',
          ),
          blockerPid: provisioningPid,
          context: 'provisioning-wins',
          expectedQuery: isCompanyForUpdate,
        });
      } catch (error) {
        blockingError = error;
      } finally {
        gate.release.resolve(undefined);
      }

      const [registered, closed] = await Promise.all([registerPromise, closePromise]);
      if (blockingError) throw blockingError;
      expect(observation?.blockerPids).toEqual([provisioningPid]);
      expect(registered).toEqual({ ok: true, value: { companyId: fixture.companyId } });
      expect(closed.ok).toBe(true);
      expect(effects.metadataWrites).toBe(1);
      expect(
        await admin.company.findUniqueOrThrow({ where: { id: fixture.companyId } }),
      ).toMatchObject({ name: fixture.companyName });
      expect(await admin.documentFolder.count({ where: { companyId: fixture.companyId } })).toBe(
        DEFAULT_DOCUMENT_FOLDERS.length,
      );
      await assertClosed(fixture);
      await assertSentinelUntouched();
    }, 30_000);

    it('clôture gagnante contre un retry de provisioning : le retry bloqué refuse sans recréer de dépendance', async () => {
      const userId = randomUUID();
      const fixture = await seedFixture('close-wins-provisioning', `company-${userId}`, false);
      const gate: Gate<number> = {
        acquired: deferred<number>(),
        release: deferred<void>(),
      };
      const gatedCompanies = gateCompanyLock({
        repository: firstPersistence.companies,
        worker: firstWorker,
        companyId: fixture.companyId,
        gate,
      });
      const closePromise = runCloseAccount({
        worker: firstWorker,
        persistence: firstPersistence,
        fixture,
        companies: gatedCompanies,
      });
      const closerPid = await waitForGateOrFailure(
        gate.acquired.promise,
        closePromise,
        'close-wins-provisioning:closer',
      );

      const tenantStarted = deferred<number>();
      const observedPersistence = persistenceObservingFirstTenantStart({
        base: secondPersistence,
        worker: secondWorker,
        started: tenantStarted,
      });
      const { service, effects } = makeBackend(observedPersistence);
      const registerPromise = asPrincipal({ userId, companyId: null }, () =>
        service.registerCompany(registrationInput(fixture, 'Tentative de résurrection')),
      );
      let blockingError: unknown;
      let observation: BlockingObservation | undefined;
      try {
        const blockedPid = await waitForGateOrFailure(
          tenantStarted.promise,
          registerPromise,
          'close-wins-provisioning:retry-start',
        );
        observation = await waitUntilBlockedBy({
          admin,
          blockedPid,
          blockerPid: closerPid,
          context: 'close-wins-provisioning',
          expectedQuery: isCompanyProvisioningQuery,
        });
      } catch (error) {
        blockingError = error;
      } finally {
        gate.release.resolve(undefined);
      }

      const [closed, registered] = await Promise.all([closePromise, registerPromise]);
      if (blockingError) throw blockingError;
      expect(observation?.blockerPids).toEqual([closerPid]);
      expect(closed.ok).toBe(true);
      expect(registered).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
      expect(effects.metadataWrites).toBe(0);
      const [company, settings, subscription, folders] = await Promise.all([
        admin.company.findUniqueOrThrow({ where: { id: fixture.companyId } }),
        admin.companyBillingSettings.findUnique({ where: { companyId: fixture.companyId } }),
        admin.subscription.findUnique({ where: { companyId: fixture.companyId } }),
        admin.documentFolder.count({ where: { companyId: fixture.companyId } }),
      ]);
      expect(company).toMatchObject({
        name: fixture.companyName,
        closedAt: new Date(CLOSE_NOW),
        closureReason: CLOSE_REASON,
      });
      expect({ settings, subscription, folders }).toEqual({
        settings: null,
        subscription: null,
        folders: 0,
      });
      await assertSentinelUntouched();
    }, 30_000);

    it('rollback tardif des dossiers : annule Company, settings, abonnement et premier dossier déjà écrit', async () => {
      const userId = randomUUID();
      const companyId = `company-${userId}`;
      companyIds.push(companyId);
      const fixture: Fixture = {
        companyId,
        userId,
        companyName: 'Certification rollback dossiers',
        siren: SIREN,
        siret: validSiret(SIREN, fixtureSequence),
        subscriptionId: `sub-${companyId}`,
      };
      fixtureSequence += 1;
      const attempts = { value: 0 };
      const failingFolders = failSecondFolderSave({
        repository: firstPersistence.documentFolders,
        attempts,
      });
      const { service, effects } = makeBackend(
        persistenceWith(firstPersistence, { documentFolders: failingFolders }),
      );

      const result = await asPrincipal({ userId, companyId: null }, () =>
        service.registerCompany(registrationInput(fixture, fixture.companyName)),
      );

      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'conflict', entity: 'document_folder' },
      });
      expect(attempts.value).toBe(2);
      expect(effects.metadataWrites).toBe(0);
      const [company, settings, subscription, folders] = await Promise.all([
        admin.company.findUnique({ where: { id: companyId } }),
        admin.companyBillingSettings.findUnique({ where: { companyId } }),
        admin.subscription.findUnique({ where: { companyId } }),
        admin.documentFolder.count({ where: { companyId } }),
      ]);
      expect({ company, settings, subscription, folders }).toEqual({
        company: null,
        settings: null,
        subscription: null,
        folders: 0,
      });
      await assertSentinelUntouched();
    }, 30_000);

    it('défense SQL : motif orphelin, clôture+mutation, réouverture, renommage et hard-delete échouent avec 23514/contrainte exacte', async () => {
      const fixture = await seedFixture('sql-trigger');
      await certifyCompanySqlFence(admin, fixture.companyId, 'closure_reason_without_close');
      await certifyCompanySqlFence(admin, fixture.companyId, 'close_and_rename');
      expect(
        await admin.company.findUniqueOrThrow({ where: { id: fixture.companyId } }),
      ).toMatchObject({
        name: fixture.companyName,
        closedAt: null,
        closureReason: null,
      });

      const closed = await runCloseAccount({
        worker: firstWorker,
        persistence: firstPersistence,
        fixture,
      });
      expect(closed.ok).toBe(true);

      expect(
        await admin.$executeRaw`
          UPDATE "companies"
          SET name = name
          WHERE id = ${fixture.companyId}
        `,
      ).toBe(1);
      await certifyCompanySqlFence(admin, fixture.companyId, 'reopen');
      await certifyCompanySqlFence(admin, fixture.companyId, 'rename_after_close');
      await certifyCompanySqlFence(admin, fixture.companyId, 'delete_closed');

      expect(
        await admin.company.findUniqueOrThrow({ where: { id: fixture.companyId } }),
      ).toMatchObject({
        name: fixture.companyName,
        closedAt: new Date(CLOSE_NOW),
        closureReason: CLOSE_REASON,
      });
      await assertClosed(fixture);
      await assertSentinelUntouched();
    }, 30_000);
  },
);
