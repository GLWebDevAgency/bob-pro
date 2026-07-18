import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StripeSubscriptionInvoiceSnapshot } from '../../payments/stripe-billing-contract';
import { PrismaService } from './prisma.service';
import { PrismaStripeBillingRepository } from './stripe-billing.repository';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_STRIPE_INVOICES_CERT === 'true';

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Factures d’abonnement Stripe — certification PostgreSQL RLS et identité fournisseur',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const companyA = `stripe-invoice-a-${suffix}`;
    const companyB = `stripe-invoice-b-${suffix}`;
    const invoiceA = `in_${suffix}a`;
    const invoiceB = `in_${suffix}b`;
    const customerA = `cus_${suffix}a`;
    const customerB = `cus_${suffix}b`;
    const subscriptionA = `sub_${suffix}a`;
    const subscriptionB = `sub_${suffix}b`;
    const directUrl = process.env.DIRECT_URL ?? '';
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const sirenA = String(randomInt(100_000_000, 899_999_999));
    const sirenB = String(randomInt(100_000_000, 899_999_999));

    let admin: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;

    function company(id: string, siren: string) {
      return {
        id,
        name: `Certification Stripe ${id}`,
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

    function snapshot(input: {
      invoiceId: string;
      customerId: string;
      subscriptionId: string;
    }): StripeSubscriptionInvoiceSnapshot {
      return {
        stripeInvoiceId: input.invoiceId,
        stripeCustomerId: input.customerId,
        stripeSubscriptionId: input.subscriptionId,
        status: 'paid',
        currency: 'eur',
        number: `FR-${input.invoiceId.slice(-8)}`,
        subtotalCents: 3_250,
        taxCents: 650,
        totalCents: 3_900,
        amountPaidCents: 3_900,
        amountDueCents: 0,
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2026-08-01T00:00:00.000Z',
        issuedAt: '2026-07-17T10:00:00.000Z',
        paidAt: '2026-07-17T10:01:00.000Z',
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/acct_live/certification',
        invoicePdfUrl: 'https://invoice.stripe.com/i/acct_live/certification/pdf',
        metadata: {},
      };
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) throw new Error('DATABASE_URL et DIRECT_URL sont requis.');
      admin = new PrismaClient({ datasourceUrl: directUrl });
      workerA = new PrismaService({ datasourceUrl: runtimeUrl });
      workerB = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([admin.$connect(), workerA.$connect(), workerB.$connect()]);
      await admin.company.createMany({
        data: [company(companyA, sirenA), company(companyB, sirenB)],
      });
      await admin.subscription.createMany({
        data: [
          {
            id: `subscription-row-a-${suffix}`,
            companyId: companyA,
            plan: 'pro',
            status: 'active',
            store: 'stripe',
            storeRef: subscriptionA,
            stripeCustomerId: customerA,
            stripeSubscriptionId: subscriptionA,
          },
          {
            id: `subscription-row-b-${suffix}`,
            companyId: companyB,
            plan: 'pro',
            status: 'active',
            store: 'stripe',
            storeRef: subscriptionB,
            stripeCustomerId: customerB,
            stripeSubscriptionId: subscriptionB,
          },
        ],
      });
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin) {
          await admin.$executeRawUnsafe(
            'DELETE FROM stripe_subscription_invoices WHERE "companyId" IN ($1, $2)',
            companyA,
            companyB,
          );
          await admin.subscription.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
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

    it('persiste et liste uniquement les factures du tenant courant', async () => {
      const repoA = new PrismaStripeBillingRepository(workerA);
      const repoB = new PrismaStripeBillingRepository(workerB);
      await workerA.withTenant(companyA, () =>
        repoA.upsertSubscriptionInvoice({
          companyId: companyA,
          eventId: `evt_${suffix}a`,
          snapshot: snapshot({
            invoiceId: invoiceA,
            customerId: customerA,
            subscriptionId: subscriptionA,
          }),
          now: '2026-07-17T10:01:01.000Z',
        }),
      );
      await workerB.withTenant(companyB, () =>
        repoB.upsertSubscriptionInvoice({
          companyId: companyB,
          eventId: `evt_${suffix}b`,
          snapshot: snapshot({
            invoiceId: invoiceB,
            customerId: customerB,
            subscriptionId: subscriptionB,
          }),
          now: '2026-07-17T10:01:01.000Z',
        }),
      );

      await expect(
        workerA.withTenant(companyA, () => repoA.listSubscriptionInvoices(companyA)),
      ).resolves.toMatchObject([{ stripeInvoiceId: invoiceA, companyId: companyA }]);
      await expect(
        workerA.withTenant(companyA, () => repoA.listSubscriptionInvoices(companyB)),
      ).resolves.toEqual([]);
      await expect(
        workerB.withTenant(companyB, () => repoB.listSubscriptionInvoices(companyA)),
      ).resolves.toEqual([]);
    });

    it('refuse une insertion pour un autre tenant et la réattribution d’un identifiant Stripe', async () => {
      const repoA = new PrismaStripeBillingRepository(workerA);
      const repoB = new PrismaStripeBillingRepository(workerB);
      await expect(
        workerA.withTenant(companyA, () =>
          repoA.upsertSubscriptionInvoice({
            companyId: companyB,
            eventId: `evt_${suffix}cross`,
            snapshot: snapshot({
              invoiceId: `in_${suffix}cross`,
              customerId: customerB,
              subscriptionId: subscriptionB,
            }),
            now: '2026-07-17T10:02:00.000Z',
          }),
        ),
      ).rejects.toBeDefined();

      await expect(
        workerB.withTenant(companyB, () =>
          repoB.upsertSubscriptionInvoice({
            companyId: companyB,
            eventId: `evt_${suffix}rebind`,
            snapshot: snapshot({
              invoiceId: invoiceA,
              customerId: customerB,
              subscriptionId: subscriptionB,
            }),
            now: '2026-07-17T10:03:00.000Z',
          }),
        ),
      ).rejects.toBeDefined();
    });

    it('porte FORCE RLS et la policy tenant attendue dans PostgreSQL', async () => {
      const [table] = await admin.$queryRaw<Array<{ enabled: boolean; forced: boolean }>>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
          FROM pg_class
         WHERE oid = 'stripe_subscription_invoices'::regclass
      `;
      const policies = await admin.$queryRaw<Array<{ policyname: string }>>`
        SELECT policyname
          FROM pg_policies
         WHERE schemaname = current_schema()
           AND tablename = 'stripe_subscription_invoices'
      `;

      expect(table).toEqual({ enabled: true, forced: true });
      expect(policies.map(({ policyname }) => policyname)).toEqual([
        'stripe_subscription_invoices_tenant_isolation',
      ]);
    });
  },
);
