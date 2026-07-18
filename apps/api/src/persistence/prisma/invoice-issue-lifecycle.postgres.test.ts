import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CloseAccount, IssueInvoice, type ClockPort, type CompanyRepository } from '@bob/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BackendService } from '../../backend.service';
import { requestContext } from '../../observability/logger';
import { PrismaPersistence } from './prisma-persistence';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_INVOICE_ISSUE_LIFECYCLE_CERT === 'true';
const CERT_NOW = '2026-06-30T10:00:00.000Z';
const CLOSE_NOW = '2026-06-30T10:00:01.000Z';
const FISCAL_YEAR = 2026;
const TERMS = {
  days: 30,
  endOfMonth: false,
  label: 'Paiement à 30 jours',
} as const;
const clock: ClockPort = {
  now: () => CERT_NOW,
  today: () => CERT_NOW.slice(0, 10),
};

interface Fixture {
  readonly companyId: string;
  readonly companyName: string;
  readonly customerId: string;
  readonly baselineInvoiceId: string;
  readonly targetInvoiceId: string;
  readonly targetLineId: string;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

async function waitUntilBlockedBy(input: {
  admin: PrismaClient;
  blockedPid: number;
  blockerPid: number;
  context: string;
  expectedLockSql: 'FOR SHARE' | 'FOR UPDATE';
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
    const expectedSql =
      lastObservation?.query.toUpperCase().includes(input.expectedLockSql) ?? false;
    if (
      exactBlocker &&
      expectedSql &&
      lastObservation?.state === 'active' &&
      lastObservation.waitEventType === 'Lock'
    ) {
      return lastObservation;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `${input.context}: backend ${input.blockedPid} was not blocked exclusively by ` +
      `${input.blockerPid} while executing ${input.expectedLockSql}; ` +
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
  repository: CompanyRepository;
  worker: PrismaService;
  companyId: string;
  mode: 'share' | 'update';
  gate: Gate<number>;
}): CompanyRepository {
  let armed = true;
  const pauseAfterRealLock = async <T>(mode: 'share' | 'update', value: T): Promise<T> => {
    if (armed && mode === input.mode) {
      armed = false;
      if (!input.worker.inTransaction()) {
        throw new Error('Lifecycle row lock acquired outside an active transaction.');
      }
      input.gate.acquired.resolve(await backendPid(input.worker));
      await input.gate.release.promise;
    }
    return value;
  };
  return {
    findById: (id) => input.repository.findById(id),
    lockById: async (id) => {
      const value = await input.repository.lockById(id);
      return id === input.companyId ? pauseAfterRealLock('update', value) : value;
    },
    lockForShareById: async (id) => {
      const value = await input.repository.lockForShareById(id);
      return id === input.companyId ? pauseAfterRealLock('share', value) : value;
    },
    list: () => input.repository.list(),
    save: (company) => input.repository.save(company),
  };
}

function validSiret(siren: string, establishmentSequence: number): string {
  const nic = String(establishmentSequence % 10_000).padStart(4, '0');
  const prefix = `${siren}${nic}`;
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

async function runIssueInvoice(input: {
  worker: PrismaService;
  persistence: PrismaPersistence;
  fixture: Fixture;
  companies?: CompanyRepository;
  onStart?: (pid: number) => void;
}) {
  // Reproduit le contexte transactionnel du TenantPersistenceInterceptor : le locator initial de
  // IssueInvoice est déjà sous RLS, puis son UoW réentrant conserve le même PID et les mêmes locks.
  return input.worker.withTenant(input.fixture.companyId, async () => {
    if (input.onStart) input.onStart(await backendPid(input.worker));
    return new IssueInvoice({
      invoices: input.persistence.invoices,
      companies: input.companies ?? input.persistence.companies,
      customers: input.persistence.customers,
      counters: input.persistence.counters,
      uow: input.persistence,
      clock,
    }).execute({ invoiceId: input.fixture.targetInvoiceId, terms: TERMS });
  });
}

function makeBackendService(persistence: PrismaPersistence): BackendService {
  const service = new BackendService(
    persistence,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      audit: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      log: () => undefined,
    } as never,
  );
  // Le certificat porte sur la transaction légale (réglages, numéro, comptabilité, outbox).
  // Le worker d'archivage possède ses propres certificats ; on le neutralise après l'enqueue afin
  // de ne pas ajouter ici une dépendance objet/PDF sans affaiblir la preuve de durabilité SQL.
  vi.spyOn(service, 'runDocumentArchiveJobs').mockResolvedValue({
    ok: true,
    value: { scanned: 0, archived: 0, failed: 0 },
  });
  return service;
}

async function runBackendIssueInvoice(input: {
  worker: PrismaService;
  persistence: PrismaPersistence;
  fixture: Fixture;
  onStart?: (pid: number) => void;
}) {
  const service = makeBackendService(input.persistence);
  return requestContext.run(
    {
      correlationId: `invoice-lifecycle-${input.fixture.companyId}`,
      principal: {
        userId: `owner-${input.fixture.companyId}`,
        companyId: input.fixture.companyId,
      },
    },
    () =>
      input.worker.withTenant(input.fixture.companyId, async () => {
        if (input.onStart) input.onStart(await backendPid(input.worker));
        return service.issueInvoice({ invoiceId: input.fixture.targetInvoiceId });
      }),
  );
}

async function runBillingSettingsUpdate(input: {
  worker: PrismaService;
  persistence: PrismaPersistence;
  fixture: Fixture;
  paymentTermsDays: number;
  gate: Gate<number>;
}) {
  return input.worker.withTenant(input.fixture.companyId, async () => {
    const company = await input.persistence.companies.lockById(input.fixture.companyId);
    if (!company || company.isClosed()) throw new Error('Writer Company indisponible ou clôturée.');
    const updated = await input.persistence.billingSettings.update({
      companyId: input.fixture.companyId,
      expectedRevision: 1,
      patch: { defaultInvoicePaymentTermsDays: input.paymentTermsDays },
    });
    input.gate.acquired.resolve(await backendPid(input.worker));
    await input.gate.release.promise;
    return updated;
  });
}

async function runCloseAccount(input: {
  worker: PrismaService;
  persistence: PrismaPersistence;
  fixture: Fixture;
  companies?: CompanyRepository;
  onStart?: (pid: number) => void;
}) {
  return input.worker.withTenant(input.fixture.companyId, async () => {
    if (input.onStart) input.onStart(await backendPid(input.worker));
    return new CloseAccount({
      companies: input.companies ?? input.persistence.companies,
      subscriptions: input.persistence.subscriptions,
      publicAccessTokens: input.persistence.publicAccessTokens,
      uow: input.persistence,
    }).execute({
      companyId: input.fixture.companyId,
      confirmationText: input.fixture.companyName,
      reason: 'certification concurrence émission facture',
      now: CLOSE_NOW,
    });
  });
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Émission facture — certification PostgreSQL/RLS du fence de clôture Company',
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
      defaultInvoicePaymentTermsDays?: number | null,
    ): Promise<Fixture> {
      const id = randomUUID();
      const fixture: Fixture = {
        companyId: `invoice-lifecycle-company-${id}`,
        companyName: `Certification facture ${label} ${id.slice(0, 8)}`,
        customerId: `invoice-lifecycle-customer-${id}`,
        baselineInvoiceId: `invoice-lifecycle-baseline-${id}`,
        targetInvoiceId: `invoice-lifecycle-target-${id}`,
        targetLineId: `invoice-lifecycle-target-line-${id}`,
        subscriptionId: `invoice-lifecycle-subscription-${id}`,
      };
      const baselineLineId = `invoice-lifecycle-baseline-line-${id}`;
      const siret = validSiret('552100554', fixtureSequence);
      fixtureSequence += 1;

      await admin.$transaction(async (tx) => {
        await tx.company.create({
          data: {
            id: fixture.companyId,
            name: fixture.companyName,
            legalForm: 'EI',
            siren: '552100554',
            siret,
            trade: 'autre',
            vatRegime: 'reel_normal',
            rcsOrRm: 'RCS Paris 552 100 554',
            addrLine1: '1 rue de la Certification',
            addrZip: '75001',
            addrCity: 'Paris',
          },
        });
        if (defaultInvoicePaymentTermsDays !== undefined) {
          await tx.companyBillingSettings.create({
            data: {
              companyId: fixture.companyId,
              defaultInvoicePaymentTermsDays,
            },
          });
        }
        await tx.customer.create({
          data: {
            id: fixture.customerId,
            companyId: fixture.companyId,
            type: 'b2b',
            name: 'Client certification lifecycle',
            siren: '732829320',
            addrLine1: '2 rue du Client',
            addrZip: '75002',
            addrCity: 'Paris',
          },
        });
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
        await tx.invoice.create({
          data: {
            id: fixture.baselineInvoiceId,
            companyId: fixture.companyId,
            customerId: fixture.customerId,
            kind: 'invoice',
            status: 'draft',
            lines: {
              create: [
                {
                  id: baselineLineId,
                  position: 0,
                  label: 'Référence légale précédente',
                  category: 'labor',
                  qty: 1,
                  unitPriceHt: 5_000,
                  vatRate: 20,
                },
              ],
            },
          },
        });
        await tx.invoice.update({
          where: { id: fixture.baselineInvoiceId },
          data: {
            status: 'issued',
            number: 'F-2026-0001',
            issuedAt: new Date('2026-01-02T00:00:00.000Z'),
            dueAt: new Date('2026-02-01T00:00:00.000Z'),
            totalsHt: 5_000,
            totalsVat: 1_000,
            totalsTtc: 6_000,
            totalsNetToPay: 6_000,
            vatByRate: { '20': 1_000 },
            legalMentions: ['Référence légale de certification'],
          },
        });
        await tx.invoice.create({
          data: {
            id: fixture.targetInvoiceId,
            companyId: fixture.companyId,
            customerId: fixture.customerId,
            kind: 'invoice',
            status: 'draft',
            lines: {
              create: [
                {
                  id: fixture.targetLineId,
                  position: 0,
                  label: 'Intervention à émettre',
                  category: 'labor',
                  qty: 1,
                  unit: 'heure',
                  unitPriceHt: 10_000,
                  vatRate: 20,
                },
              ],
            },
          },
        });
        await tx.documentCounter.create({
          data: {
            companyId: fixture.companyId,
            counterKey: 'invoice',
            fiscalYear: FISCAL_YEAR,
            nextValue: 1,
          },
        });
      });
      companyIds.push(fixture.companyId);
      return fixture;
    }

    async function assertNoGap(companyId: string, expectedLastSequence: number): Promise<void> {
      const counter = await admin.documentCounter.findUnique({
        where: {
          companyId_counterKey_fiscalYear: {
            companyId,
            counterKey: 'invoice',
            fiscalYear: FISCAL_YEAR,
          },
        },
      });
      expect(counter?.nextValue).toBe(expectedLastSequence);
      const issuedNumbers = (
        await admin.invoice.findMany({
          where: { companyId, number: { startsWith: `F-${FISCAL_YEAR}-` } },
          select: { number: true },
          orderBy: { number: 'asc' },
        })
      ).map((invoice) => invoice.number);
      expect(issuedNumbers).toEqual(
        Array.from(
          { length: expectedLastSequence },
          (_, index) => `F-${FISCAL_YEAR}-${String(index + 1).padStart(4, '0')}`,
        ),
      );
    }

    async function assertClosed(fixture: Fixture): Promise<void> {
      const [company, subscription] = await Promise.all([
        admin.company.findUniqueOrThrow({ where: { id: fixture.companyId } }),
        admin.subscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } }),
      ]);
      expect(company.closedAt?.toISOString()).toBe(CLOSE_NOW);
      expect(company.closureReason).toBe('certification concurrence émission facture');
      expect(subscription.status).toBe('canceled');
    }

    async function assertSentinelUntouched(): Promise<void> {
      const [company, subscription, baseline, target] = await Promise.all([
        admin.company.findUniqueOrThrow({ where: { id: sentinel.companyId } }),
        admin.subscription.findUniqueOrThrow({ where: { id: sentinel.subscriptionId } }),
        admin.invoice.findUniqueOrThrow({ where: { id: sentinel.baselineInvoiceId } }),
        admin.invoice.findUniqueOrThrow({ where: { id: sentinel.targetInvoiceId } }),
      ]);
      expect(company.closedAt).toBeNull();
      expect(company.closureReason).toBeNull();
      expect(subscription.status).toBe('active');
      expect(baseline).toMatchObject({ status: 'issued', number: 'F-2026-0001' });
      expect(target).toMatchObject({ status: 'draft', number: null, issuedAt: null, dueAt: null });
      await assertNoGap(sentinel.companyId, 1);
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
          // Les lignes de factures émises et la réouverture d'une société clôturée sont protégées
          // par des triggers légaux. Le compte DIRECT_URL ne les neutralise que pour ces deux
          // opérations sur les UUID de fixture, puis réactive explicitement tous les triggers/FK
          // AVANT les DELETE finaux : toute future dépendance oubliée doit faire échouer le gate.
          await admin.$transaction(async (tx) => {
            await tx.accountingEntryLine.deleteMany({
              where: { companyId: { in: companyIds } },
            });
            await tx.accountingEntry.deleteMany({ where: { companyId: { in: companyIds } } });
            await tx.documentArchiveJob.deleteMany({ where: { companyId: { in: companyIds } } });
            await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
            await tx.lineItem.deleteMany({
              where: { invoice: { companyId: { in: companyIds } } },
            });
            await tx.company.updateMany({
              where: { id: { in: companyIds } },
              data: { closedAt: null, closureReason: null },
            });
            await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
            await tx.invoice.deleteMany({ where: { companyId: { in: companyIds } } });
            await tx.documentCounter.deleteMany({ where: { companyId: { in: companyIds } } });
            await tx.publicAccessToken.deleteMany({ where: { companyId: { in: companyIds } } });
            await tx.subscription.deleteMany({ where: { companyId: { in: companyIds } } });
            await tx.companyBillingSettings.deleteMany({
              where: { companyId: { in: companyIds } },
            });
            await tx.customer.deleteMany({ where: { companyId: { in: companyIds } } });
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

    it('exécute sous un rôle runtime sans superuser/bypass RLS et FORCE RLS sur les tables critiques', async () => {
      const roleRows = await firstWorker.$queryRaw<
        Array<{ roleName: string; superuser: boolean; bypassRls: boolean }>
      >`
        SELECT
          current_user AS "roleName",
          rolsuper AS superuser,
          rolbypassrls AS "bypassRls"
        FROM pg_roles
        WHERE rolname = current_user
      `;
      expect(roleRows).toHaveLength(1);
      expect(roleRows[0]).toMatchObject({ superuser: false, bypassRls: false });

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
            'accounting_entries',
            'accounting_entry_lines',
            'company_billing_settings',
            'companies',
            'customers',
            'document_archive_jobs',
            'document_counters',
            'invoices',
            'line_items',
            'public_access_tokens',
            'subscriptions'
          )
        ORDER BY class.relname
      `;
      expect(rlsRows).toEqual([
        { tableName: 'accounting_entries', enabled: true, forced: true },
        { tableName: 'accounting_entry_lines', enabled: true, forced: true },
        { tableName: 'companies', enabled: true, forced: true },
        { tableName: 'company_billing_settings', enabled: true, forced: true },
        { tableName: 'customers', enabled: true, forced: true },
        { tableName: 'document_archive_jobs', enabled: true, forced: true },
        { tableName: 'document_counters', enabled: true, forced: true },
        { tableName: 'invoices', enabled: true, forced: true },
        { tableName: 'line_items', enabled: true, forced: true },
        { tableName: 'public_access_tokens', enabled: true, forced: true },
        { tableName: 'subscriptions', enabled: true, forced: true },
      ]);
    });

    it('échoue fermé sans ligne de réglages et ne persiste aucun effet légal', async () => {
      const fixture = await seedFixture('missing-billing-settings');

      const issued = await runBackendIssueInvoice({
        worker: firstWorker,
        persistence: firstPersistence,
        fixture,
      });

      expect(issued).toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'company-billing-settings' },
      });
      const invoice = await admin.invoice.findUniqueOrThrow({
        where: { id: fixture.targetInvoiceId },
      });
      expect(invoice).toMatchObject({
        status: 'draft',
        number: null,
        issuedAt: null,
        dueAt: null,
      });
      expect(await admin.accountingEntry.count({ where: { companyId: fixture.companyId } })).toBe(
        0,
      );
      expect(
        await admin.documentArchiveJob.count({ where: { companyId: fixture.companyId } }),
      ).toBe(0);
      await assertNoGap(fixture.companyId, 1);
      await assertSentinelUntouched();
    });

    it('attend un writer de réglages puis fige le nouveau délai, jamais le snapshot MVCC ancien', async () => {
      const fixture = await seedFixture('billing-settings-writer-wins', 30);
      const gate: Gate<number> = {
        acquired: deferred<number>(),
        release: deferred<void>(),
      };
      const updatePromise = runBillingSettingsUpdate({
        worker: firstWorker,
        persistence: firstPersistence,
        fixture,
        paymentTermsDays: 45,
        gate,
      });
      const writerPid = await waitForGateOrFailure(
        gate.acquired.promise,
        updatePromise,
        'billing-settings-writer:writer',
      );

      const issuePid = deferred<number>();
      const issuePromise = runBackendIssueInvoice({
        worker: secondWorker,
        persistence: secondPersistence,
        fixture,
        onStart: (pid) => issuePid.resolve(pid),
      });
      let blockingError: unknown;
      let observation: BlockingObservation | undefined;
      try {
        const blockedPid = await waitForGateOrFailure(
          issuePid.promise,
          issuePromise,
          'billing-settings-writer:issuer-start',
        );
        expect(blockedPid).not.toBe(writerPid);
        observation = await waitUntilBlockedBy({
          admin,
          blockedPid,
          blockerPid: writerPid,
          context: 'billing-settings-writer',
          expectedLockSql: 'FOR SHARE',
        });
      } catch (error) {
        blockingError = error;
      } finally {
        gate.release.resolve(undefined);
      }

      const [updated, issued] = await Promise.all([updatePromise, issuePromise]);
      if (blockingError) throw blockingError;
      expect(observation?.blockerPids).toEqual([writerPid]);
      expect(updated).toMatchObject({
        status: 'updated',
        settings: { revision: 2, defaultInvoicePaymentTermsDays: 45 },
      });
      expect(issued).toEqual({ ok: true, value: { number: 'F-2026-0002' } });

      const [invoice, settings] = await Promise.all([
        admin.invoice.findUniqueOrThrow({ where: { id: fixture.targetInvoiceId } }),
        admin.companyBillingSettings.findUniqueOrThrow({ where: { companyId: fixture.companyId } }),
      ]);
      expect(settings).toMatchObject({ revision: 2, defaultInvoicePaymentTermsDays: 45 });
      expect(invoice).toMatchObject({ status: 'issued', number: 'F-2026-0002' });
      expect(invoice.issuedAt).not.toBeNull();
      expect(invoice.dueAt).not.toBeNull();
      if (invoice.issuedAt === null || invoice.dueAt === null) {
        throw new Error('Dates légales absentes après émission certifiée.');
      }
      expect(invoice.dueAt.getTime() - invoice.issuedAt.getTime()).toBe(45 * 24 * 60 * 60 * 1_000);
      expect(await admin.accountingEntry.count({ where: { companyId: fixture.companyId } })).toBe(
        1,
      );
      expect(
        await admin.documentArchiveJob.count({ where: { companyId: fixture.companyId } }),
      ).toBe(1);
      await assertNoGap(fixture.companyId, 2);
      await assertSentinelUntouched();
    }, 30_000);

    it('émission gagnante : CloseAccount attend, puis conserve la facture légale sans trou', async () => {
      const fixture = await seedFixture('issue-wins');
      const gate: Gate<number> = {
        acquired: deferred<number>(),
        release: deferred<void>(),
      };
      const gatedCompanies = gateCompanyLock({
        repository: firstPersistence.companies,
        worker: firstWorker,
        companyId: fixture.companyId,
        mode: 'share',
        gate,
      });
      const issuePromise = runIssueInvoice({
        worker: firstWorker,
        persistence: firstPersistence,
        fixture,
        companies: gatedCompanies,
      });
      const issuerPid = await waitForGateOrFailure(
        gate.acquired.promise,
        issuePromise,
        'issue-wins:issuer',
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
          'issue-wins:closer-start',
        );
        expect(blockedPid).not.toBe(issuerPid);
        observation = await waitUntilBlockedBy({
          admin,
          blockedPid,
          blockerPid: issuerPid,
          context: 'issue-wins',
          expectedLockSql: 'FOR UPDATE',
        });
      } catch (error) {
        blockingError = error;
      } finally {
        gate.release.resolve(undefined);
      }

      const [issued, closed] = await Promise.all([issuePromise, closePromise]);
      if (blockingError) throw blockingError;
      expect(observation?.blockerPids).toEqual([issuerPid]);
      expect(issued).toEqual({ ok: true, value: { number: 'F-2026-0002' } });
      expect(closed.ok).toBe(true);

      const invoice = await admin.invoice.findUniqueOrThrow({
        where: { id: fixture.targetInvoiceId },
        include: { lines: true },
      });
      expect(invoice).toMatchObject({
        status: 'issued',
        number: 'F-2026-0002',
        totalsHt: 10_000,
        totalsVat: 2_000,
        totalsTtc: 12_000,
        totalsNetToPay: 12_000,
      });
      expect(invoice.issuedAt?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
      expect(invoice.dueAt?.toISOString()).toBe('2026-07-30T00:00:00.000Z');
      expect(invoice.legalMentions.length).toBeGreaterThan(0);
      expect(invoice.lines).toHaveLength(1);
      expect(invoice.lines[0]).toMatchObject({
        label: 'Intervention à émettre',
        unit: 'heure',
        unitPriceHt: 10_000,
      });
      expect(invoice.lines[0]?.qty.toString()).toBe('1');
      expect(invoice.lines[0]?.vatRate.toString()).toBe('20');
      await assertNoGap(fixture.companyId, 2);
      await assertClosed(fixture);
      await assertSentinelUntouched();
    }, 30_000);

    it('clôture gagnante : IssueInvoice attend puis refuse sans consommer de numéro', async () => {
      const fixture = await seedFixture('close-wins');
      const gate: Gate<number> = {
        acquired: deferred<number>(),
        release: deferred<void>(),
      };
      const gatedCompanies = gateCompanyLock({
        repository: firstPersistence.companies,
        worker: firstWorker,
        companyId: fixture.companyId,
        mode: 'update',
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
        'close-wins:closer',
      );

      const issuePid = deferred<number>();
      const issuePromise = runIssueInvoice({
        worker: secondWorker,
        persistence: secondPersistence,
        fixture,
        onStart: (pid) => issuePid.resolve(pid),
      });
      let blockingError: unknown;
      let observation: BlockingObservation | undefined;
      try {
        const blockedPid = await waitForGateOrFailure(
          issuePid.promise,
          issuePromise,
          'close-wins:issuer-start',
        );
        expect(blockedPid).not.toBe(closerPid);
        observation = await waitUntilBlockedBy({
          admin,
          blockedPid,
          blockerPid: closerPid,
          context: 'close-wins',
          expectedLockSql: 'FOR SHARE',
        });
      } catch (error) {
        blockingError = error;
      } finally {
        gate.release.resolve(undefined);
      }

      const [closed, issued] = await Promise.all([closePromise, issuePromise]);
      if (blockingError) throw blockingError;
      expect(observation?.blockerPids).toEqual([closerPid]);
      expect(closed.ok).toBe(true);
      expect(issued).toEqual({
        ok: false,
        error: {
          kind: 'domain',
          error: {
            code: 'VALIDATION',
            field: 'company',
            message: 'Société introuvable ou clôturée.',
          },
        },
      });

      const invoice = await admin.invoice.findUniqueOrThrow({
        where: { id: fixture.targetInvoiceId },
        include: { lines: true },
      });
      expect(invoice).toMatchObject({
        status: 'draft',
        number: null,
        issuedAt: null,
        dueAt: null,
        totalsHt: 0,
        totalsVat: 0,
        totalsTtc: 0,
        totalsNetToPay: 0,
        legalMentions: [],
      });
      expect(invoice.lines).toHaveLength(1);
      expect(invoice.lines[0]).toMatchObject({
        id: fixture.targetLineId,
        label: 'Intervention à émettre',
        unitPriceHt: 10_000,
      });
      await assertNoGap(fixture.companyId, 1);
      await assertClosed(fixture);
      await assertSentinelUntouched();
    }, 30_000);
  },
);
