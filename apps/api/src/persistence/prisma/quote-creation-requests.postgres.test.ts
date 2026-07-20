import { randomUUID } from 'node:crypto';
import type { CreateQuoteInput, IdGeneratorPort } from '@bob/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuoteCreationCoordinator } from '../../quotes/quote-creation-coordinator';
import { quoteCreationFingerprint } from '../quote-creation-requests';
import { PrismaPersistence } from './prisma-persistence';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_QUOTE_IDEMPOTENCY_CERT === 'true';

describe.skipIf(!RUN_POSTGRES_CERT)('Quote creation idempotency — certification PostgreSQL/RLS réelle', () => {
  const companyId = `quote-idem-cert-${randomUUID()}`;
  const customerId = `quote-idem-customer-${randomUUID()}`;
  const quoteIds = [`quote-cert-${randomUUID()}`, `quote-cert-${randomUUID()}`];
  const lineIds = [`quote-line-cert-${randomUUID()}`, `quote-line-cert-${randomUUID()}`];
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  const now = '2026-07-14T12:00:00.000Z';
  const clock = { now: () => now, today: () => '2026-07-14' };
  let admin: PrismaClient;
  let workers: PrismaService[] = [];

  const input: Omit<CreateQuoteInput, 'companyId'> = {
    customerId,
    idempotencyKey: `mobile-voice:quote:${randomUUID()}`,
    lines: [
      { label: 'Certification idempotence', category: 'labor', qty: 2, unit: 'h', unitPriceHT: 10_000, vatRate: 20 },
    ],
  };

  function ids(quoteId: string, lineId: string): IdGeneratorPort {
    const values = [quoteId, lineId];
    return { newId: () => values.shift() ?? `unexpected-${randomUUID()}` };
  }

  function coordinator(index: number): QuoteCreationCoordinator {
    return new QuoteCreationCoordinator({
      persistence: new PrismaPersistence(workers[index]!),
      ids: ids(quoteIds[index]!, lineIds[index]!),
      clock,
    });
  }

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workers = [
      new PrismaService({ datasourceUrl: runtimeUrl }),
      new PrismaService({ datasourceUrl: runtimeUrl }),
    ];
    await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
    await admin.company.create({
      data: {
        id: companyId,
        name: 'Bob Quote Idempotency PostgreSQL Certification',
        legalForm: 'EI',
        siren: '552100554',
        siret: '55210055400013',
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
        type: 'b2c',
        name: 'Client certification',
        addrLine1: '2 rue de la Certification',
        addrZip: '75001',
        addrCity: 'Paris',
      },
    });
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.quoteCreationRequest.deleteMany({ where: { companyId } }).catch(() => undefined);
      await admin.lineItem.deleteMany({ where: { quoteId: { in: quoteIds } } }).catch(() => undefined);
      await admin.quote.deleteMany({ where: { id: { in: quoteIds } } }).catch(() => undefined);
      await admin.customer.deleteMany({ where: { id: customerId } }).catch(() => undefined);
      await admin.company.deleteMany({ where: { id: companyId } }).catch(() => undefined);
    }
    await Promise.allSettled([
      ...workers.map((worker) => worker.$disconnect()),
      ...(admin ? [admin.$disconnect()] : []),
    ]);
  });

  it('fait converger deux transactions concurrentes, rejoue la réponse et rollback le candidat perdant', async () => {
    const [first, second] = await Promise.all([
      coordinator(0).execute({ companyId, quote: input }),
      coordinator(1).execute({ companyId, quote: input }),
    ]);
    if (!first.ok || !second.ok) {
      throw new Error(`Concurrent PostgreSQL createQuote failed: ${JSON.stringify([first, second])}`);
    }
    expect(second).toEqual(first);
    expect(await admin.quote.count({ where: { id: { in: quoteIds } } })).toBe(1);
    expect(await admin.lineItem.count({ where: { quoteId: { in: quoteIds } } })).toBe(1);

    const replay = await coordinator(0).execute({ companyId, quote: input });
    expect(replay).toEqual(first);
    const conflict = await coordinator(0).execute({
      companyId,
      quote: { ...input, lines: [{ ...input.lines[0]!, unitPriceHT: 10_001 }] },
    });
    expect(conflict).toMatchObject({ ok: false, error: { kind: 'conflict', entity: 'quote_creation' } });
    expect(await admin.quote.count({ where: { id: { in: quoteIds } } })).toBe(1);
  }, 30_000);

  it('certifie FORCE RLS, le stockage sans clé brute et le registre append-only', async () => {
    const fingerprint = quoteCreationFingerprint(companyId, input);
    if (!fingerprint) throw new Error('fixture key required');
    const [role] = await workers[0]!.$queryRaw<Array<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      canUpdate: boolean;
      canDelete: boolean;
    }>>`
      SELECT rolsuper,
             rolbypassrls,
             has_table_privilege(current_user, 'public.quote_creation_requests', 'UPDATE') AS "canUpdate",
             has_table_privilege(current_user, 'public.quote_creation_requests', 'DELETE') AS "canDelete"
        FROM pg_roles
       WHERE rolname = current_user
    `;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, canUpdate: false, canDelete: false });
    const [shape] = await admin.$queryRaw<Array<{ rowSecurity: boolean; forceRowSecurity: boolean }>>`
      SELECT relrowsecurity AS "rowSecurity", relforcerowsecurity AS "forceRowSecurity"
        FROM pg_class WHERE oid = 'quote_creation_requests'::regclass
    `;
    expect(shape).toEqual({ rowSecurity: true, forceRowSecurity: true });
    const columns = await admin.$queryRaw<Array<{ columnName: string }>>`
      SELECT column_name AS "columnName"
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'quote_creation_requests'
    `;
    expect(columns.map((column) => column.columnName)).not.toContain('idempotencyKey');
    expect(await admin.quoteCreationRequest.findUnique({
      where: { quote_creation_request_key: { companyId, keyHash: fingerprint.keyHash } },
    })).toMatchObject({ payloadHash: fingerprint.payloadHash });
    await expect(workers[0]!.withTenant(companyId, (tx) => tx.quoteCreationRequest.update({
      where: { quote_creation_request_key: { companyId, keyHash: fingerprint.keyHash } },
      data: { payloadHash: '0'.repeat(64) },
    }))).rejects.toThrow();
    await expect(workers[0]!.withTenant(companyId, (tx) => tx.quoteCreationRequest.delete({
      where: { quote_creation_request_key: { companyId, keyHash: fingerprint.keyHash } },
    }))).rejects.toThrow();
    await expect(new PrismaPersistence(workers[0]!).runWithTenant(
      'another-tenant',
      () => new PrismaPersistence(workers[0]!).quoteCreationRequests.find({
        companyId: 'another-tenant',
        keyHash: fingerprint.keyHash,
      }),
    )).resolves.toBeNull();
  });
});
