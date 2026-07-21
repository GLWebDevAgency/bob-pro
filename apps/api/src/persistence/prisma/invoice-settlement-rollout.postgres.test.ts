import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUN_POSTGRES_CERT =
  process.env.RUN_POSTGRES_INVOICE_SETTLEMENT_ROLLOUT_CERT === 'true';

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

describe.skipIf(!RUN_POSTGRES_CERT)('Règlement facture V2 — gate de rolling deploy', () => {
  const suffix = randomUUID();
  const companyId = `settlement-rollout-company-${suffix}`;
  const customerId = `settlement-rollout-customer-${suffix}`;
  const invoiceV1Id = `settlement-rollout-v1-${suffix}`;
  const invoiceV2Id = `settlement-rollout-v2-${suffix}`;
  const siren = appendLuhnDigit(String(randomInt(10_000_000, 100_000_000)));
  const siret = appendLuhnDigit(`${siren}${String(randomInt(0, 10_000)).padStart(4, '0')}`);
  let admin: PrismaClient;

  beforeAll(async () => {
    const directUrl = process.env.DIRECT_URL;
    if (!directUrl) throw new Error('DIRECT_URL is required for the rollout certification.');
    admin = new PrismaClient({ datasourceUrl: directUrl });
    await admin.$connect();
    await admin.company.create({
      data: {
        id: companyId,
        name: 'Settlement rollout certification',
        legalForm: 'EI',
        siren,
        siret,
        trade: 'autre',
        vatRegime: 'reel_normal',
        addrLine1: '1 rue du Rollout',
        addrZip: '75001',
        addrCity: 'Paris',
      },
    });
    await admin.customer.create({
      data: {
        id: customerId,
        companyId,
        type: 'b2b',
        name: 'Client rollout',
        addrLine1: '2 rue du Rollout',
        addrZip: '75002',
        addrCity: 'Paris',
      },
    });
  });

  afterAll(async () => {
    try {
      if (admin) {
        await admin.invoice.deleteMany({ where: { id: { in: [invoiceV1Id, invoiceV2Id] } } });
        await admin.customer.deleteMany({ where: { id: customerId } });
        await admin.company.deleteMany({ where: { id: companyId } });
      }
    } finally {
      await admin?.$disconnect();
    }
  });

  it('accepte encore le writer N-1 mais refuse toute première pièce V2 avant activation', async () => {
    await expect(
      admin.invoiceSettlementProtocolState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({ activeVersion: 1, activatedAt: null, activatedByReleaseSha: null });

    await expect(
      admin.invoice.create({
        data: {
          id: invoiceV1Id,
          companyId,
          customerId,
          kind: 'invoice',
          status: 'draft',
          settlementSemanticsVersion: 1,
        },
      }),
    ).resolves.toMatchObject({ id: invoiceV1Id, settlementSemanticsVersion: 1 });

    await expect(
      admin.invoice.create({
        data: {
          id: invoiceV2Id,
          companyId,
          customerId,
          kind: 'invoice',
          status: 'draft',
          settlementSemanticsVersion: 2,
          totalsDuePayableCents: 0,
        },
      }),
    ).rejects.toBeDefined();
    await expect(admin.invoice.findUnique({ where: { id: invoiceV2Id } })).resolves.toBeNull();
  });

  it('rend le singleton V1 immuable en dehors de la transition d\'activation complète', async () => {
    await expect(
      admin.invoiceSettlementProtocolState.update({
        where: { id: 1 },
        data: { updatedAt: new Date() },
      }),
    ).rejects.toBeDefined();
    await expect(
      admin.invoiceSettlementProtocolState.delete({ where: { id: 1 } }),
    ).rejects.toBeDefined();

    await expect(
      admin.invoiceSettlementProtocolState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({ activeVersion: 1, activatedAt: null, activatedByReleaseSha: null });
  });
});
