import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_SALES_TENANT_CERT === 'true';

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Ventes — certification PostgreSQL des liens inter-tenant',
  () => {
    const companyA = `sales-integrity-a-${randomUUID()}`;
    const companyB = `sales-integrity-b-${randomUUID()}`;
    const customerA = `sales-customer-a-${randomUUID()}`;
    const customerB = `sales-customer-b-${randomUUID()}`;
    const quoteA = `sales-quote-a-${randomUUID()}`;
    const quoteB = `sales-quote-b-${randomUUID()}`;
    const invoiceA = `sales-invoice-a-${randomUUID()}`;
    const invoiceB = `sales-invoice-b-${randomUUID()}`;
    const paymentA = `sales-payment-a-${randomUUID()}`;
    const directUrl = process.env.DIRECT_URL ?? '';
    const sirenA = String(randomInt(100_000_000, 899_999_999));
    const sirenB = String(randomInt(100_000_000, 899_999_999));

    let admin: PrismaClient;

    function company(id: string, siren: string) {
      return {
        id,
        name: `Certification ${id}`,
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

    beforeAll(async () => {
      if (!directUrl) throw new Error('DIRECT_URL (rôle admin) est requis.');
      admin = new PrismaClient({ datasourceUrl: directUrl });
      await admin.$connect();
      await admin.company.createMany({
        data: [company(companyA, sirenA), company(companyB, sirenB)],
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
      await admin.quote.createMany({
        data: [
          { id: quoteA, companyId: companyA, customerId: customerA },
          { id: quoteB, companyId: companyB, customerId: customerB },
        ],
      });
      await admin.invoice.createMany({
        data: [
          {
            id: invoiceA,
            companyId: companyA,
            customerId: customerA,
            kind: 'invoice',
            parentQuoteId: quoteA,
          },
          {
            id: invoiceB,
            companyId: companyB,
            customerId: customerB,
            kind: 'deposit_invoice',
            parentQuoteId: quoteB,
          },
        ],
      });
    }, 30_000);

    afterAll(async () => {
      if (!admin) return;
      await admin.payment.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }).catch(() => undefined);
      await admin.invoice.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }).catch(() => undefined);
      await admin.quote.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }).catch(() => undefined);
      await admin.customer.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }).catch(() => undefined);
      await admin.company.deleteMany({ where: { id: { in: [companyA, companyB] } } }).catch(() => undefined);
      await admin.$disconnect();
    });

    it('interdit à un devis et une facture de référencer le client d’un autre tenant', async () => {
      await expect(
        admin.quote.create({
          data: {
            id: `cross-quote-${randomUUID()}`,
            companyId: companyA,
            customerId: customerB,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });

      await expect(
        admin.invoice.create({
          data: {
            id: `cross-customer-invoice-${randomUUID()}`,
            companyId: companyA,
            customerId: customerB,
            kind: 'invoice',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('interdit les liens devis et acompte provenant d’un autre tenant', async () => {
      await expect(
        admin.invoice.create({
          data: {
            id: `cross-quote-invoice-${randomUUID()}`,
            companyId: companyA,
            customerId: customerA,
            kind: 'invoice',
            parentQuoteId: quoteB,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });

      await expect(
        admin.invoice.create({
          data: {
            id: `cross-deposit-invoice-${randomUUID()}`,
            companyId: companyA,
            customerId: customerA,
            kind: 'invoice',
            depositInvoiceId: invoiceB,
            depositDeductionCents: 1_000,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('interdit un encaissement rattaché à la facture d’un autre tenant', async () => {
      await expect(
        admin.payment.create({
          data: {
            id: `cross-payment-${randomUUID()}`,
            companyId: companyA,
            invoiceId: invoiceB,
            amount: 1_000,
            method: 'transfer',
            receivedAt: new Date('2026-07-18T10:00:00.000Z'),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });

      await expect(
        admin.payment.create({
          data: {
            id: paymentA,
            companyId: companyA,
            invoiceId: invoiceA,
            amount: 1_000,
            method: 'transfer',
            receivedAt: new Date('2026-07-18T10:00:00.000Z'),
          },
        }),
      ).resolves.toMatchObject({ id: paymentA, companyId: companyA, invoiceId: invoiceA });
    });

    it('porte les cinq contraintes composites attendues dans PostgreSQL', async () => {
      const constraints = await admin.$queryRaw<Array<{ name: string }>>`
        SELECT conname AS name
          FROM pg_constraint
         WHERE conname IN (
           'quotes_customer_tenant_fkey',
           'invoices_customer_tenant_fkey',
           'invoices_parent_quote_tenant_fkey',
           'invoices_deposit_tenant_fkey',
           'payments_invoice_tenant_fkey'
         )
         ORDER BY conname
      `;
      expect(constraints.map(({ name }) => name)).toEqual([
        'invoices_customer_tenant_fkey',
        'invoices_deposit_tenant_fkey',
        'invoices_parent_quote_tenant_fkey',
        'payments_invoice_tenant_fkey',
        'quotes_customer_tenant_fkey',
      ]);
    });
  },
);
