import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  QUOTE_DRAFT_PAYLOAD_SCHEMA,
  QUOTE_DRAFT_PAYLOAD_VERSION,
  type QuoteDraftPayloadV1,
} from '@bob/core';
import { PrismaService } from './prisma.service';
import { PrismaQuoteDraftSlotRepository } from './quote-draft-slots.repository';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_QUOTE_DRAFT_CERT === 'true';

function payload(sessionId: string): QuoteDraftPayloadV1 {
  return {
    schema: QUOTE_DRAFT_PAYLOAD_SCHEMA,
    version: QUOTE_DRAFT_PAYLOAD_VERSION,
    draft: {
      sessionId,
      contentRevision: 1,
      stagingRevision: 0,
      step: 'client',
      customer: null,
      lines: [],
      lineMetadata: [],
      lineForm: { label: '', quantity: '1', unitPrice: '', category: 'labor' },
      vatDecision: null,
      depositPct: 30,
      signMode: null,
    },
  };
}

describe.skipIf(!RUN_POSTGRES_CERT)('QuoteDraftSlot — certification PostgreSQL owner/tenant/CAS', () => {
  const companyA = `quote-draft-a-${randomUUID()}`;
  const companyB = `quote-draft-b-${randomUUID()}`;
  const ownerA = `owner-a-${randomUUID()}`;
  const ownerB = `owner-b-${randomUUID()}`;
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let workerA: PrismaService;
  let workerB: PrismaService;

  function company(id: string, suffix: string) {
    return {
      id,
      name: `Quote draft ${suffix}`,
      legalForm: 'EI' as const,
      siren: `55220${suffix.padStart(4, '0')}`,
      siret: `55220${suffix.padStart(4, '0')}00001`,
      trade: 'autre',
      vatRegime: 'reel_normal' as const,
      addrLine1: '1 rue du Brouillon',
      addrZip: '75001',
      addrCity: 'Paris',
    };
  }

  function asOwner<T>(worker: PrismaService, companyId: string, ownerUserId: string, fn: () => Promise<T>): Promise<T> {
    return worker.withIdentity(ownerUserId, () => worker.withTenant(companyId, fn));
  }

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) throw new Error('DATABASE_URL et DIRECT_URL sont requis.');
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workerA = new PrismaService({ datasourceUrl: runtimeUrl });
    workerB = new PrismaService({ datasourceUrl: runtimeUrl });
    await Promise.all([admin.$connect(), workerA.$connect(), workerB.$connect()]);
    await admin.company.createMany({ data: [company(companyA, '9101'), company(companyB, '9102')] });
  }, 30_000);

  afterEach(async () => {
    if (!admin) return;
    await admin.quoteDraftSlot.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
  });

  afterAll(async () => {
    try {
      if (admin) {
        await admin.quoteDraftSlot.deleteMany({
          where: { companyId: { in: [companyA, companyB] } },
        });
        await admin.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
      }
    } finally {
      await Promise.allSettled([workerA?.$disconnect(), workerB?.$disconnect(), admin?.$disconnect()]);
    }
  });

  it('isole deux propriétaires du même tenant et un propriétaire entre deux tenants', async () => {
    const repoA = new PrismaQuoteDraftSlotRepository(workerA);
    const repoB = new PrismaQuoteDraftSlotRepository(workerB);
    await asOwner(workerA, companyA, ownerA, async () => {
      expect(await repoA.upsert({ companyId: companyA, ownerUserId: ownerA, expectedRevision: 0, payload: payload('a-a') }))
        .toMatchObject({ status: 'created', slot: { revision: 1 } });
    });
    await asOwner(workerB, companyA, ownerB, async () => {
      expect(await repoB.get({ companyId: companyA, ownerUserId: ownerA })).toBeNull();
    });
    // Une violation RLS annule la transaction PostgreSQL courante. Elle doit donc être certifiée
    // dans sa propre transaction, exactement comme une requête HTTP réelle, avant le write valide.
    await expect(
      asOwner(workerB, companyA, ownerB, () =>
        repoB.upsert({
          companyId: companyA,
          ownerUserId: ownerA,
          expectedRevision: 0,
          payload: payload('forged'),
        }),
      ),
    ).rejects.toBeDefined();
    await asOwner(workerB, companyA, ownerB, async () => {
      expect(await repoB.upsert({ companyId: companyA, ownerUserId: ownerB, expectedRevision: 0, payload: payload('a-b') }))
        .toMatchObject({ status: 'created' });
    });
    await asOwner(workerB, companyB, ownerA, async () => {
      expect(await repoB.get({ companyId: companyA, ownerUserId: ownerA })).toBeNull();
      expect(await repoB.upsert({ companyId: companyB, ownerUserId: ownerA, expectedRevision: 0, payload: payload('b-a') }))
        .toMatchObject({ status: 'created' });
    });
  });

  it('refuse création doublée, mise à jour et suppression sur révision périmée', async () => {
    const repo = new PrismaQuoteDraftSlotRepository(workerA);
    await asOwner(workerA, companyA, ownerA, async () => {
      expect(
        await repo.upsert({
          companyId: companyA,
          ownerUserId: ownerA,
          expectedRevision: 0,
          payload: payload('initial'),
        }),
      ).toMatchObject({ status: 'created', slot: { revision: 1 } });
      expect(await repo.upsert({ companyId: companyA, ownerUserId: ownerA, expectedRevision: 0, payload: payload('duplicate') }))
        .toEqual({ status: 'revision_conflict', currentRevision: 1 });
      expect(await repo.upsert({ companyId: companyA, ownerUserId: ownerA, expectedRevision: 1, payload: payload('updated') }))
        .toMatchObject({ status: 'updated', slot: { revision: 2, payload: { draft: { sessionId: 'updated' } } } });
      expect(await repo.upsert({ companyId: companyA, ownerUserId: ownerA, expectedRevision: 1, payload: payload('stale') }))
        .toEqual({ status: 'revision_conflict', currentRevision: 2 });
      expect(await repo.delete({ companyId: companyA, ownerUserId: ownerA, expectedRevision: 1 }))
        .toEqual({ status: 'revision_conflict', currentRevision: 2 });
      expect(await repo.delete({ companyId: companyA, ownerUserId: ownerA, expectedRevision: 2 }))
        .toEqual({ status: 'deleted' });
      expect(await repo.delete({ companyId: companyA, ownerUserId: ownerA, expectedRevision: 2 }))
        .toEqual({ status: 'not_found' });
    });
  });
});
