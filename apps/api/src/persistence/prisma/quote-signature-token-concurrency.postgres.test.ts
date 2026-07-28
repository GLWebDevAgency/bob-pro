import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  CreateQuoteSignatureToken,
  SignQuote,
  type ClockPort,
  type QuoteRepository,
  type UnitOfWorkPort,
} from '@bob/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from './prisma.service';
import {
  PrismaCompanyRepository,
  PrismaCustomerRepository,
  PrismaPublicAccessTokenRepository,
  PrismaQuoteRepository,
} from './repositories';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_QUOTE_SIGNATURE_CERT === 'true';
// SIREN dédié à cette suite (Luhn valide). validSiret replie la séquence modulo 10 000 (NIC à
// 4 chiffres) : chaque suite Postgres possède donc son propre SIREN afin qu'aucune collision de
// SIRET inter-suites ne soit possible sur l'unique companies.siret de la base partagée du gate.
const CERT_SIREN = '552100117';
const NOW = '2026-07-18T10:00:00.000Z';
const clock: ClockPort = { now: () => NOW, today: () => '2026-07-18' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function awaitGateOrFail<T>(
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

async function backendPid(worker: PrismaService): Promise<number> {
  const rows = await worker.client().$queryRaw<
    Array<{ pid: number }>
  >`SELECT pg_backend_pid() AS pid`;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('PostgreSQL backend PID unavailable.');
  return pid;
}

async function waitUntilBlocked(
  admin: PrismaClient,
  pid: number,
  expectedBlockerPid: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const rows = await admin.$queryRaw<Array<{ blocked: boolean }>>`
      SELECT CAST(${expectedBlockerPid} AS integer) = ANY(
        pg_blocking_pids(CAST(${pid} AS integer))
      ) AS blocked
    `;
    if (rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Backend ${pid} did not become blocked on the quote row lock.`);
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'CreateQuoteSignatureToken — certification PostgreSQL des entrelacements R4',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const companyId = `r4-token-company-${randomUUID()}`;
    const customerId = `r4-token-customer-${randomUUID()}`;
    const quoteIds: string[] = [];
    let admin: PrismaClient;
    let firstWorker: PrismaService;
    let secondWorker: PrismaService;

    function tenantUow(worker: PrismaService, onPid?: (pid: number) => void): UnitOfWorkPort {
      return {
        runInTransaction: <T>(fn: () => Promise<T>) =>
          worker.withTenant(companyId, async () => {
            if (onPid) onPid(await backendPid(worker));
            return fn();
          }),
      };
    }

    function gateRealQuoteLock(input: {
      repository: QuoteRepository;
      worker: PrismaService;
      quoteId: string;
      acquired: ReturnType<typeof deferred<number>>;
      release: ReturnType<typeof deferred<void>>;
    }): QuoteRepository {
      return {
        findById: (id) => input.repository.findById(id),
        lockById: async (id) => {
          const quote = await input.repository.lockById(id);
          if (id === input.quoteId) {
            input.acquired.resolve(await backendPid(input.worker));
            await input.release.promise;
          }
          return quote;
        },
        listByCompany: (companyId) => input.repository.listByCompany(companyId),
        save: (quote) => input.repository.save(quote),
      };
    }

    async function seedSentQuote(sequence: number): Promise<string> {
      const id = `r4-token-quote-${randomUUID()}`;
      quoteIds.push(id);
      await admin.quote.create({
        data: {
          id,
          companyId,
          customerId,
          status: 'sent',
          number: `D-2026-${String(sequence).padStart(4, '0')}`,
          validUntil: new Date('2026-08-31T00:00:00.000Z'),
        },
      });
      return id;
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      firstWorker = new PrismaService({ datasourceUrl: runtimeUrl });
      secondWorker = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([admin.$connect(), firstWorker.$connect(), secondWorker.$connect()]);

      const establishmentSequence =
        parseInt(randomUUID().replaceAll('-', '').slice(0, 8), 16) % 100_000;
      await admin.company.create({
        data: {
          id: companyId,
          name: 'Certification R4',
          legalForm: 'EI',
          siren: CERT_SIREN,
          siret: validSiret(CERT_SIREN, establishmentSequence),
          trade: 'autre',
          vatRegime: 'reel_normal',
          addrLine1: '1 rue de la Certification',
          addrZip: '75001',
          addrCity: 'Paris',
        },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          companyId,
          type: 'b2b',
          name: 'Client certification R4',
          addrLine1: '2 rue du Client',
          addrZip: '75002',
          addrCity: 'Paris',
        },
      });
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin) {
          // Aucun CloseAccount dans cette suite : triggers et FK restent actifs pendant tout le
          // cleanup, et aucune erreur n'est avalée — toute dépendance oubliée doit faire échouer
          // le gate au lieu de fuir des fixtures dans la base partagée des suites.
          await admin.$transaction(async (tx) => {
            await tx.publicAccessToken.deleteMany({ where: { companyId } });
            await tx.quote.deleteMany({ where: { id: { in: quoteIds } } });
            await tx.customer.deleteMany({ where: { id: customerId } });
            await tx.company.deleteMany({ where: { id: companyId } });
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

    it('une signature gagnante bloque la rotation, qui relit signed et ne ressuscite aucun lien', async () => {
      const quoteId = await seedSentQuote(9101);
      const signQuotes = new PrismaQuoteRepository(firstWorker);
      const signCompanies = new PrismaCompanyRepository(firstWorker);
      const signTokens = new PrismaPublicAccessTokenRepository(firstWorker);
      const rotateQuotes = new PrismaQuoteRepository(secondWorker);
      const rotateCompanies = new PrismaCompanyRepository(secondWorker);
      const rotateTokens = new PrismaPublicAccessTokenRepository(secondWorker);

      const initial = await new CreateQuoteSignatureToken({
        companies: signCompanies,
        quotes: signQuotes,
        publicAccessTokens: signTokens,
        uow: tenantUow(firstWorker),
        clock,
      }).execute({ quoteId });
      expect(initial.ok).toBe(true);

      const signLocked = deferred<number>();
      const releaseSign = deferred<void>();
      const gatedSignQuotes = gateRealQuoteLock({
        repository: signQuotes,
        worker: firstWorker,
        quoteId,
        acquired: signLocked,
        release: releaseSign,
      });
      const signPromise = firstWorker.withTenant(companyId, async () => {
        return new SignQuote({
          companies: signCompanies,
          customers: new PrismaCustomerRepository(firstWorker),
          quotes: gatedSignQuotes,
          publicAccessTokens: signTokens,
          uow: firstWorker,
          clock,
        }).execute({ quoteId, signerName: 'Client R4' });
      });
      const signPid = await awaitGateOrFail(signLocked.promise, signPromise, 'signature gagnante');

      const rotationPid = deferred<number>();
      const rotationPromise = new CreateQuoteSignatureToken({
        companies: rotateCompanies,
        quotes: rotateQuotes,
        publicAccessTokens: rotateTokens,
        uow: tenantUow(secondWorker, (pid) => rotationPid.resolve(pid)),
        clock,
      }).execute({ quoteId });
      let blockingError: unknown;
      try {
        await waitUntilBlocked(admin, await rotationPid.promise, signPid);
      } catch (error) {
        blockingError = error;
      } finally {
        releaseSign.resolve(undefined);
      }
      const [signed, rotated] = await Promise.all([signPromise, rotationPromise]);
      if (blockingError) throw blockingError;
      expect(signed.ok).toBe(true);
      expect(rotated.ok).toBe(false);
      if (!rotated.ok) {
        expect(rotated.error).toMatchObject({
          kind: 'domain',
          error: { code: 'INVALID_TRANSITION', from: 'signed', to: 'signed' },
        });
      }
      expect((await admin.quote.findUniqueOrThrow({ where: { id: quoteId } })).status).toBe(
        'signed',
      );
      expect(
        await admin.publicAccessToken.count({
          where: {
            companyId,
            resourceType: 'quote',
            resourceId: quoteId,
            scope: 'quote_signature',
            revokedAt: null,
          },
        }),
      ).toBe(0);
    }, 30_000);

    it('deux rotations attendent le même verrou et ne laissent qu’un seul grant actif', async () => {
      const quoteId = await seedSentQuote(9102);
      const firstQuotes = new PrismaQuoteRepository(firstWorker);
      const firstCompanies = new PrismaCompanyRepository(firstWorker);
      const firstTokens = new PrismaPublicAccessTokenRepository(firstWorker);
      const secondQuotes = new PrismaQuoteRepository(secondWorker);
      const secondCompanies = new PrismaCompanyRepository(secondWorker);
      const secondTokens = new PrismaPublicAccessTokenRepository(secondWorker);
      const firstLocked = deferred<number>();
      const releaseFirst = deferred<void>();
      const gatedFirstQuotes = gateRealQuoteLock({
        repository: firstQuotes,
        worker: firstWorker,
        quoteId,
        acquired: firstLocked,
        release: releaseFirst,
      });
      const firstPromise = new CreateQuoteSignatureToken({
        companies: firstCompanies,
        quotes: gatedFirstQuotes,
        publicAccessTokens: firstTokens,
        uow: tenantUow(firstWorker),
        clock,
      }).execute({ quoteId });
      const firstPid = await awaitGateOrFail(
        firstLocked.promise,
        firstPromise,
        'première rotation',
      );

      const secondPid = deferred<number>();
      const secondPromise = new CreateQuoteSignatureToken({
        companies: secondCompanies,
        quotes: secondQuotes,
        publicAccessTokens: secondTokens,
        uow: tenantUow(secondWorker, (pid) => secondPid.resolve(pid)),
        clock,
      }).execute({ quoteId });
      let blockingError: unknown;
      try {
        await waitUntilBlocked(admin, await secondPid.promise, firstPid);
      } catch (error) {
        blockingError = error;
      } finally {
        releaseFirst.resolve(undefined);
      }
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      if (blockingError) throw blockingError;
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error('Both serialized rotations must succeed.');
      expect(first.value.token).not.toBe(second.value.token);
      expect(await firstTokens.findActive(first.value.token, NOW)).toBeNull();
      expect(await secondTokens.findActive(second.value.token, NOW)).not.toBeNull();
      expect(
        await admin.publicAccessToken.count({
          where: {
            companyId,
            resourceType: 'quote',
            resourceId: quoteId,
            scope: 'quote_signature',
            revokedAt: null,
          },
        }),
      ).toBe(1);
    }, 30_000);

    it('une rotation gagnante est suivie par la signature, qui révoque le nouveau lien', async () => {
      const quoteId = await seedSentQuote(9103);
      const rotateQuotes = new PrismaQuoteRepository(firstWorker);
      const rotateCompanies = new PrismaCompanyRepository(firstWorker);
      const rotateTokens = new PrismaPublicAccessTokenRepository(firstWorker);
      const signQuotes = new PrismaQuoteRepository(secondWorker);
      const signCompanies = new PrismaCompanyRepository(secondWorker);
      const signTokens = new PrismaPublicAccessTokenRepository(secondWorker);
      const rotationLocked = deferred<number>();
      const releaseRotation = deferred<void>();
      const gatedRotateQuotes = gateRealQuoteLock({
        repository: rotateQuotes,
        worker: firstWorker,
        quoteId,
        acquired: rotationLocked,
        release: releaseRotation,
      });
      const rotationPromise = new CreateQuoteSignatureToken({
        companies: rotateCompanies,
        quotes: gatedRotateQuotes,
        publicAccessTokens: rotateTokens,
        uow: tenantUow(firstWorker),
        clock,
      }).execute({ quoteId });
      const rotationPid = await awaitGateOrFail(
        rotationLocked.promise,
        rotationPromise,
        'rotation gagnante',
      );

      const signingPid = deferred<number>();
      const signPromise = secondWorker.withTenant(companyId, async () => {
        signingPid.resolve(await backendPid(secondWorker));
        return new SignQuote({
          companies: signCompanies,
          customers: new PrismaCustomerRepository(secondWorker),
          quotes: signQuotes,
          publicAccessTokens: signTokens,
          uow: secondWorker,
          clock,
        }).execute({ quoteId, signerName: 'Client R4 inverse' });
      });
      let blockingError: unknown;
      try {
        await waitUntilBlocked(admin, await signingPid.promise, rotationPid);
      } catch (error) {
        blockingError = error;
      } finally {
        releaseRotation.resolve(undefined);
      }
      const [rotated, signed] = await Promise.all([rotationPromise, signPromise]);
      if (blockingError) throw blockingError;
      expect(rotated.ok && signed.ok).toBe(true);
      if (!rotated.ok || !signed.ok)
        throw new Error('Serialized rotation and signature must succeed.');
      expect(signed.value.status).toBe('signed');
      expect(await rotateTokens.findActive(rotated.value.token, NOW)).toBeNull();
      expect(
        await admin.publicAccessToken.count({
          where: {
            companyId,
            resourceType: 'quote',
            resourceId: quoteId,
            scope: 'quote_signature',
            revokedAt: null,
          },
        }),
      ).toBe(0);
    }, 30_000);
  },
);
