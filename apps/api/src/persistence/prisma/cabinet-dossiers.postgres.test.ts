import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cabinetDossierAnalysisSha256,
  deriveCabinetDossierFinancialSummary,
  normalizeCabinetDossierSiren,
  type StoredFecAnalysis,
} from '../../cabinet/dossiers/cabinet-dossier-contract';
import type { CabinetDossierMutationData } from '../../cabinet/dossiers/cabinet-dossier-repository';
import { PrismaCabinetDossierRepository } from '../../cabinet/dossiers/prisma-cabinet-dossier.repository';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_CABINET_DOSSIER_CERT === 'true';

function analysis(): StoredFecAnalysis {
  return {
    trialBalance: {
      rows: [
        { account: '101', label: 'Capital', debitCents: 0, creditCents: 10_000, balanceCents: -10_000 },
        { account: '512', label: 'Banque', debitCents: 10_000, creditCents: 0, balanceCents: 10_000 },
      ],
      totalDebitCents: 10_000,
      totalCreditCents: 10_000,
      balanced: true,
      resultCents: 0,
      revenueCents: 0,
      chargesCents: 0,
    },
    incomeStatement: {
      exploitationProduitsCents: 0,
      exploitationChargesCents: 0,
      resultatExploitationCents: 0,
      financierProduitsCents: 0,
      financierChargesCents: 0,
      resultatFinancierCents: 0,
      resultatCourantCents: 0,
      exceptionnelProduitsCents: 0,
      exceptionnelChargesCents: 0,
      resultatExceptionnelCents: 0,
      participationCents: 0,
      resultatNetAvantImpotCents: 0,
      impotBeneficesCents: 0,
      resultatNetCents: 0,
    },
    balanceSheet: {
      actif: {
        immobilisationsNettesCents: 0,
        stocksCents: 0,
        creancesCents: 0,
        disponibilitesCents: 10_000,
        totalCents: 10_000,
      },
      passif: {
        capitauxPropresCents: 10_000,
        resultatNetCents: 0,
        provisionsCents: 0,
        empruntsCents: 0,
        dettesCents: 0,
        decouvertCents: 0,
        totalCents: 10_000,
      },
      balanced: true,
      ecartCents: 0,
    },
    turnoverCents: 0,
    unbalancedEntries: [],
    checks: {
      entriesBalanced: true,
      trialBalanceBalanced: true,
      balanceSheetBalanced: true,
      resultConsistent: true,
      allPassed: true,
    },
  };
}

