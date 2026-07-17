import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiagnosticAssessmentSaveInput } from '@bob/core';
import { PrismaDiagnosticAssessmentRepository } from './diagnostic-assessment.repository';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_DIAGNOSTIC_CERT === 'true';

describe.skipIf(!RUN_POSTGRES_CERT)(
  'DiagnosticAssessment — certification PostgreSQL RLS/CAS',
  () => {
    const suffix = randomUUID();
    const companyA = `diagnostic-a-${suffix}`;
    const companyB = `diagnostic-b-${suffix}`;
    const sirenBase = String(randomInt(100_000_000, 999_999_999));
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;

    function company(id: string, offset: number) {
      const siren = String(Number(sirenBase) + offset).padStart(9, '0');
      return {
        id,
        name: `Diagnostic cert ${offset}`,
        legalForm: 'EI' as const,
        siren,
        siret: `${siren}00001`,
        trade: 'autre',
        vatRegime: 'reel_normal' as const,
        addrLine1: '1 rue de la Certification',
        addrZip: '75001',
        addrCity: 'Paris',
      };
    }

    function input(
      companyId: string,
      expectedRevision: number,
      score = 72,
    ): DiagnosticAssessmentSaveInput {
      return {
        companyId,
        expectedRevision,
        answers: { platform: 'yes', offAppSales: 'no', accountant: 'yes' },
        score,
        axes: [
          { id: 'reception', score: 80 },
          { id: 'emission', score: 70 },
          { id: 'donnees', score: 66 },
        ],
        sourceFingerprint: 'a'.repeat(64),
        rulesetVersion: 1,
        sourceAsOf: '2026-07-17',
      };
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      workerA = new PrismaService({ datasourceUrl: runtimeUrl });
      workerB = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([admin.$connect(), workerA.$connect(), workerB.$connect()]);
      await admin.company.createMany({
        data: [company(companyA, 1), company(companyB, 2)],
      });
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin) {
          await admin.companyDiagnosticAssessment.deleteMany({
            where: { companyId: { in: [companyA, companyB] } },
          }).catch(() => undefined);
          await admin.company.deleteMany({
            where: { id: { in: [companyA, companyB] } },
          }).catch(() => undefined);
        }
      } finally {
        await Promise.allSettled([
          workerA?.$disconnect(),
          workerB?.$disconnect(),
          admin?.$disconnect(),
        ]);
      }
    });

    it('représente « jamais réalisé » par une absence et isole lecture/écriture entre tenants', async () => {
      const repoA = new PrismaDiagnosticAssessmentRepository(workerA);
      const repoB = new PrismaDiagnosticAssessmentRepository(workerB);

      await workerA.withTenant(companyA, async () => {
        expect(await repoA.findByCompanyId(companyA)).toBeNull();
        expect(await repoA.save(input(companyA, 0))).toMatchObject({
          status: 'created',
          assessment: { companyId: companyA, revision: 1, score: 72 },
        });
      });

      await workerB.withTenant(companyB, async () => {
        expect(await repoB.findByCompanyId(companyA)).toBeNull();
        await expect(repoB.save(input(companyA, 0))).rejects.toBeDefined();
      });
    });

    it('n’accepte qu’un gagnant pour deux écritures concurrentes à la même révision', async () => {
      const repoA = new PrismaDiagnosticAssessmentRepository(workerA);
      const repoB = new PrismaDiagnosticAssessmentRepository(workerB);
      const [first, second] = await Promise.all([
        workerA.withTenant(companyA, () => repoA.save(input(companyA, 1, 81))),
        workerB.withTenant(companyA, () => repoB.save(input(companyA, 1, 64))),
      ]);

      expect([first.status, second.status].sort()).toEqual(['revision_conflict', 'updated']);
      const current = await workerA.withTenant(companyA, () => repoA.findByCompanyId(companyA));
      expect(current?.revision).toBe(2);
      expect([64, 81]).toContain(current?.score);
    });

    it('refuse en base les réponses, scores et empreintes invalides', async () => {
      const insert = `
        INSERT INTO company_diagnostic_assessments
          ("companyId", answers, score, "receptionScore", "emissionScore", "dataQualityScore",
           "sourceFingerprint", "rulesetVersion", "sourceAsOf", revision)
        VALUES ($1, $2::jsonb, $3, 70, 70, 70, $4, 1, DATE '2026-07-17', 1)
      `;
      await expect(admin.$executeRawUnsafe(
        insert,
        companyB,
        JSON.stringify({ platform: 'yes', accountant: 'yes', injected: 'yes' }),
        70,
        'b'.repeat(64),
      )).rejects.toBeDefined();
      await expect(admin.$executeRawUnsafe(
        insert,
        companyB,
        JSON.stringify({ platform: 'yes', accountant: 'yes' }),
        101,
        'b'.repeat(64),
      )).rejects.toBeDefined();
      await expect(admin.$executeRawUnsafe(
        insert,
        companyB,
        JSON.stringify({ platform: 'yes', accountant: 'yes' }),
        70,
        'not-a-sha256',
      )).rejects.toBeDefined();
      expect(await admin.companyDiagnosticAssessment.findUnique({
        where: { companyId: companyB },
      })).toBeNull();
    });

    it('interdit le contournement du CAS, la mutation du tenant et la suppression runtime', async () => {
      await expect(admin.$executeRawUnsafe(
        'UPDATE company_diagnostic_assessments SET score = 1 WHERE "companyId" = $1',
        companyA,
      )).rejects.toBeDefined();
      await expect(admin.$executeRawUnsafe(
        'UPDATE company_diagnostic_assessments SET "companyId" = $2, revision = revision + 1 WHERE "companyId" = $1',
        companyA,
        companyB,
      )).rejects.toBeDefined();

      const deletion = await workerA.withTenant(companyA, () =>
        workerA.client().companyDiagnosticAssessment.deleteMany({ where: { companyId: companyA } }));
      expect(deletion.count).toBe(0);
      expect(await workerA.withTenant(companyA, () =>
        new PrismaDiagnosticAssessmentRepository(workerA).findByCompanyId(companyA))).not.toBeNull();
    });
  },
);
