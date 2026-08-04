import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  CloseAccount,
  CreateDocumentViewLink,
  CreateQuoteSignatureToken,
  type ClockPort,
  type CompanyRepository,
  type DocumentStoragePort,
  type OcrPort,
  type PaymentGatewayPort,
  type PdfRendererPort,
  type UnitOfWorkPort,
} from '@bob/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendService } from '../../backend.service';
import type { SupabaseAdminPort } from '../../auth/supabase-admin';
import type { NotificationDeliveryService } from '../../jobs/notification-delivery.service';
import type { AppLogger } from '../../observability/logger';
import type { Metrics } from '../../observability/metrics';
import {
  generatedQuoteDocumentId,
  generatedQuoteDocumentVersionId,
} from '../../documents/generated-document-ids';
import { openDocumentArchiveRenderSnapshot } from '../../documents/document-archive-render-snapshot';
import type {
  Persistence,
  ServerCompanyRepository,
  ServerPublicAccessTokenRepository,
} from '../persistence';
import { PrismaPersistence } from './prisma-persistence';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_PUBLIC_CAPABILITY_CERT === 'true';
// SIREN dédié à cette suite (Luhn valide). validSiret replie la séquence modulo 10 000 (NIC à
// 4 chiffres) : chaque suite Postgres possède donc son propre SIREN afin qu'aucune collision de
// SIRET inter-suites ne soit possible sur l'unique companies.siret de la base partagée du gate.
const CERT_SIREN = '552100109';
const CERT_COMPANY_ID_PREFIX = 'public-lifecycle-company-';
const CERT_COMPANY_NAME_PREFIX = 'Certification ';
const CERT_CLEANUP_BATCH_SIZE = 32;
const CERT_MAX_STALE_FIXTURES = 96;
const CERT_STALE_RECOVERY_HOOK_TIMEOUT_MS = 180_000;
const CERT_CURRENT_RUN_CLEANUP_HOOK_TIMEOUT_MS = 60_000;
const CERT_ARCHIVE_QUIESCENCE_TIMEOUT_MS = 5_000;
const CERT_ARCHIVE_QUIESCENCE_POLL_MS = 25;
const CERT_ARCHIVE_PARKED_UNTIL = new Date('9999-12-31T23:59:59.999Z');
const CERT_ALLOWED_RELEASE_ENVIRONMENTS = new Set(['development', 'staging']);
const CERT_UUID_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CERT_NOW = new Date().toISOString();
const CLOSE_NOW = new Date(Date.parse(CERT_NOW) + 1_000).toISOString();
const clock: ClockPort = {
  now: () => CERT_NOW,
  today: () => CERT_NOW.slice(0, 10),
};

type CapabilityKind = 'quote_signature' | 'quote_view' | 'invoice_view';

interface Fixture {
  companyId: string;
  companyName: string;
  customerId: string;
  quoteId: string;
  invoiceId: string;
}

interface CertificationFixtureIdentity {
  companyId: string;
  customerId: string;
  quoteId: string;
  invoiceId: string;
  subscriptionId: string;
}

function certificationFixtureIdentity(companyId: string): CertificationFixtureIdentity {
  const suffix = companyId.slice(CERT_COMPANY_ID_PREFIX.length);
  if (!companyId.startsWith(CERT_COMPANY_ID_PREFIX) || !CERT_UUID_SUFFIX.test(suffix)) {
    throw new Error('Public lifecycle certification fixture ID is malformed.');
  }
  return {
    companyId,
    customerId: `public-lifecycle-customer-${suffix}`,
    quoteId: `public-lifecycle-quote-${suffix}`,
    invoiceId: `public-lifecycle-invoice-${suffix}`,
    subscriptionId: `public-lifecycle-subscription-${suffix}`,
  };
}

class CertificationArchiveLeaseActiveError extends Error {}

interface Gate<T> {
  acquired: ReturnType<typeof deferred<T>>;
  release: ReturnType<typeof deferred<void>>;
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
  const rows = await worker.client().$queryRaw<Array<{ pid: number }>>`
    SELECT pg_backend_pid() AS pid
  `;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('PostgreSQL backend PID unavailable.');
  return pid;
}

