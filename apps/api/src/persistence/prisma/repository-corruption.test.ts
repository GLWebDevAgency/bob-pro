import { describe, expect, it, vi } from 'vitest';
import { hypothese, manquant, sourceFiable } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import type { PrismaService } from './prisma.service';
import { companyPropsToCreate } from './mappers';
import {
  PersistedDataCorruptionError,
  PrismaCompanyRepository,
  PrismaCustomerRepository,
  PrismaFiscalProfileRepository,
  PrismaPaymentRepository,
} from './repositories';

const NOW = '2026-07-18T10:00:00.000Z';

function prismaService(client: object): PrismaService {
  return { client: () => client } as unknown as PrismaService;
}

const invalidCompanyRow = {
  ...companyPropsToCreate(MERCIER_PROPS),
  siren: 'invalide',
};

const invalidCustomerRow = {
  id: 'customer-corrupt',
  companyId: 'company-1',
  type: 'b2b',
  name: '',
  siren: null,
  isInternational: false,
  addrLine1: '1 rue Réelle',
  addrZip: '75001',
  addrCity: 'Paris',
  email: null,
  phone: null,
  contactName: null,
  ptLabel: null,
  isSubcontractingBtp: false,
};

const invalidPaymentRow = {
  id: 'payment-corrupt',
  companyId: 'company-1',
  invoiceId: 'invoice-1',
  amount: 0,
  method: 'transfer',
  receivedAt: new Date(NOW),
  idempotencyKey: null,
};

const invalidFiscalProfileRow = {
  companyId: 'company-1',
  legalForm: sourceFiable('SASU', NOW, 'insee_siret'),
  taxRegime: manquant(),
  socialStatus: hypothese('tns', NOW),
  activityNature: manquant(),
  vatRegime: manquant(),
  acre: manquant(),
  versementLiberatoire: manquant(),
  fiscalYearEnd: manquant(),
};

function expectCorruption(
  promise: Promise<unknown>,
  aggregate: PersistedDataCorruptionError['aggregate'],
  recordId: string,
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: 'PersistedDataCorruptionError',
    code: 'PERSISTED_DATA_CORRUPTION',
    aggregate,
    recordId,
  });
}

describe('Prisma repositories — persisted rows fail closed', () => {
  it('distinguishes an absent company from a corrupt company', async () => {
    const absent = new PrismaCompanyRepository(
      prismaService({ company: { findUnique: vi.fn().mockResolvedValue(null) } }),
    );
    await expect(absent.findById('missing')).resolves.toBeNull();

    const corrupt = new PrismaCompanyRepository(
      prismaService({ company: { findUnique: vi.fn().mockResolvedValue(invalidCompanyRow) } }),
    );
    await expectCorruption(corrupt.findById(invalidCompanyRow.id), 'company', invalidCompanyRow.id);
  });

  it('never removes a corrupt company from a list', async () => {
    const repository = new PrismaCompanyRepository(
      prismaService({ company: { findMany: vi.fn().mockResolvedValue([invalidCompanyRow]) } }),
    );
    await expectCorruption(repository.list(), 'company', invalidCompanyRow.id);
  });

  it('distinguishes an absent customer from a corrupt customer', async () => {
    const absent = new PrismaCustomerRepository(
      prismaService({ customer: { findUnique: vi.fn().mockResolvedValue(null) } }),
    );
    await expect(absent.findById('missing')).resolves.toBeNull();

    const corrupt = new PrismaCustomerRepository(
      prismaService({ customer: { findUnique: vi.fn().mockResolvedValue(invalidCustomerRow) } }),
    );
    await expectCorruption(
      corrupt.findById(invalidCustomerRow.id),
      'customer',
      invalidCustomerRow.id,
    );
  });

  it('never removes a corrupt customer from a tenant list', async () => {
    const repository = new PrismaCustomerRepository(
      prismaService({ customer: { findMany: vi.fn().mockResolvedValue([invalidCustomerRow]) } }),
    );
    await expectCorruption(repository.listByCompany('company-1'), 'customer', invalidCustomerRow.id);
  });

  it('never turns a corrupt persisted payment into a missing payment', async () => {
    const repository = new PrismaPaymentRepository(
      prismaService({ payment: { findFirst: vi.fn().mockResolvedValue(invalidPaymentRow) } }),
    );
    await expectCorruption(
      repository.findById('company-1', invalidPaymentRow.id),
      'payment',
      invalidPaymentRow.id,
    );
  });

  it('never drops a corrupt payment from financial aggregates', async () => {
    const repository = new PrismaPaymentRepository(
      prismaService({ payment: { findMany: vi.fn().mockResolvedValue([invalidPaymentRow]) } }),
    );
    await expectCorruption(repository.listByCompany('company-1'), 'payment', invalidPaymentRow.id);
  });

  it('distinguishes an absent fiscal profile from a corrupt persisted profile', async () => {
    const absent = new PrismaFiscalProfileRepository(
      prismaService({ fiscalProfile: { findUnique: vi.fn().mockResolvedValue(null) } }),
    );
    await expect(absent.findByCompanyId('company-1')).resolves.toBeNull();

    const corrupt = new PrismaFiscalProfileRepository(
      prismaService({
        fiscalProfile: { findUnique: vi.fn().mockResolvedValue(invalidFiscalProfileRow) },
      }),
    );
    await expectCorruption(
      corrupt.findByCompanyId('company-1'),
      'fiscal-profile',
      'company-1',
    );
  });
});