function dossierData(input: {
  siren: string;
  clientName: string;
  importedAt: string;
}): CabinetDossierMutationData {
  const siren = normalizeCabinetDossierSiren(input.siren);
  if (siren === null) throw new Error(`SIREN de certification invalide: ${input.siren}`);
  const storedAnalysis = analysis();
  return {
    siren,
    clientName: input.clientName,
    sourceFileName: `${siren}FEC20251231.txt`,
    entryCount: 1,
    rowCount: 2,
    period: { from: '2025-01-01', to: '2025-12-31' },
    financial: deriveCabinetDossierFinancialSummary(storedAnalysis),
    analysis: storedAnalysis,
    analysisSha256: cabinetDossierAnalysisSha256(storedAnalysis),
    review: { verdict: 'ready', okCount: 4, attentionCount: 0, anomalyCount: 0, infoCount: 1 },
    fiscal: {
      legalForm: 'SASU',
      vatRegime: 'reel_normal',
      incomeTaxRegime: 'IS',
      fiscalYearEnd: '12-31',
      urssafPeriodicity: 'monthly',
      dateCreation: '2020-03-12',
    },
    lastImportedAt: input.importedAt,
  };
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'CabinetDossier — certification PostgreSQL RLS/RBAC/CAS',
  () => {
    const suffix = randomUUID();
    const cabinetA = `dossier-cert-a-${suffix}`;
    const cabinetB = `dossier-cert-b-${suffix}`;
    const adminA = `dossier-admin-a-${suffix}`;
    const managerA = `dossier-manager-a-${suffix}`;
    const collaboratorA = `dossier-collaborator-a-${suffix}`;
    const adminB = `dossier-admin-b-${suffix}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';

    let privileged: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;

    function asActor<T>(
      worker: PrismaService,
      userId: string,
      cabinetId: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      return worker.withCabinet(userId, cabinetId, () => fn());
    }

    function member(id: string, cabinetId: string, userId: string, role: 'admin' | 'manager' | 'collaborator') {
      return {
        id,
        cabinetId,
        userId,
        role,
        status: 'active' as const,
        joinedAt: new Date('2026-07-17T08:00:00.000Z'),
        version: 1,
        createdAt: new Date('2026-07-17T08:00:00.000Z'),
        updatedAt: new Date('2026-07-17T08:00:00.000Z'),
      };
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (rôle privilégié) sont requis.');
      }
      privileged = new PrismaClient({ datasourceUrl: directUrl });
      workerA = new PrismaService({ datasourceUrl: runtimeUrl });
      workerB = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([privileged.$connect(), workerA.$connect(), workerB.$connect()]);

      const runtimeRole = await workerA.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT rolsuper, rolbypassrls
          FROM pg_roles
         WHERE rolname = current_user
      `;
      expect(runtimeRole).toEqual([{ rolsuper: false, rolbypassrls: false }]);

      const createdAt = new Date('2026-07-17T08:00:00.000Z');
      await privileged.cabinet.createMany({
        data: [
          {
            id: cabinetA,
            name: 'Cabinet certification A',
            timeZone: 'Europe/Paris',
            status: 'active',
            createdByUserId: adminA,
            bootstrapCompletedAt: createdAt,
            version: 1,
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: cabinetB,
            name: 'Cabinet certification B',
            timeZone: 'Europe/Paris',
            status: 'active',
            createdByUserId: adminB,
            bootstrapCompletedAt: createdAt,
            version: 1,
            createdAt,
            updatedAt: createdAt,
          },
        ],
      });
      await privileged.cabinetMember.createMany({
        data: [
          member(`member-admin-a-${suffix}`, cabinetA, adminA, 'admin'),
          member(`member-manager-a-${suffix}`, cabinetA, managerA, 'manager'),
          member(`member-collaborator-a-${suffix}`, cabinetA, collaboratorA, 'collaborator'),
          member(`member-admin-b-${suffix}`, cabinetB, adminB, 'admin'),
        ],
      });
    }, 30_000);

    afterAll(async () => {
      try {
        if (privileged) {
          await privileged.$transaction(async (tx) => {
            await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
            await tx.cabinet.deleteMany({ where: { id: { in: [cabinetA, cabinetB] } } });
          });
          const leaked = await privileged.cabinetDossier.count({
            where: { cabinetId: { in: [cabinetA, cabinetB] } },
          });
          expect(leaked).toBe(0);
        }
      } finally {
        await Promise.allSettled([
          workerA?.$disconnect(),
          workerB?.$disconnect(),
          privileged?.$disconnect(),
        ]);
      }
    });

    it('isole strictement deux cabinets, y compris avec le même SIREN', async () => {
      const repositoryA = new PrismaCabinetDossierRepository(workerA);
      const repositoryB = new PrismaCabinetDossierRepository(workerB);
      const siren = '552100554';
      const now = '2026-07-17T09:00:00.000Z';

      await asActor(workerA, adminA, cabinetA, async () => {
        expect(await repositoryA.create({
          id: randomUUID(),
          cabinetId: cabinetA,
          actorUserId: adminA,
          data: dossierData({ siren, clientName: 'Entreprise A', importedAt: now }),
          now,
        })).toMatchObject({ kind: 'saved', dossier: { cabinetId: cabinetA, clientName: 'Entreprise A' } });
      });
      await asActor(workerB, adminB, cabinetB, async () => {
        expect(await repositoryB.create({
          id: randomUUID(),
          cabinetId: cabinetB,
          actorUserId: adminB,
          data: dossierData({ siren, clientName: 'Entreprise B', importedAt: now }),
          now,
        })).toMatchObject({ kind: 'saved', dossier: { cabinetId: cabinetB, clientName: 'Entreprise B' } });
      });

      await asActor(workerA, adminA, cabinetA, async () => {
        expect((await repositoryA.listSummaries({ cabinetId: cabinetA, limit: 50 })).items)
          .toEqual([expect.objectContaining({ cabinetId: cabinetA, clientName: 'Entreprise A' })]);
        expect(await repositoryA.findBySiren(cabinetB, siren)).toBeNull();
        await expect(repositoryA.create({
          id: randomUUID(),
          cabinetId: cabinetB,
          actorUserId: adminA,
          data: dossierData({ siren: '732829320', clientName: 'Écriture forgée', importedAt: now }),
          now,
        })).rejects.toBeDefined();
      });
      await asActor(workerB, adminB, cabinetA, async () => {
        expect(await repositoryB.listSummaries({ cabinetId: cabinetA, limit: 50 })).toEqual({
          items: [],
          nextCursor: null,
        });
      });
    });

    it('autorise le manager, mais ferme toute lecture et écriture au collaborateur', async () => {
      const repository = new PrismaCabinetDossierRepository(workerA);
      const siren = '732829320';
      const createdAt = '2026-07-17T09:10:00.000Z';

      const created = await asActor(workerA, managerA, cabinetA, () => repository.create({
        id: randomUUID(),
        cabinetId: cabinetA,
        actorUserId: managerA,
        data: dossierData({ siren, clientName: 'Dossier manager', importedAt: createdAt }),
        now: createdAt,
      }));
      expect(created).toMatchObject({ kind: 'saved', dossier: { revision: 1 } });

      await asActor(workerA, collaboratorA, cabinetA, async () => {
        expect(await repository.findBySiren(cabinetA, siren)).toBeNull();
        expect(await repository.listSummaries({ cabinetId: cabinetA, limit: 50 })).toEqual({
          items: [],
          nextCursor: null,
        });
        await expect(repository.create({
          id: randomUUID(),
          cabinetId: cabinetA,
          actorUserId: collaboratorA,
          data: dossierData({
            siren: '542107651',
            clientName: 'Dossier collaborateur interdit',
            importedAt: createdAt,
          }),
          now: createdAt,
        })).rejects.toBeDefined();
      });
    });

    it('n’accepte qu’un gagnant pour deux remplacements concurrents à la même révision', async () => {
      const repositoryA = new PrismaCabinetDossierRepository(workerA);
      const repositoryB = new PrismaCabinetDossierRepository(workerB);
      const siren = '542107651';
      const createdAt = '2026-07-17T09:20:00.000Z';
      const updatedAt = '2026-07-17T09:21:00.000Z';

      const created = await asActor(workerA, adminA, cabinetA, () => repositoryA.create({
        id: randomUUID(),
        cabinetId: cabinetA,
        actorUserId: adminA,
        data: dossierData({ siren, clientName: 'Version initiale', importedAt: createdAt }),
        now: createdAt,
      }));
      expect(created).toMatchObject({ kind: 'saved', dossier: { revision: 1 } });

      const [first, second] = await Promise.all([
        asActor(workerA, managerA, cabinetA, () => repositoryA.replace({
          cabinetId: cabinetA,
          actorUserId: managerA,
          expectedRevision: 1,
          data: dossierData({ siren, clientName: 'Concurrent A', importedAt: updatedAt }),
          now: updatedAt,
        })),
        asActor(workerB, managerA, cabinetA, () => repositoryB.replace({
          cabinetId: cabinetA,
          actorUserId: managerA,
          expectedRevision: 1,
          data: dossierData({ siren, clientName: 'Concurrent B', importedAt: updatedAt }),
          now: updatedAt,
        })),
      ]);
      expect([first.kind, second.kind].sort()).toEqual(['conflict', 'saved']);

      const persisted = await asActor(workerA, adminA, cabinetA, () => repositoryA.findBySiren(cabinetA, siren));
      expect(persisted).toMatchObject({ revision: 2 });
      expect(['Concurrent A', 'Concurrent B']).toContain(persisted?.clientName);
      const updateAudits = await privileged.cabinetAuditEvent.count({
        where: {
          cabinetId: cabinetA,
          entityType: 'cabinet_dossier',
          entityId: persisted?.id,
          action: 'CabinetDossierUpdated',
        },
      });
      expect(updateAudits).toBe(1);
    });

    it('réserve la suppression à l’admin et conserve le CAS jusque dans la base', async () => {
      const repository = new PrismaCabinetDossierRepository(workerA);
      const siren = '784824153';
      const now = '2026-07-17T09:30:00.000Z';
      const created = await asActor(workerA, adminA, cabinetA, () => repository.create({
        id: randomUUID(),
        cabinetId: cabinetA,
        actorUserId: adminA,
        data: dossierData({ siren, clientName: 'Dossier à supprimer', importedAt: now }),
        now,
      }));
      expect(created).toMatchObject({ kind: 'saved', dossier: { revision: 1 } });

      await asActor(workerA, managerA, cabinetA, async () => {
        expect(await repository.delete({
          cabinetId: cabinetA,
          siren,
          actorUserId: managerA,
          expectedRevision: 1,
          now,
        })).toBe('conflict');
      });
      await asActor(workerA, adminA, cabinetA, async () => {
        expect(await repository.delete({
          cabinetId: cabinetA,
          siren,
          actorUserId: adminA,
          expectedRevision: 2,
          now,
        })).toBe('conflict');
        expect(await repository.delete({
          cabinetId: cabinetA,
          siren,
          actorUserId: adminA,
          expectedRevision: 1,
          now,
        })).toBe('deleted');
        expect(await repository.findBySiren(cabinetA, siren)).toBeNull();
      });
    });

    it('rejette en base les mutations d’identité, de révision et de cohérence financière', async () => {
      const repository = new PrismaCabinetDossierRepository(workerA);
      const siren = '356000000';
      const now = '2026-07-17T09:40:00.000Z';
      const created = await asActor(workerA, adminA, cabinetA, () => repository.create({
        id: randomUUID(),
        cabinetId: cabinetA,
        actorUserId: adminA,
        data: dossierData({ siren, clientName: 'Dossier contraintes', importedAt: now }),
        now,
      }));
      expect(created).toMatchObject({ kind: 'saved', dossier: { revision: 1 } });

      await expect(privileged.$executeRawUnsafe(
        'UPDATE cabinet_dossiers SET "clientName" = $2 WHERE "cabinetId" = $1 AND siren = $3',
        cabinetA,
        'Révision contournée',
        siren,
      )).rejects.toBeDefined();
      await expect(privileged.$executeRawUnsafe(
        'UPDATE cabinet_dossiers SET siren = $2, revision = revision + 1 WHERE "cabinetId" = $1 AND siren = $3',
        cabinetA,
        '000000000',
        siren,
      )).rejects.toBeDefined();
      await expect(privileged.$executeRawUnsafe(
        'UPDATE cabinet_dossiers SET "rowCount" = 0, revision = revision + 1 WHERE "cabinetId" = $1 AND siren = $2',
        cabinetA,
        siren,
      )).rejects.toBeDefined();
      await expect(privileged.$executeRawUnsafe(
        'UPDATE cabinet_dossiers SET "totalDebitCents" = "totalDebitCents" + 1, revision = revision + 1 WHERE "cabinetId" = $1 AND siren = $2',
        cabinetA,
        siren,
      )).rejects.toBeDefined();

      const persisted = await privileged.cabinetDossier.findUnique({
        where: { cabinet_dossier_siren: { cabinetId: cabinetA, siren } },
      });
      expect(persisted).toMatchObject({ siren, revision: 1, rowCount: 2 });
    });
  },
);