async function waitUntilBlockedBy(
  admin: PrismaClient,
  blockedPid: number,
  blockerPid: number,
  context: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastObservation: unknown = null;
  while (Date.now() < deadline) {
    const rows = await admin.$queryRaw<
      Array<{
        exactBlocker: boolean;
        waitEventType: string | null;
        waitEvent: string | null;
        blockerPids: number[];
      }>
    >`
      SELECT
        pg_blocking_pids(CAST(${blockedPid} AS integer)) = ARRAY[${blockerPid}]::integer[] AS "exactBlocker",
        wait_event_type AS "waitEventType",
        wait_event AS "waitEvent",
        pg_blocking_pids(CAST(${blockedPid} AS integer)) AS "blockerPids"
      FROM pg_stat_activity
      WHERE pid = ${blockedPid}
    `;
    lastObservation = rows[0] ?? null;
    if (rows[0]?.exactBlocker === true && rows[0].waitEventType === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `${context}: backend ${blockedPid} was not blocked exclusively by ${blockerPid}; ` +
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

function tenantUow(
  worker: PrismaService,
  companyId: string,
  onStart?: (pid: number) => void,
): UnitOfWorkPort {
  return {
    runInTransaction: <T>(fn: () => Promise<T>) =>
      worker.withTenant(companyId, async () => {
        if (onStart) onStart(await backendPid(worker));
        return fn();
      }),
  };
}

function gateCompanyLock(input: {
  repository: ServerCompanyRepository;
  worker: PrismaService;
  companyId: string;
  mode: 'share' | 'update';
  gate: Gate<number>;
}): ServerCompanyRepository {
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
    createIfAbsentOpen: (company) => input.repository.createIfAbsentOpen(company),
    save: (company) => input.repository.save(company),
  };
}

function gateFirstLocator(input: {
  repository: ServerPublicAccessTokenRepository;
  located: ReturnType<typeof deferred<void>>;
  release: ReturnType<typeof deferred<void>>;
}): ServerPublicAccessTokenRepository {
  let armed = true;
  return {
    create: (value) => input.repository.create(value),
    findActive: async (token, at) => {
      const grant = await input.repository.findActive(token, at);
      if (armed) {
        armed = false;
        if (grant === null) throw new Error('Public locator unexpectedly resolved no grant.');
        input.located.resolve(undefined);
        await input.release.promise;
      }
      return grant;
    },
    lockActive: (token, at) => input.repository.lockActive(token, at),
    markUsed: (id, at) => input.repository.markUsed(id, at),
    revoke: (id, at) => input.repository.revoke(id, at),
    revokeActiveFor: (value) => input.repository.revokeActiveFor(value),
    revokeAllForCompany: (value) => input.repository.revokeAllForCompany(value),
  };
}

function persistenceWith(
  base: PrismaPersistence,
  overrides: Partial<Pick<Persistence, 'companies' | 'publicAccessTokens' | 'documentArchiveJobs'>>,
): Persistence {
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

function parkCertificationArchiveJobs(
  repository: Persistence['documentArchiveJobs'],
  worker: PrismaService,
): Persistence['documentArchiveJobs'] {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === 'enqueue') {
        return async (input: Parameters<Persistence['documentArchiveJobs']['enqueue']>[0]) => {
          const identity = certificationFixtureIdentity(input.companyId);
          if (input.pieceId !== identity.quoteId || input.reason !== 'quote-signed') {
            throw new Error('Public lifecycle certification archive enqueue identity is unsafe.');
          }
          if (!worker.inTransaction()) {
            throw new Error(
              'Public lifecycle certification archive enqueue is outside transaction.',
            );
          }
          // Appelle le vrai writer V3 (job + snapshot scellé), puis parque CE job dans la même
          // transaction métier. Un scheduler staging partageant la base ne peut donc jamais voir
          // une fixture due entre le commit de signature et le cleanup du certificat.
          await target.enqueue(input);
          const parked = await worker.client().documentArchiveJob.updateMany({
            where: {
              id: input.id,
              companyId: input.companyId,
              invoiceId: input.pieceId,
              reason: 'quote-signed',
              status: { in: ['pending', 'failed'] },
              integrityProof: { equals: Prisma.DbNull },
              integrityProofSha256: null,
              completedAt: null,
            },
            data: { nextAttemptAt: CERT_ARCHIVE_PARKED_UNTIL },
          });
          if (parked.count !== 1) {
            throw new Error('Public lifecycle certification archive job could not be parked.');
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function makeBackend(persistence: Persistence): {
  service: BackendService;
  effects: { pdf: number; storage: number };
} {
  const effects = { pdf: 0, storage: 0 };
  const pdf: PdfRendererPort = {
    renderInvoice: async () => {
      effects.pdf += 1;
      return new Uint8Array([1]);
    },
    renderQuote: async () => {
      effects.pdf += 1;
      return new Uint8Array([1]);
    },
  };
  const storage: DocumentStoragePort = {
    put: async () => {
      effects.storage += 1;
      throw new Error('Public lifecycle cert must reject before object storage.');
    },
    get: async () => {
      effects.storage += 1;
      throw new Error('Public lifecycle cert must reject before object storage.');
    },
    getSignedUrl: async () => {
      effects.storage += 1;
      throw new Error('Public lifecycle cert must reject before object storage.');
    },
    stat: async () => {
      effects.storage += 1;
      throw new Error('Public lifecycle cert must reject before object storage.');
    },
    remove: async () => {
      effects.storage += 1;
      throw new Error('Public lifecycle cert must reject before object storage.');
    },
  };
  const supabaseAdmin: SupabaseAdminPort = {
    setUserCompanyId: async () => undefined,
    deleteUser: async () => undefined,
  };
  const logger = {
    audit: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    log: () => undefined,
  } as unknown as AppLogger;
  const service = new BackendService(
    persistence,
    {} as PaymentGatewayPort,
    pdf,
    {} as OcrPort,
    supabaseAdmin,
    {} as NotificationDeliveryService,
    {} as Metrics,
    logger,
    undefined,
    storage,
  );
  return { service, effects };
}

async function issueCapability(input: {
  kind: CapabilityKind;
  worker: PrismaService;
  persistence: PrismaPersistence;
  fixture: Fixture;
  companies?: CompanyRepository;
  onStart?: (pid: number) => void;
}) {
  const companies = input.companies ?? input.persistence.companies;
  const uow = tenantUow(input.worker, input.fixture.companyId, input.onStart);
  if (input.kind === 'quote_signature') {
    return new CreateQuoteSignatureToken({
      companies,
      quotes: input.persistence.quotes,
      publicAccessTokens: input.persistence.publicAccessTokens,
      uow,
      clock,
    }).execute({ quoteId: input.fixture.quoteId });
  }
  return new CreateDocumentViewLink({
    companies,
    quotes: input.persistence.quotes,
    invoices: input.persistence.invoices,
    publicAccessTokens: input.persistence.publicAccessTokens,
    uow,
    clock,
  }).execute({
    kind: input.kind === 'quote_view' ? 'quote' : 'invoice',
    id: input.kind === 'quote_view' ? input.fixture.quoteId : input.fixture.invoiceId,
  });
}

async function closeAccount(input: {
  worker: PrismaService;
  persistence: PrismaPersistence;
  fixture: Fixture;
  companies?: CompanyRepository;
  onStart?: (pid: number) => void;
}) {
  return new CloseAccount({
    companies: input.companies ?? input.persistence.companies,
    subscriptions: input.persistence.subscriptions,
    publicAccessTokens: input.persistence.publicAccessTokens,
    uow: tenantUow(input.worker, input.fixture.companyId, input.onStart),
  }).execute({
    companyId: input.fixture.companyId,
    confirmationText: input.fixture.companyName,
    reason: 'certification concurrence capacités publiques',
    now: CLOSE_NOW,
  });
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Capacités publiques — certification PostgreSQL/RLS du fence cycle de vie company',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const companyIds: string[] = [];
    let fixtureSequence =
      10_000 + (parseInt(randomUUID().replaceAll('-', '').slice(0, 8), 16) % 80_000);
    let admin!: PrismaService;
    let firstWorker!: PrismaService;
    let secondWorker!: PrismaService;
    let firstPersistence!: PrismaPersistence;
    let secondPersistence!: PrismaPersistence;
    let sentinelGrantId!: string;

    async function seedFixture(label: string): Promise<Fixture> {
      const id = randomUUID();
      const companyId = `${CERT_COMPANY_ID_PREFIX}${id}`;
      const customerId = `public-lifecycle-customer-${id}`;
      const quoteId = `public-lifecycle-quote-${id}`;
      const invoiceId = `public-lifecycle-invoice-${id}`;
      const companyName = `${CERT_COMPANY_NAME_PREFIX}${label} ${id.slice(0, 8)}`;
      const siret = validSiret(CERT_SIREN, fixtureSequence);
      fixtureSequence += 1;
      await admin.company.create({
        data: {
          id: companyId,
          name: companyName,
          legalForm: 'EI',
          siren: CERT_SIREN,
          siret,
          trade: 'autre',
          vatRegime: 'reel_normal',
          addrLine1: '1 rue de la Certification',
          addrZip: '75001',
          addrCity: 'Paris',
        },
      });
      companyIds.push(companyId);
      await admin.customer.create({
        data: {
          id: customerId,
          companyId,
          type: 'b2b',
          name: 'Client certification lifecycle',
          addrLine1: '2 rue du Client',
          addrZip: '75002',
          addrCity: 'Paris',
        },
      });
      await admin.quote.create({
        data: {
          id: quoteId,
          companyId,
          customerId,
          status: 'sent',
          number: 'D-2099-0001',
          validUntil: new Date('2099-12-31T00:00:00.000Z'),
        },
      });
      await admin.invoice.create({
        data: {
          id: invoiceId,
          companyId,
          customerId,
          kind: 'invoice',
          status: 'issued',
          number: 'F-2099-0001',
          issuedAt: new Date('2099-01-02T00:00:00.000Z'),
        },
      });
      await admin.subscription.create({
        data: {
          id: `public-lifecycle-subscription-${id}`,
          companyId,
          plan: 'business',
          status: 'active',
          store: 'none',
          createdAt: new Date(CERT_NOW),
          updatedAt: new Date(CERT_NOW),
        },
      });
      return { companyId, companyName, customerId, quoteId, invoiceId };
    }

    async function assertClosedWithoutActiveGrant(fixture: Fixture): Promise<void> {
      const company = await admin.company.findUniqueOrThrow({
        where: { id: fixture.companyId },
      });
      expect(company.closedAt?.toISOString()).toBe(CLOSE_NOW);
      expect(
        await admin.publicAccessToken.count({
          where: { companyId: fixture.companyId, revokedAt: null },
        }),
      ).toBe(0);
      expect(
        (
          await admin.subscription.findUniqueOrThrow({
            where: { companyId: fixture.companyId },
          })
        ).status,
      ).toBe('canceled');
      const [quote, invoice, sentinelGrant] = await Promise.all([
        admin.quote.findUnique({ where: { id: fixture.quoteId } }),
        admin.invoice.findUnique({ where: { id: fixture.invoiceId } }),
        admin.publicAccessToken.findUnique({ where: { id: sentinelGrantId } }),
      ]);
      expect(quote).toMatchObject({
        id: fixture.quoteId,
        companyId: fixture.companyId,
      });
      expect(invoice).toMatchObject({
        id: fixture.invoiceId,
        companyId: fixture.companyId,
      });
      expect(sentinelGrant).toMatchObject({
        id: sentinelGrantId,
        revokedAt: null,
      });
    }

    async function cleanupFixtureBatch(companyIdsToDelete: string[]): Promise<void> {
      const where = { companyId: { in: companyIdsToDelete } };
      const fixtureIdentityByCompanyId = new Map(
        companyIdsToDelete.map((companyId) => {
          const identity = certificationFixtureIdentity(companyId);
          return [companyId, identity] as const;
        }),
      );
      const cleanupOnce = () =>
        admin.$transaction(async (tx) => {
          // La découverte stale est volontairement hors transaction, mais elle n'autorise aucune
          // suppression. Revalide ici les trois marqueurs sous verrou de ligne et exige la bijection
          // exacte : une société renommée/requalifiée entre-temps fait échouer la purge.
          const lockedFixtures = await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
            SELECT id
            FROM public.companies
            WHERE id IN (${Prisma.join(companyIdsToDelete)})
              AND id LIKE ${`${CERT_COMPANY_ID_PREFIX}%`}
              AND siren = ${CERT_SIREN}
              AND name LIKE ${`${CERT_COMPANY_NAME_PREFIX}%`}
            ORDER BY id
            FOR UPDATE
          `,
          );
          const expectedIds = [...companyIdsToDelete].sort();
          const lockedIds = lockedFixtures.map(({ id }) => id).sort();
          if (
            lockedIds.length !== expectedIds.length ||
            lockedIds.some((id, i) => id !== expectedIds[i])
          ) {
            throw new Error(
              'Public lifecycle certification fixture identity changed before cleanup.',
            );
          }
          const fixtureIdentities = [...fixtureIdentityByCompanyId.values()];
          const [customers, quotes, invoices, subscriptions, publicAccessTokens] =
            await Promise.all([
              tx.customer.findMany({
                where,
                select: { id: true, companyId: true },
              }),
              tx.quote.findMany({
                where,
                select: { id: true, companyId: true, customerId: true },
              }),
              tx.invoice.findMany({
                where,
                select: { id: true, companyId: true, customerId: true },
              }),
              tx.subscription.findMany({
                where,
                select: { id: true, companyId: true },
              }),
              tx.publicAccessToken.findMany({
                where,
                select: {
                  id: true,
                  companyId: true,
                  resourceType: true,
                  resourceId: true,
                  scope: true,
                },
              }),
            ]);
          const customerById = new Map(customers.map((row) => [row.id, row] as const));
          const quoteById = new Map(quotes.map((row) => [row.id, row] as const));
          const invoiceById = new Map(invoices.map((row) => [row.id, row] as const));
          const subscriptionById = new Map(subscriptions.map((row) => [row.id, row] as const));
          const unsafePublicAccessToken = publicAccessTokens.some((token) => {
            const identity = fixtureIdentityByCompanyId.get(token.companyId);
            if (identity === undefined) return true;
            return !(
              (token.resourceType === 'quote' &&
                token.resourceId === identity.quoteId &&
                (token.scope === 'quote_signature' || token.scope === 'document_view')) ||
              (token.resourceType === 'invoice' &&
                token.resourceId === identity.invoiceId &&
                token.scope === 'document_view')
            );
          });
          if (
            customers.length !== fixtureIdentities.length ||
            quotes.length !== fixtureIdentities.length ||
            invoices.length !== fixtureIdentities.length ||
            subscriptions.length !== fixtureIdentities.length ||
            unsafePublicAccessToken ||
            fixtureIdentities.some((identity) => {
              const customer = customerById.get(identity.customerId);
              const quote = quoteById.get(identity.quoteId);
              const invoice = invoiceById.get(identity.invoiceId);
              const subscription = subscriptionById.get(identity.subscriptionId);
              return (
                customer?.companyId !== identity.companyId ||
                quote?.companyId !== identity.companyId ||
                quote.customerId !== identity.customerId ||
                invoice?.companyId !== identity.companyId ||
                invoice.customerId !== identity.customerId ||
                subscription?.companyId !== identity.companyId
              );
            })
          ) {
            throw new Error('Public lifecycle certification fixture dependency graph is unsafe.');
          }
          // `publicSignQuote` doit rester exercé de bout en bout : la signature gagnante écrit son
          // job + snapshot append-only dans la transaction métier, puis son kick peut préparer une
          // intention avant que le faux Storage refuse l'upload. Verrouille les jobs afin qu'un kick
          // concurrent termine avant l'inspection, puis accepte UNIQUEMENT ce graphe synthétique
          // non matérialisé et déterministe. Une autre archive reste un blocage, jamais une purge.
          const lockedArchiveJobs = await tx.$queryRaw<
            Array<{
              id: string;
              companyId: string;
              pieceId: string;
              reason: string;
              status: string;
              leaseToken: string | null;
              hasTerminalProof: boolean;
            }>
          >(Prisma.sql`
          SELECT id,
                 "companyId" AS "companyId",
                 "invoiceId" AS "pieceId",
                 reason,
                 status::text AS status,
                 "leaseToken" AS "leaseToken",
                 (
                   "integrityProof" IS NOT NULL
                   OR "integrityProofSha256" IS NOT NULL
                   OR "completedAt" IS NOT NULL
                 ) AS "hasTerminalProof"
          FROM public.document_archive_jobs
          WHERE "companyId" IN (${Prisma.join(companyIdsToDelete)})
          ORDER BY id
          FOR UPDATE
        `);
          for (const job of lockedArchiveJobs) {
            const identity = fixtureIdentityByCompanyId.get(job.companyId);
            if (job.leaseToken !== null) {
              throw new CertificationArchiveLeaseActiveError();
            }
            if (
              identity === undefined ||
              job.pieceId !== identity.quoteId ||
              job.reason !== 'quote-signed' ||
              (job.status !== 'pending' && job.status !== 'failed') ||
              job.hasTerminalProof
            ) {
              throw new Error('Public lifecycle certification archive job identity is unsafe.');
            }
          }
          const archiveJobIds = lockedArchiveJobs.map(({ id }) => id);
          const archiveJobById = new Map(lockedArchiveJobs.map((job) => [job.id, job] as const));
          const archiveSnapshots = await tx.documentArchiveRenderSnapshot.findMany({
            where,
            select: {
              jobId: true,
              companyId: true,
              pieceId: true,
              reason: true,
              schemaVersion: true,
              rendererVersion: true,
              payload: true,
              payloadSha256: true,
            },
          });
          if (archiveSnapshots.length !== lockedArchiveJobs.length) {
            throw new Error('Public lifecycle certification archive snapshot identity is unsafe.');
          }
          const archiveSnapshotByJobId = new Map<
            string,
            {
              companyId: string;
              payloadSha256: string;
              artifact: ReturnType<typeof openDocumentArchiveRenderSnapshot>['artifacts'][number];
            }
          >();
          for (const snapshot of archiveSnapshots) {
            const job = archiveJobById.get(snapshot.jobId);
            const identity = fixtureIdentityByCompanyId.get(snapshot.companyId);
            let opened: ReturnType<typeof openDocumentArchiveRenderSnapshot>;
            try {
              opened = openDocumentArchiveRenderSnapshot({
                snapshotSchemaVersion: snapshot.schemaVersion as 1,
                rendererVersion: snapshot.rendererVersion as 1,
                json: snapshot.payload,
                sha256: snapshot.payloadSha256,
              });
            } catch {
              throw new Error(
                'Public lifecycle certification archive snapshot identity is unsafe.',
              );
            }
            const artifact = opened.artifacts[0];
            if (
              job === undefined ||
              identity === undefined ||
              snapshot.companyId !== job.companyId ||
              snapshot.pieceId !== job.pieceId ||
              snapshot.reason !== job.reason ||
              opened.companyId !== job.companyId ||
              opened.pieceId !== identity.quoteId ||
              opened.reason !== 'quote-signed' ||
              opened.artifacts.length !== 1 ||
              artifact === undefined ||
              artifact.kind !== 'signed_quote' ||
              artifact.expectedContentProfile !== 'plain_pdf' ||
              artifact.documentId !==
                generatedQuoteDocumentId(identity.companyId, identity.quoteId, 'signed_quote') ||
              artifact.versionId !==
                generatedQuoteDocumentVersionId(
                  identity.companyId,
                  identity.quoteId,
                  'signed_quote',
                ) ||
              artifact.mimeType !== 'application/pdf' ||
              artifact.linkedEntityType !== 'quote'
            ) {
              throw new Error(
                'Public lifecycle certification archive snapshot identity is unsafe.',
              );
            }
            archiveSnapshotByJobId.set(snapshot.jobId, {
              companyId: snapshot.companyId,
              payloadSha256: snapshot.payloadSha256,
              artifact,
            });
          }
          const archiveIntents = await tx.documentArchiveArtifactIntent.findMany({
            where,
            select: {
              jobId: true,
              companyId: true,
              snapshotSha256: true,
              kind: true,
              contentProfile: true,
              documentId: true,
              versionId: true,
              versionNumber: true,
              filename: true,
              storageKey: true,
              mimeType: true,
              byteSize: true,
              sha256: true,
            },
          });
          const intentJobIds = new Set<string>();
          const intentStorageKeys = new Set<string>();
          for (const intent of archiveIntents) {
            const snapshot = archiveSnapshotByJobId.get(intent.jobId);
            const expectedStorageKey =
              snapshot === undefined
                ? null
                : `companies/${snapshot.companyId}/documents/${intent.documentId}/v1/${intent.sha256}.pdf`;
            if (
              snapshot === undefined ||
              intentJobIds.has(intent.jobId) ||
              intentStorageKeys.has(intent.storageKey) ||
              intent.companyId !== snapshot.companyId ||
              intent.snapshotSha256 !== snapshot.payloadSha256 ||
              intent.kind !== 'signed_quote' ||
              intent.contentProfile !== 'plain_pdf' ||
              intent.documentId !== snapshot.artifact.documentId ||
              intent.versionId !== snapshot.artifact.versionId ||
              intent.versionNumber !== 1 ||
              intent.filename !== snapshot.artifact.filename ||
              intent.storageKey !== expectedStorageKey ||
              intent.mimeType !== 'application/pdf' ||
              !Number.isSafeInteger(intent.byteSize) ||
              intent.byteSize <= 0 ||
              !/^[a-f0-9]{64}$/u.test(intent.sha256)
            ) {
              throw new Error('Public lifecycle certification archive intent identity is unsafe.');
            }
            intentJobIds.add(intent.jobId);
            intentStorageKeys.add(intent.storageKey);
          }
          let storageObjectCount = 0;
          if (intentStorageKeys.size > 0) {
            const storageRows = await tx.$queryRaw<Array<{ objectCount: number }>>(Prisma.sql`
            SELECT count(*)::integer AS "objectCount"
            FROM storage.objects
            WHERE name IN (${Prisma.join([...intentStorageKeys])})
          `);
            if (storageRows.length !== 1 || !Number.isSafeInteger(storageRows[0]?.objectCount)) {
              throw new Error('Public lifecycle certification Storage proof is unavailable.');
            }
            storageObjectCount = storageRows[0]!.objectCount;
          }
          const [
            archiveArtifacts,
            materializedDocuments,
            materializedVersions,
            materializedAttestations,
          ] = await Promise.all([
            tx.documentArchiveJobArtifact.count({ where }),
            tx.storedDocument.count({ where }),
            tx.storedDocumentVersion.count({
              where: { document: { companyId: { in: companyIdsToDelete } } },
            }),
            tx.documentInvoicePdfAttestation.count({ where }),
          ]);
          if (
            archiveArtifacts !== 0 ||
            materializedDocuments !== 0 ||
            materializedVersions !== 0 ||
            materializedAttestations !== 0 ||
            storageObjectCount !== 0
          ) {
            throw new Error('Public lifecycle certification archive is materially persisted.');
          }
          if (archiveJobIds.length > 0) {
            // Les deux enfants sont append-only. `replica` est local à cette transaction et n'est
            // utilisé qu'après preuve exacte du graphe ; retour à `origin` AVANT le parent/job.
            await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
            const deletedArchiveIntents = await tx.documentArchiveArtifactIntent.deleteMany({
              where: { jobId: { in: archiveJobIds } },
            });
            const deletedArchiveSnapshots = await tx.documentArchiveRenderSnapshot.deleteMany({
              where: { jobId: { in: archiveJobIds } },
            });
            await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
            if (
              deletedArchiveIntents.count !== archiveIntents.length ||
              deletedArchiveSnapshots.count !== archiveSnapshots.length
            ) {
              throw new Error('Public lifecycle certification archive cleanup is incomplete.');
            }
            const deletedArchiveJobs = await tx.documentArchiveJob.deleteMany({
              where: { id: { in: archiveJobIds }, companyId: { in: companyIdsToDelete } },
            });
            if (deletedArchiveJobs.count !== archiveJobIds.length) {
              throw new Error('Public lifecycle certification archive cleanup is incomplete.');
            }
          }
          const [remainingArchiveIntents, remainingArchiveSnapshots, remainingArchiveJobs] =
            await Promise.all([
              tx.documentArchiveArtifactIntent.count({ where }),
              tx.documentArchiveRenderSnapshot.count({ where }),
              tx.documentArchiveJob.count({ where }),
            ]);
          if (
            remainingArchiveIntents !== 0 ||
            remainingArchiveSnapshots !== 0 ||
            remainingArchiveJobs !== 0
          ) {
            throw new Error('Public lifecycle certification archive cleanup is incomplete.');
          }
          // La plupart des fixtures ont été clôturées par CloseAccount : les triggers légaux
          // interdisent alors réouverture (companies_closure_monotonicity) comme hard-delete
          // (companies_closed_delete_fence). Réouverture technique locale des seules fixtures :
          // neutralise ces triggers le temps du seul updateMany, puis les réactive AVANT les
          // DELETE. Aucune erreur n'est avalée : toute future dépendance oubliée doit faire
          // échouer le gate au lieu de fuir des sociétés dans la base partagée des suites.
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
          const reopenedCompanies = await tx.company.updateMany({
            where: { id: { in: companyIdsToDelete } },
            data: { closedAt: null, closureReason: null },
          });
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
          const deletedPublicAccessTokens = await tx.publicAccessToken.deleteMany({ where });
          const deletedSubscriptions = await tx.subscription.deleteMany({ where });
          const deletedInvoices = await tx.invoice.deleteMany({ where });
          const deletedQuotes = await tx.quote.deleteMany({ where });
          const deletedCustomers = await tx.customer.deleteMany({ where });
          const deletedCompanies = await tx.company.deleteMany({
            where: { id: { in: companyIdsToDelete } },
          });
          if (
            reopenedCompanies.count !== fixtureIdentities.length ||
            deletedPublicAccessTokens.count !== publicAccessTokens.length ||
            deletedSubscriptions.count !== subscriptions.length ||
            deletedInvoices.count !== invoices.length ||
            deletedQuotes.count !== quotes.length ||
            deletedCustomers.count !== customers.length ||
            deletedCompanies.count !== fixtureIdentities.length
          ) {
            throw new Error('Public lifecycle certification fixture cleanup is incomplete.');
          }
        });
      const quiescenceDeadline = Date.now() + CERT_ARCHIVE_QUIESCENCE_TIMEOUT_MS;
      for (;;) {
        try {
          await cleanupOnce();
          return;
        } catch (error) {
          if (!(error instanceof CertificationArchiveLeaseActiveError)) throw error;
          if (Date.now() >= quiescenceDeadline) {
            throw new Error(
              'Public lifecycle certification archive lease did not quiesce before cleanup.',
            );
          }
          await new Promise((resolve) => setTimeout(resolve, CERT_ARCHIVE_QUIESCENCE_POLL_MS));
        }
      }
    }

    async function cleanupFixtures(ids: readonly string[]): Promise<void> {
      const companyIdsToDelete = [...new Set(ids)];
      if (companyIdsToDelete.length === 0) return;
      for (let offset = 0; offset < companyIdsToDelete.length; offset += CERT_CLEANUP_BATCH_SIZE) {
        await cleanupFixtureBatch(
          companyIdsToDelete.slice(offset, offset + CERT_CLEANUP_BATCH_SIZE),
        );
      }
      const remainingCompanies = await admin.company.count({
        where: { id: { in: companyIdsToDelete } },
      });
      if (remainingCompanies !== 0) {
        throw new Error('Public lifecycle certification fixture cleanup is incomplete.');
      }
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
      }
      if (!CERT_ALLOWED_RELEASE_ENVIRONMENTS.has(process.env.CABINET_RELEASE_ENV ?? '')) {
        throw new Error(
          'Public lifecycle PostgreSQL certification is restricted to development and staging.',
        );
      }
      // Le cleanup admin utilise lui aussi une transaction interactive. PrismaService applique le
      // timeout WAN borné du rituel (`PRISMA_TRANSACTION_TIMEOUT_MS`) ; un PrismaClient brut
      // retomberait au défaut de 5 s et pourrait expirer après des tests métier pourtant verts.
      admin = new PrismaService({ datasourceUrl: directUrl });
      firstWorker = new PrismaService({ datasourceUrl: runtimeUrl });
      secondWorker = new PrismaService({ datasourceUrl: runtimeUrl });
      firstPersistence = new PrismaPersistence(firstWorker);
      secondPersistence = new PrismaPersistence(secondWorker);
      await Promise.all([admin.$connect(), firstWorker.$connect(), secondWorker.$connect()]);
      // Une interruption de processus peut empêcher afterAll. La suite récupère uniquement ses
      // fixtures réservées, sous trois marqueurs concordants, avant d'allouer de nouveaux SIRET.
      const staleFixtures = await admin.company.findMany({
        where: {
          id: { startsWith: CERT_COMPANY_ID_PREFIX },
          siren: CERT_SIREN,
          name: { startsWith: CERT_COMPANY_NAME_PREFIX },
        },
        select: { id: true },
        take: CERT_MAX_STALE_FIXTURES + 1,
      });
      if (staleFixtures.length > CERT_MAX_STALE_FIXTURES) {
        throw new Error(
          `Public lifecycle certification stale fixture limit exceeded (${CERT_MAX_STALE_FIXTURES}).`,
        );
      }
      await cleanupFixtures(staleFixtures.map(({ id }) => id));
      const sentinel = await seedFixture('sentinel-second-tenant');
      const issuedSentinel = await issueCapability({
        kind: 'quote_view',
        worker: firstWorker,
        persistence: firstPersistence,
        fixture: sentinel,
      });
      if (!issuedSentinel.ok) {
        throw new Error('Second-tenant sentinel capability could not be issued.');
      }
      sentinelGrantId = (
        await admin.publicAccessToken.findFirstOrThrow({
          where: { companyId: sentinel.companyId, revokedAt: null },
        })
      ).id;
    }, CERT_STALE_RECOVERY_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (admin) await cleanupFixtures(companyIds);
      } finally {
        await Promise.allSettled([
          firstWorker?.$disconnect(),
          secondWorker?.$disconnect(),
          admin?.$disconnect(),
        ]);
      }
    }, CERT_CURRENT_RUN_CLEANUP_HOOK_TIMEOUT_MS);

    it('exécute sous un rôle runtime sans superuser/bypass RLS et FORCE RLS sur les quatre tables critiques', async () => {
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
          AND class.relname IN ('companies', 'quotes', 'invoices', 'public_access_tokens')
        ORDER BY class.relname
      `;
      expect(rlsRows).toEqual([
        { tableName: 'companies', enabled: true, forced: true },
        { tableName: 'invoices', enabled: true, forced: true },
        { tableName: 'public_access_tokens', enabled: true, forced: true },
        { tableName: 'quotes', enabled: true, forced: true },
      ]);
    });

    it('refuse explicitement chaque verrou de sécurité appelé hors transaction', async () => {
      await expect(firstPersistence.companies.lockById('outside-transaction')).rejects.toThrow(
        'Company lifecycle exclusive lock requires an active transaction.',
      );
      await expect(
        firstPersistence.companies.lockForShareById('outside-transaction'),
      ).rejects.toThrow('Company lifecycle shared lock requires an active transaction.');
      await expect(firstPersistence.quotes.lockForShareById('outside-transaction')).rejects.toThrow(
        'Quote public read lock requires an active transaction.',
      );
      await expect(
        firstPersistence.invoices.lockForShareById('outside-transaction'),
      ).rejects.toThrow('Invoice public read lock requires an active transaction.');
      await expect(
        firstPersistence.publicAccessTokens.lockActive('outside-transaction', CERT_NOW),
      ).rejects.toThrow('Public access token use lock requires an active transaction.');
    });

    it.each([
      { label: 'lien de signature devis', kind: 'quote_signature' as const },
      { label: 'vue publique devis', kind: 'quote_view' as const },
      { label: 'vue publique facture', kind: 'invoice_view' as const },
    ])(
      'émission gagnante — $label : la clôture attend puis révoque le grant créé',
      async ({ label, kind }) => {
        const fixture = await seedFixture(`issue-wins-${label}`);
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
        const issuePromise = issueCapability({
          kind,
          worker: firstWorker,
          persistence: firstPersistence,
          fixture,
          companies: gatedCompanies,
        });
        const issuerPid = await waitForGateOrFailure(
          gate.acquired.promise,
          issuePromise,
          `issue-wins:${kind}`,
        );

        const closePid = deferred<number>();
        const closePromise = closeAccount({
          worker: secondWorker,
          persistence: secondPersistence,
          fixture,
          onStart: (pid) => closePid.resolve(pid),
        });
        let blockingError: unknown;
        try {
          await waitUntilBlockedBy(admin, await closePid.promise, issuerPid, `issue-wins:${kind}`);
        } catch (error) {
          blockingError = error;
        } finally {
          gate.release.resolve(undefined);
        }

        const [issued, closed] = await Promise.all([issuePromise, closePromise]);
        if (blockingError) throw blockingError;
        expect(issued.ok).toBe(true);
        expect(closed.ok).toBe(true);
        expect(
          await admin.publicAccessToken.count({
            where: { companyId: fixture.companyId },
          }),
        ).toBe(1);
        await assertClosedWithoutActiveGrant(fixture);
      },
      30_000,
    );

    it.each([
      { label: 'lien de signature devis', kind: 'quote_signature' as const },
      { label: 'vue publique devis', kind: 'quote_view' as const },
      { label: 'vue publique facture', kind: 'invoice_view' as const },
    ])(
      'clôture gagnante — $label : l’émission attend puis refuse la société clôturée',
      async ({ label, kind }) => {
        const fixture = await seedFixture(`close-wins-${label}`);
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
        const closePromise = closeAccount({
          worker: firstWorker,
          persistence: firstPersistence,
          fixture,
          companies: gatedCompanies,
        });
        const closerPid = await waitForGateOrFailure(
          gate.acquired.promise,
          closePromise,
          `close-wins:${kind}`,
        );

        const issuerPid = deferred<number>();
        const issuePromise = issueCapability({
          kind,
          worker: secondWorker,
          persistence: secondPersistence,
          fixture,
          onStart: (pid) => issuerPid.resolve(pid),
        });
        let blockingError: unknown;
        try {
          await waitUntilBlockedBy(admin, await issuerPid.promise, closerPid, `close-wins:${kind}`);
        } catch (error) {
          blockingError = error;
        } finally {
          gate.release.resolve(undefined);
        }

        const [closed, issued] = await Promise.all([closePromise, issuePromise]);
        if (blockingError) throw blockingError;
        expect(closed.ok).toBe(true);
        expect(issued.ok).toBe(false);
        if (!issued.ok) expect(issued.error.kind).toBe('forbidden');
        expect(
          await admin.publicAccessToken.count({
            where: { companyId: fixture.companyId },
          }),
        ).toBe(0);
        await assertClosedWithoutActiveGrant(fixture);
      },
      30_000,
    );

    it.each([
      {
        label: 'GET signature',
        capability: 'quote_signature' as const,
        errorEntity: 'public-signature-token',
        invoke: (service: BackendService, token: string) => service.publicQuoteForSignature(token),
      },
      {
        label: 'GET devis',
        capability: 'quote_view' as const,
        errorEntity: 'public-document-view-token',
        invoke: (service: BackendService, token: string) => service.publicDocumentView(token),
      },
      {
        label: 'GET facture',
        capability: 'invoice_view' as const,
        errorEntity: 'public-document-view-token',
        invoke: (service: BackendService, token: string) => service.publicDocumentView(token),
      },
      {
        label: 'PDF devis',
        capability: 'quote_view' as const,
        errorEntity: 'public-document-view-token',
        invoke: (service: BackendService, token: string) => service.publicDocumentPdf(token),
      },
      {
        label: 'PDF facture',
        capability: 'invoice_view' as const,
        errorEntity: 'public-document-view-token',
        invoke: (service: BackendService, token: string) => service.publicDocumentPdf(token),
      },
      {
        label: 'POST signature',
        capability: 'quote_signature' as const,
        errorEntity: 'public-signature-token',
        invoke: (service: BackendService, token: string) =>
          service.publicSignQuote(token, 'Client après clôture'),
      },
    ])(
      'locator périmé — $label : la clôture commitée avant revalidation produit un 404 opaque sans effet',
      async ({ label, capability, errorEntity, invoke }) => {
        const fixture = await seedFixture(`stale-locator-${label}`);
        const issued = await issueCapability({
          kind: capability,
          worker: firstWorker,
          persistence: firstPersistence,
          fixture,
        });
        if (!issued.ok) throw new Error(`Capability fixture failed: ${capability}`);
        const grantBefore = await admin.publicAccessToken.findFirstOrThrow({
          where: { companyId: fixture.companyId, revokedAt: null },
        });
        expect(grantBefore.lastUsedAt).toBeNull();

        const located = deferred<void>();
        const releaseLocator = deferred<void>();
        const gatedTokens = gateFirstLocator({
          repository: firstPersistence.publicAccessTokens,
          located,
          release: releaseLocator,
        });
        const publicPersistence = persistenceWith(firstPersistence, {
          publicAccessTokens: gatedTokens,
        });
        const { service, effects } = makeBackend(publicPersistence);
        const publicPromise = invoke(service, issued.value.token);
        await waitForGateOrFailure(located.promise, publicPromise, `stale-locator:${label}`);
        let closed;
        try {
          closed = await closeAccount({
            worker: secondWorker,
            persistence: secondPersistence,
            fixture,
          });
        } finally {
          releaseLocator.resolve(undefined);
        }
        expect(closed?.ok).toBe(true);

        const result = await publicPromise;
        expect(result).toEqual({
          ok: false,
          error: { kind: 'not_found', entity: errorEntity, id: 'redacted' },
        });
        const grantAfter = await admin.publicAccessToken.findUniqueOrThrow({
          where: { id: grantBefore.id },
        });
        expect(grantAfter.lastUsedAt).toBeNull();
        expect(grantAfter.revokedAt).not.toBeNull();
        expect(effects).toEqual({ pdf: 0, storage: 0 });
        if (label === 'POST signature') {
          const quote = await admin.quote.findUniqueOrThrow({
            where: { id: fixture.quoteId },
          });
          expect(quote.status).toBe('sent');
          expect(quote.signerName).toBeNull();
          expect(quote.signedAt).toBeNull();
        }
        await assertClosedWithoutActiveGrant(fixture);
      },
      30_000,
    );

    it('signature gagnante : la clôture attend le verrou partagé company, puis coupe tous les grants', async () => {
      const fixture = await seedFixture('signature-wins');
      const issued = await issueCapability({
        kind: 'quote_signature',
        worker: firstWorker,
        persistence: firstPersistence,
        fixture,
      });
      if (!issued.ok) throw new Error('Signature capability fixture failed.');

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
      const publicPersistence = persistenceWith(firstPersistence, {
        companies: gatedCompanies,
        documentArchiveJobs: parkCertificationArchiveJobs(
          firstPersistence.documentArchiveJobs,
          firstWorker,
        ),
      });
      const { service } = makeBackend(publicPersistence);
      const signPromise = service.publicSignQuote(issued.value.token, 'Client certification');
      const signerPid = await waitForGateOrFailure(
        gate.acquired.promise,
        signPromise,
        'signature-wins',
      );

      const closePid = deferred<number>();
      const closePromise = closeAccount({
        worker: secondWorker,
        persistence: secondPersistence,
        fixture,
        onStart: (pid) => closePid.resolve(pid),
      });
      let blockingError: unknown;
      try {
        await waitUntilBlockedBy(admin, await closePid.promise, signerPid, 'signature-wins');
      } catch (error) {
        blockingError = error;
      } finally {
        gate.release.resolve(undefined);
      }

      const [signed, closed] = await Promise.all([signPromise, closePromise]);
      if (blockingError) throw blockingError;
      // La signature expose désormais explicitement l'éventuelle capacité de rétractation.
      // Cette fixture B2B ne doit jamais en fabriquer une : `null` fait partie du contrat.
      expect(signed).toEqual({
        ok: true,
        value: { status: 'signed', retractation: null },
      });
      expect(closed.ok).toBe(true);
      const quote = await admin.quote.findUniqueOrThrow({
        where: { id: fixture.quoteId },
      });
      expect(quote.status).toBe('signed');
      expect(quote.signerName).toBe('Client certification');
      expect(quote.signedAt).not.toBeNull();
      await assertClosedWithoutActiveGrant(fixture);
    }, 30_000);
  },
);
