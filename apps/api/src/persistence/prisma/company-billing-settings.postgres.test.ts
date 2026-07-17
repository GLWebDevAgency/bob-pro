import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from './prisma.service';
import { PrismaCompanyBillingSettingsRepository } from './company-billing-settings.repository';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_BILLING_SETTINGS_CERT === 'true';

describe.skipIf(!RUN_POSTGRES_CERT)(
  'CompanyBillingSettings — certification PostgreSQL RLS/CAS',
  () => {
    const suffix = randomUUID();
    const companyA = `billing-a-${suffix}`;
    const companyB = `billing-b-${suffix}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;

    function company(id: string, discriminator: string) {
      return {
        id,
        name: `Billing cert ${discriminator}`,
        legalForm: 'EI' as const,
        siren: `77110${discriminator.padStart(4, '0')}`,
        siret: `77110${discriminator.padStart(4, '0')}00001`,
        trade: 'autre',
        vatRegime: 'reel_normal' as const,
        addrLine1: '1 rue du PDF',
        addrZip: '75001',
        addrCity: 'Paris',
      };
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) throw new Error('DATABASE_URL et DIRECT_URL sont requis.');
      admin = new PrismaClient({ datasourceUrl: directUrl });
      workerA = new PrismaService({ datasourceUrl: runtimeUrl });
      workerB = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([admin.$connect(), workerA.$connect(), workerB.$connect()]);
      await admin.company.createMany({
        data: [company(companyA, '9301'), company(companyB, '9302')],
      });
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin) {
          // Nettoyage strict : une fuite de fixture dans la BDD de certification fait échouer le lot.
          await admin.companyBillingSettings.deleteMany({
            where: { companyId: { in: [companyA, companyB] } },
          });
          await admin.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
        }
      } finally {
        await Promise.allSettled([
          workerA?.$disconnect(),
          workerB?.$disconnect(),
          admin?.$disconnect(),
        ]);
      }
    });

    it('persiste la politique initiale en BDD et masque intégralement le tenant voisin', async () => {
      const repoA = new PrismaCompanyBillingSettingsRepository(workerA);
      const repoB = new PrismaCompanyBillingSettingsRepository(workerB);
      await workerA.withTenant(companyA, async () => {
        expect(await repoA.ensureForCompany(companyA)).toMatchObject({
          companyId: companyA,
          revision: 1,
          showRibOnInvoices: false,
          showInsuranceOnInvoices: true,
          pdfAccentColor: 'navy',
          defaultQuoteValidityDays: 30,
          defaultDepositPercent: 30,
          defaultInvoicePaymentTermsDays: null,
        });
        expect(await repoA.findByCompanyId(companyB)).toBeNull();
      });
      await workerB.withTenant(companyB, async () => {
        await repoB.ensureForCompany(companyB);
        expect(await repoB.findByCompanyId(companyA)).toBeNull();
      });
    });

    it('n’accepte qu’un gagnant pour deux écritures concurrentes à la même révision', async () => {
      const repoA = new PrismaCompanyBillingSettingsRepository(workerA);
      const repoB = new PrismaCompanyBillingSettingsRepository(workerB);
      const [first, second] = await Promise.all([
        workerA.withTenant(companyA, () =>
          repoA.update({
            companyId: companyA,
            expectedRevision: 1,
            patch: { pdfAccentColor: 'green' },
          }),
        ),
        workerB.withTenant(companyA, () =>
          repoB.update({
            companyId: companyA,
            expectedRevision: 1,
            patch: { pdfAccentColor: 'purple' },
          }),
        ),
      ]);
      expect([first.status, second.status].sort()).toEqual(['revision_conflict', 'updated']);
      const persisted = await workerA.withTenant(companyA, () => repoA.findByCompanyId(companyA));
      expect(persisted?.revision).toBe(2);
      expect(['green', 'purple']).toContain(persisted?.pdfAccentColor);
    });

    it('refuse en base les contournements du CAS et les champs structurels mutés', async () => {
      await expect(
        admin.$executeRawUnsafe(
          'UPDATE company_billing_settings SET "pdfAccentColor" = \'orange\' WHERE "companyId" = $1',
          companyA,
        ),
      ).rejects.toBeDefined();
      await expect(
        admin.$executeRawUnsafe(
          'UPDATE company_billing_settings SET "companyId" = $2, revision = revision + 1 WHERE "companyId" = $1',
          companyA,
          companyB,
        ),
      ).rejects.toBeDefined();
      await expect(
        admin.$executeRawUnsafe(
          'UPDATE company_billing_settings SET "updatedAt" = "updatedAt" - interval \'1 second\', revision = revision + 1 WHERE "companyId" = $1',
          companyA,
        ),
      ).rejects.toBeDefined();
    });
  },
);
