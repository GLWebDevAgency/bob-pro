import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chantier, type CatalogueItemRecord } from '@bob/core';
import {
  PrismaCatalogueRepository,
  PrismaChantierRepository,
} from './catalogue-chantiers.repository';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_CATALOGUE_CERT === 'true';

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Catalogue/Chantiers — certification PostgreSQL tenantée',
  () => {
    const companyA = `catalogue-cert-a-${randomUUID()}`;
    const companyB = `catalogue-cert-b-${randomUUID()}`;
    const customerA = `catalogue-customer-a-${randomUUID()}`;
    const customerB = `catalogue-customer-b-${randomUUID()}`;
    const itemA = randomUUID();
    const itemB = randomUUID();
    const chantierA = randomUUID();
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';

    let admin: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;

    function company(id: string, suffix: string) {
      return {
        id,
        name: `Certification ${suffix}`,
        legalForm: 'EI' as const,
        siren: `55210${suffix.padStart(4, '0')}`,
        siret: `55210${suffix.padStart(4, '0')}00001`,
        trade: 'autre',
        vatRegime: 'reel_normal' as const,
        addrLine1: '1 rue de la Certification',
        addrZip: '75001',
        addrCity: 'Paris',
      };
    }

    function item(id: string, companyId: string, label: string): CatalogueItemRecord {
      const now = '2026-07-17T10:00:00.000Z';
      return {
        id,
        companyId,
        label,
        category: 'labor',
        unit: 'heure',
        unitPriceHT: 5_500,
        vatRate: 20,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      workerA = new PrismaService({ datasourceUrl: runtimeUrl });
      workerB = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([admin.$connect(), workerA.$connect(), workerB.$connect()]);
      await admin.company.createMany({
        data: [company(companyA, '8101'), company(companyB, '8102')],
      });
      await admin.customer.createMany({
        data: [
          {
            id: customerA,
            companyId: companyA,
            type: 'b2b',
            name: 'Client A',
            addrLine1: '1 rue A',
            addrZip: '75001',
            addrCity: 'Paris',
          },
          {
            id: customerB,
            companyId: companyB,
            type: 'b2b',
            name: 'Client B',
            addrLine1: '1 rue B',
            addrZip: '69001',
            addrCity: 'Lyon',
          },
        ],
      });
    }, 30_000);

    afterAll(async () => {
      if (admin) {
        await admin.chantier.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }).catch(() => undefined);
        await admin.cataloguePrestation.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }).catch(() => undefined);
        await admin.customer.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }).catch(() => undefined);
        await admin.company.deleteMany({ where: { id: { in: [companyA, companyB] } } }).catch(() => undefined);
      }
      await Promise.allSettled([
        workerA?.$disconnect(),
        workerB?.$disconnect(),
        admin?.$disconnect(),
      ]);
    });

    it('isole lecture/écriture et survit à une seconde instance', async () => {
      const repoA = new PrismaCatalogueRepository(workerA);
      const repoB = new PrismaCatalogueRepository(workerB);
      await workerA.withTenant(companyA, async () => {
        expect(await repoA.create(item(itemA, companyA, 'Main-d’œuvre A'))).toMatchObject({
          status: 'created',
        });
      });
      await workerB.withTenant(companyB, async () => {
        expect(await repoB.create(item(itemB, companyB, 'Main-d’œuvre B'))).toMatchObject({
          status: 'created',
        });
      });

      await workerB.withTenant(companyA, async () => {
        expect((await repoB.listByCompany(companyA)).map((entry) => entry.id)).toEqual([itemA]);
        expect(await repoB.listByCompany(companyB)).toEqual([]);
      });
      await workerA.withTenant(companyB, async () => {
        expect((await repoA.listByCompany(companyB)).map((entry) => entry.id)).toEqual([itemB]);
        expect(await repoA.listByCompany(companyA)).toEqual([]);
      });
    });

    it('applique le compare-and-swap sans écraser une édition concurrente', async () => {
      const repo = new PrismaCatalogueRepository(workerA);
      await workerA.withTenant(companyA, async () => {
        const updated = await repo.update({
          companyId: companyA,
          id: itemA,
          expectedRevision: 1,
          item: {
            ...item(itemA, companyA, 'Main-d’œuvre qualifiée'),
            revision: 2,
            updatedAt: '2026-07-17T11:00:00.000Z',
          },
        });
        expect(updated).toMatchObject({ status: 'updated', item: { revision: 2 } });
        expect(await repo.delete({
          companyId: companyA,
          id: itemA,
          expectedRevision: 1,
        })).toEqual({ status: 'revision_conflict' });
      });
    });

    it('persiste les chantiers et interdit un client d’un autre tenant', async () => {
      const repoA = new PrismaChantierRepository(workerA);
      await expect(workerA.withTenant(companyA, () =>
        repoA.save(Chantier.rehydrate({
            id: chantierA,
            companyId: companyA,
            name: 'Rénovation réelle',
            customerId: customerB,
            address: null,
            notes: null,
            status: 'open' as const,
            openedAt: '2026-07-17',
        })),
      )).rejects.toBeDefined();

      await workerA.withTenant(companyA, async () => {
        await repoA.save(Chantier.rehydrate({
          id: chantierA,
          companyId: companyA,
          name: 'Rénovation réelle',
          customerId: customerA,
          address: '1 rue A',
          notes: 'RDV le matin, code portail 1234.',
          status: 'open',
          openedAt: '2026-07-17',
        }));
        const persisted = await repoA.listByCompany(companyA);
        expect(persisted.map((entry) => entry.id)).toEqual([chantierA]);
        expect(persisted[0]?.notes).toBe('RDV le matin, code portail 1234.');
      });
    });
  },
);
