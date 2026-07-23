import { randomInt, randomUUID } from 'node:crypto';
import { Invoice, Payment } from '@bob/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaInvoiceRepository, PrismaPaymentRepository } from './repositories';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_INVOICE_SETTLEMENT_CERT === 'true';

function passesLuhn(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function appendLuhnDigit(prefix: string): string {
  for (let digit = 0; digit <= 9; digit += 1) {
    const candidate = `${prefix}${digit}`;
    if (passesLuhn(candidate)) return candidate;
  }
  throw new Error('unable to build a valid Luhn identifier');
}

function legalIdentity(): { siren: string; siret: string } {
  const siren = appendLuhnDigit(String(randomInt(10_000_000, 100_000_000)));
  const siret = appendLuhnDigit(`${siren}${String(randomInt(0, 10_000)).padStart(4, '0')}`);
  return { siren, siret };
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Règlement facture V2 — certification PostgreSQL/FORCE RLS',
  () => {
    const suffix = randomUUID();
    const companyA = `settlement-a-${suffix}`;
    const companyB = `settlement-b-${suffix}`;
    const customerA = `settlement-customer-a-${suffix}`;
    const customerB = `settlement-customer-b-${suffix}`;
    const quoteA = `settlement-quote-a-${suffix}`;
    const quoteB = `settlement-quote-b-${suffix}`;
    const quoteLineA = `settlement-quote-line-a-${suffix}`;
    const situationA = `settlement-situation-a-${suffix}`;
    const situationB = `settlement-situation-b-${suffix}`;
    const finalA = `settlement-final-a-${suffix}`;
    const paymentA = `settlement-payment-a-${suffix}`;
    const creditA = `settlement-credit-a-${suffix}`;
    const identityA = legalIdentity();
    const identityB = legalIdentity();
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;

    const situationCreditData = () => ({
      id: creditA,
      companyId: companyA,
      customerId: customerA,
      kind: 'credit_note' as const,
      status: 'issued' as const,
      number: 'A-2026-SITUATION-A',
      issuedAt: new Date('2026-07-20T00:00:00.000Z'),
      dueAt: new Date('2026-08-19T00:00:00.000Z'),
      parentQuoteId: quoteA,
      sourceInvoiceId: situationA,
      sourceInvoiceKind: 'situation' as const,
      sourceInvoiceNumber: 'F-2026-SITUATION-A',
      sourceInvoiceIssuedAt: new Date('2026-07-10T00:00:00.000Z'),
      situationOrder: 1,
      settlementSemanticsVersion: 2,
      totalsHt: 2_000,
      totalsVat: 400,
      totalsTtc: 2_400,
      totalsNetToPay: 2_400,
      totalsDuePayableCents: 2_400,
      vatByRate: { '20': 400 },
      vatTreatmentAtIssuance: 'standard',
      frenchBillingModeAtIssuance: 'S1',
    });

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (runtime non-BYPASSRLS) et DIRECT_URL sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      workerA = new PrismaService({ datasourceUrl: runtimeUrl });
      workerB = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([admin.$connect(), workerA.$connect(), workerB.$connect()]);

      await admin.company.createMany({
        data: [
          {
            id: companyA,
            name: 'Settlement certification A',
            legalForm: 'EI',
            siren: identityA.siren,
            siret: identityA.siret,
            trade: 'autre',
            vatRegime: 'reel_normal',
            addrLine1: '1 rue de la Certification',
            addrZip: '75001',
            addrCity: 'Paris',
          },
          {
            id: companyB,
            name: 'Settlement certification B',
            legalForm: 'EI',
            siren: identityB.siren,
            siret: identityB.siret,
            trade: 'autre',
            vatRegime: 'reel_normal',
            addrLine1: '2 rue de la Certification',
            addrZip: '69001',
            addrCity: 'Lyon',
          },
        ],
      });
      await admin.customer.createMany({
        data: [
          {
            id: customerA,
            companyId: companyA,
            type: 'b2b',
            name: 'Client certification A',
            addrLine1: '3 rue A',
            addrZip: '75003',
            addrCity: 'Paris',
          },
          {
            id: customerB,
            companyId: companyB,
            type: 'b2b',
            name: 'Client certification B',
            addrLine1: '4 rue B',
            addrZip: '69004',
            addrCity: 'Lyon',
          },
        ],
      });
      await admin.quote.createMany({
        data: [
          {
            id: quoteA,
            companyId: companyA,
            customerId: customerA,
            status: 'signed',
            number: 'D-2026-SETTLEMENT-A',
            issuedAt: new Date('2026-07-01T00:00:00.000Z'),
            signerName: 'Client A',
            signedAt: new Date('2026-07-01T09:00:00.000Z'),
            signatureCustomerType: 'b2b',
          },
          {
            id: quoteB,
            companyId: companyB,
            customerId: customerB,
            status: 'signed',
            number: 'D-2026-SETTLEMENT-B',
            issuedAt: new Date('2026-07-01T00:00:00.000Z'),
            signerName: 'Client B',
            signedAt: new Date('2026-07-01T09:00:00.000Z'),
            signatureCustomerType: 'b2b',
          },
        ],
      });
      await admin.lineItem.create({
        data: {
          id: quoteLineA,
          quoteId: quoteA,
          position: 0,
          label: 'Lot contractuel',
          category: 'labor',
          qty: 1,
          unitPriceHt: 10_000,
          vatRate: 20,
        },
      });
      await admin.invoice.createMany({
        data: [
          {
            id: situationA,
            companyId: companyA,
            customerId: customerA,
            kind: 'situation',
            status: 'issued',
            number: 'F-2026-SITUATION-A',
            issuedAt: new Date('2026-07-10T00:00:00.000Z'),
            dueAt: new Date('2026-08-09T00:00:00.000Z'),
            parentQuoteId: quoteA,
            situationOrder: 1,
            settlementSemanticsVersion: 2,
            totalsHt: 2_000,
            totalsVat: 400,
            totalsTtc: 2_400,
            totalsNetToPay: 2_400,
            totalsDuePayableCents: 2_400,
            vatByRate: { '20': 400 },
            vatTreatmentAtIssuance: 'standard',
            frenchBillingModeAtIssuance: 'S1',
          },
          {
            id: situationB,
            companyId: companyB,
            customerId: customerB,
            kind: 'situation',
            status: 'issued',
            number: 'F-2026-SITUATION-B',
            issuedAt: new Date('2026-07-10T00:00:00.000Z'),
            dueAt: new Date('2026-08-09T00:00:00.000Z'),
            parentQuoteId: quoteB,
            situationOrder: 1,
            settlementSemanticsVersion: 2,
            totalsHt: 2_000,
            totalsVat: 400,
            totalsTtc: 2_400,
            totalsNetToPay: 2_400,
            totalsDuePayableCents: 2_400,
            vatByRate: { '20': 400 },
            vatTreatmentAtIssuance: 'standard',
            frenchBillingModeAtIssuance: 'S1',
          },
        ],
      });

      const final = Invoice.rehydrate({
        id: finalA,
        companyId: companyA,
        customerId: customerA,
        kind: 'final',
        status: 'draft',
        lines: [
          {
            id: `settlement-final-line-${suffix}`,
            sourceQuoteLineId: quoteLineA,
            label: 'Solde du lot contractuel',
            category: 'labor',
            qty: 1,
            unitPriceHT: 10_000,
            vatRate: 20,
          },
        ],
        number: null,
        frozenTotals: null,
        settlementSemanticsVersion: 2,
        mentions: [],
        issuedAt: null,
        dueAt: null,
        paid: 0,
        depositPct: null,
        parentQuoteId: quoteA,
        depositDeductionCents: 2_400,
        situationDeductionCents: 2_400,
        depositInvoiceId: situationA,
        precedingInvoices: [
          {
            invoiceId: situationA,
            kind: 'situation',
            number: 'F-2026-SITUATION-A',
            issuedAt: '2026-07-10',
          },
        ],
      });
      await workerA.withTenant(companyA, async () => {
        await new PrismaInvoiceRepository(workerA).save(final);
      });
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin) {
          await admin.payment.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
          await admin.invoicePredecessor.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
          await admin.lineItem.deleteMany({ where: { invoiceId: finalA } });
          await admin.invoice.deleteMany({
            where: { id: { in: [finalA, situationA, situationB] } },
          });
          await admin.lineItem.deleteMany({ where: { quoteId: { in: [quoteA, quoteB] } } });
          await admin.quote.deleteMany({ where: { id: { in: [quoteA, quoteB] } } });
          await admin.customer.deleteMany({ where: { id: { in: [customerA, customerB] } } });
          await admin.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
        }
      } finally {
        await Promise.allSettled([workerA?.$disconnect(), workerB?.$disconnect(), admin?.$disconnect()]);
      }
    });

    it('round-trip exact V2 : créance, ligne source et antécédent ordonné', async () => {
      const reloaded = await workerA.withTenant(companyA, () =>
        new PrismaInvoiceRepository(workerA).findById(finalA),
      );
      expect(reloaded?.settlementSemanticsVersion).toBe(2);
      expect(reloaded?.totals()).toMatchObject({ netToPay: 12_000, duePayableCents: 12_000 });
      expect(reloaded?.lines[0]?.sourceQuoteLineId).toBe(quoteLineA);
      expect(reloaded?.precedingInvoices).toEqual([
        {
          invoiceId: situationA,
          kind: 'situation',
          number: 'F-2026-SITUATION-A',
          issuedAt: '2026-07-10',
        },
      ]);

      const row = await admin.invoice.findUniqueOrThrow({ where: { id: finalA } });
      expect(row.settlementSemanticsVersion).toBe(2);
      expect(row.totalsDuePayableCents).toBe(12_000);
    });

    it('round-trip exact d’un paiement ventilé et isolation du tenant voisin', async () => {
      const payment = Payment.record({
        id: paymentA,
        companyId: companyA,
        invoiceId: situationA,
        amount: 10_000,
        method: 'transfer',
        receivedAt: '2026-07-21T12:00:00.000Z',
        idempotencyKey: `settlement-${suffix}`,
        ordinaryReceivableCents: 7_500,
        retentionReceivableCents: 2_500,
      });
      if (!payment.ok) throw new Error('fixture payment V2 invalide');
      const repoA = new PrismaPaymentRepository(workerA);
      await workerA.withTenant(companyA, () => repoA.save(payment.value));
      const persisted = await workerA.withTenant(companyA, () => repoA.findById(companyA, paymentA));
      expect(persisted).toMatchObject({
        ordinaryReceivableCents: 7_500,
        retentionReceivableCents: 2_500,
      });

      await workerB.withTenant(companyB, async () => {
        await expect(new PrismaInvoiceRepository(workerB).findById(finalA)).resolves.toBeNull();
        await expect(new PrismaPaymentRepository(workerB).findById(companyA, paymentA)).resolves.toBeNull();
        await expect(
          workerB.client().invoicePredecessor.count({ where: { invoiceId: finalA } }),
        ).resolves.toBe(0);
      });
    });

    it('refuse somme paiement invalide, sources inter-tenant et snapshot forgé', async () => {
      await expect(
        admin.payment.create({
          data: {
            id: `invalid-payment-${suffix}`,
            companyId: companyA,
            invoiceId: finalA,
            amount: 1_000,
            method: 'cash',
            receivedAt: new Date('2026-07-21T12:00:00.000Z'),
            ordinaryReceivableCents: 900,
            retentionReceivableCents: 200,
          },
        }),
      ).rejects.toBeDefined();

      await expect(
        admin.invoice.update({
          where: { id: finalA },
          data: { totalsDuePayableCents: 12_001 },
        }),
      ).rejects.toBeDefined();
      await expect(
        admin.invoice.update({
          where: { id: finalA },
          data: { settlementSemanticsVersion: 1 },
        }),
      ).rejects.toBeDefined();

      await expect(
        admin.lineItem.update({
          where: { id: quoteLineA },
          data: { id: `renamed-source-line-${suffix}` },
        }),
      ).rejects.toBeDefined();

      await expect(
        admin.lineItem.create({
          data: {
            id: `cross-tenant-derived-line-${suffix}`,
            invoiceId: situationB,
            sourceQuoteLineId: quoteLineA,
            position: 0,
            label: 'Ligne inter-tenant interdite',
            category: 'labor',
            qty: 1,
            unitPriceHt: 1_000,
            vatRate: 20,
          },
        }),
      ).rejects.toBeDefined();

      await expect(
        admin.invoicePredecessor.create({
          data: {
            companyId: companyA,
            invoiceId: finalA,
            sourceInvoiceId: situationB,
            kind: 'situation',
            number: 'F-2026-SITUATION-B',
            issuedAt: new Date('2026-07-10T00:00:00.000Z'),
            position: 1,
          },
        }),
      ).rejects.toBeDefined();

      await expect(
        admin.invoicePredecessor.create({
          data: {
            companyId: companyA,
            invoiceId: finalA,
            sourceInvoiceId: situationA,
            kind: 'situation',
            number: 'F-2026-FORGE',
            issuedAt: new Date('2026-07-10T00:00:00.000Z'),
            position: 1,
          },
        }),
      ).rejects.toBeDefined();
    });

    it('fige les prédécesseurs après émission sans laisser la tentative modifier la cible', async () => {
      await expect(
        admin.$transaction(async (tx) => {
          await tx.invoice.create({ data: situationCreditData() });
          await tx.invoice.update({
            where: { id: finalA },
            data: {
              status: 'issued',
              number: 'F-2026-FINAL-A',
              issuedAt: new Date('2026-07-21T00:00:00.000Z'),
              dueAt: new Date('2026-08-20T00:00:00.000Z'),
              vatTreatmentAtIssuance: 'standard',
              frenchBillingModeAtIssuance: 'S1',
            },
          });
        }),
      ).rejects.toBeDefined();
      await expect(admin.invoice.findUnique({ where: { id: creditA } })).resolves.toBeNull();

      await expect(
        admin.$transaction(async (tx) => {
          await tx.invoice.update({
            where: { id: finalA },
            data: {
              status: 'issued',
              number: 'F-2026-FINAL-A',
              issuedAt: new Date('2026-07-21T00:00:00.000Z'),
              dueAt: new Date('2026-08-20T00:00:00.000Z'),
              depositDeductionCents: 2_401,
              vatTreatmentAtIssuance: 'standard',
              frenchBillingModeAtIssuance: 'S1',
            },
          });
        }),
      ).rejects.toBeDefined();

      await expect(
        admin.$transaction(async (tx) => {
          await tx.invoice.update({
            where: { id: situationA },
            data: { status: 'cancelled' },
          });
          await tx.invoice.update({
            where: { id: finalA },
            data: {
              status: 'issued',
              number: 'F-2026-FINAL-A',
              issuedAt: new Date('2026-07-21T00:00:00.000Z'),
              dueAt: new Date('2026-08-20T00:00:00.000Z'),
              vatTreatmentAtIssuance: 'standard',
              frenchBillingModeAtIssuance: 'S1',
            },
          });
        }),
      ).rejects.toBeDefined();
      await expect(admin.invoice.findUniqueOrThrow({ where: { id: situationA } }))
        .resolves.toMatchObject({ status: 'issued' });
      await expect(admin.invoice.findUniqueOrThrow({ where: { id: finalA } }))
        .resolves.toMatchObject({ status: 'draft', number: null });

      await workerA.withTenant(companyA, async () => {
        await expect(workerA.client().invoice.delete({ where: { id: situationA } }))
          .rejects.toBeDefined();
      });
      await expect(admin.invoice.findUniqueOrThrow({ where: { id: situationA } }))
        .resolves.toMatchObject({ status: 'issued' });

      await expect(
        admin.$transaction(async (tx) => {
          await tx.invoice.update({
            where: { id: finalA },
            data: {
              status: 'issued',
              number: 'F-2026-FINAL-A',
              issuedAt: new Date('2026-07-21T00:00:00.000Z'),
              dueAt: new Date('2026-08-20T00:00:00.000Z'),
              vatTreatmentAtIssuance: 'standard',
              frenchBillingModeAtIssuance: 'S1',
            },
          });
          const lateSourceId = `settlement-situation-late-${suffix}`;
          await tx.invoice.create({
            data: {
              id: lateSourceId,
              companyId: companyA,
              customerId: customerA,
              kind: 'situation',
              status: 'issued',
              number: 'F-2026-SITUATION-LATE',
              issuedAt: new Date('2026-07-22T00:00:00.000Z'),
              dueAt: new Date('2026-08-21T00:00:00.000Z'),
              parentQuoteId: quoteA,
              situationOrder: 2,
              settlementSemanticsVersion: 2,
              totalsHt: 1_000,
              totalsVat: 200,
              totalsTtc: 1_200,
              totalsNetToPay: 1_200,
              totalsDuePayableCents: 1_200,
              vatByRate: { '20': 200 },
              vatTreatmentAtIssuance: 'standard',
              frenchBillingModeAtIssuance: 'S1',
            },
          });
          await tx.invoicePredecessor.create({
            data: {
              companyId: companyA,
              invoiceId: finalA,
              sourceInvoiceId: lateSourceId,
              kind: 'situation',
              number: 'F-2026-SITUATION-LATE',
              issuedAt: new Date('2026-07-22T00:00:00.000Z'),
              position: 1,
            },
          });
        }),
      ).rejects.toBeDefined();
      await expect(admin.invoice.findUniqueOrThrow({ where: { id: finalA } }))
        .resolves.toMatchObject({ status: 'draft', number: null });

      await expect(
        admin.$transaction(async (tx) => {
          await tx.invoice.update({
            where: { id: finalA },
            data: {
              status: 'issued',
              number: 'F-2026-FINAL-A',
              issuedAt: new Date('2026-07-21T00:00:00.000Z'),
              dueAt: new Date('2026-08-20T00:00:00.000Z'),
              vatTreatmentAtIssuance: 'standard',
              frenchBillingModeAtIssuance: 'S1',
            },
          });
          await tx.invoicePredecessor.deleteMany({ where: { companyId: companyA, invoiceId: finalA } });
        }),
      ).rejects.toBeDefined();
      await expect(admin.invoice.findUniqueOrThrow({ where: { id: finalA } }))
        .resolves.toMatchObject({ status: 'draft', number: null });
    });

    it('accepte le graphe exact, puis interdit d’avoirer seul un antécédent absorbé', async () => {
      const rollbackMarker = 'settlement-positive-path-rollback';
      await expect(
        admin.$transaction(async (tx) => {
          await tx.invoice.update({
            where: { id: finalA },
            data: {
              status: 'issued',
              number: 'F-2026-FINAL-A',
              issuedAt: new Date('2026-07-21T00:00:00.000Z'),
              dueAt: new Date('2026-08-20T00:00:00.000Z'),
              vatTreatmentAtIssuance: 'standard',
              frenchBillingModeAtIssuance: 'S1',
            },
          });
          await expect(tx.invoice.findUniqueOrThrow({ where: { id: finalA } }))
            .resolves.toMatchObject({ status: 'issued' });
          throw new Error(rollbackMarker);
        }),
      ).rejects.toThrow(rollbackMarker);

      await expect(
        admin.$transaction(async (tx) => {
          await tx.invoice.update({
            where: { id: finalA },
            data: {
              status: 'issued',
              number: 'F-2026-FINAL-A',
              issuedAt: new Date('2026-07-21T00:00:00.000Z'),
              dueAt: new Date('2026-08-20T00:00:00.000Z'),
              vatTreatmentAtIssuance: 'standard',
              frenchBillingModeAtIssuance: 'S1',
            },
          });
          await tx.invoice.create({ data: situationCreditData() });
        }),
      ).rejects.toBeDefined();
      await expect(admin.invoice.findUniqueOrThrow({ where: { id: finalA } }))
        .resolves.toMatchObject({ status: 'draft', number: null });
      await expect(admin.invoice.findUnique({ where: { id: creditA } })).resolves.toBeNull();
    });

    it('supprime un brouillon et ses preuves dans une seule transaction verrouillée', async () => {
      await workerA.withTenant(companyA, async () => {
        await new PrismaInvoiceRepository(workerA).deleteById(finalA);
      });
      await expect(admin.invoice.findUnique({ where: { id: finalA } })).resolves.toBeNull();
      await expect(
        admin.invoicePredecessor.count({ where: { companyId: companyA, invoiceId: finalA } }),
      ).resolves.toBe(0);
    });
  },
);
