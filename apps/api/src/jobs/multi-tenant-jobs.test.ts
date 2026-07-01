import { describe, expect, it, vi } from 'vitest';
import type { Company, Customer, Invoice, NotificationPort } from '@bob/core';
import { NotificationDeliveryService } from './notification-delivery.service';
import { RelanceService } from './relance.service';
import { DocumentArchiveService } from './document-archive.service';
import type { BackendService } from '../backend.service';
import type { AppLogger } from '../observability/logger';
import { InMemoryPersistence } from '../persistence/persistence';

const logger = {
  audit: vi.fn(),
  warn: vi.fn(),
} as unknown as AppLogger;

function fakeCompany(id: string): Company {
  return { id } as Company;
}

function fakeCustomer(id: string, companyId: string, email: string): Customer {
  return {
    id,
    companyId,
    name: `Client ${id}`,
    toProps: () => ({ email }),
  } as unknown as Customer;
}

function overdueInvoice(id: string, companyId: string, customerId: string): Invoice {
  return {
    id,
    companyId,
    customerId,
    status: 'issued',
    dueAt: '2026-06-01',
    number: `F-${id}`,
    paid: 0,
    totals: () => ({ netToPay: 12_000 }),
  } as unknown as Invoice;
}

describe('scheduled jobs multi-tenant', () => {
  it('livre les notifications dues pour chaque société connue', async () => {
    const persistence = new InMemoryPersistence();
    persistence.companies.seed(fakeCompany('co-1'));
    persistence.companies.seed(fakeCompany('co-2'));
    const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
    const service = new NotificationDeliveryService(persistence, notifier, logger);

    await service.enqueue({
      companyId: 'co-1',
      kind: 'quote-signature',
      dedupeKey: 'quote:q-1',
      notification: { channel: 'email', to: 'a@example.com', subject: 'A', body: 'A' },
    });
    await service.enqueue({
      companyId: 'co-2',
      kind: 'quote-signature',
      dedupeKey: 'quote:q-2',
      notification: { channel: 'email', to: 'b@example.com', subject: 'B', body: 'B' },
    });

    const result = await service.runAllCompanies(10);

    expect(result).toEqual({ companies: 2, scanned: 2, sent: 2, failed: 0 });
    expect(notifier.send).toHaveBeenCalledTimes(2);
  });

  it('prépare les relances en parcourant toutes les sociétés', async () => {
    const persistence = new InMemoryPersistence();
    persistence.companies.seed(fakeCompany('co-1'));
    persistence.companies.seed(fakeCompany('co-2'));
    persistence.customers.seed([fakeCustomer('cu-1', 'co-1', 'a@example.com'), fakeCustomer('cu-2', 'co-2', 'b@example.com')]);
    await persistence.invoices.save(overdueInvoice('inv-1', 'co-1', 'cu-1'));
    await persistence.invoices.save(overdueInvoice('inv-2', 'co-2', 'cu-2'));
    const delivery = {
      enqueue: vi.fn(async (input: { notification: unknown }) => ({
        id: 'job',
        status: 'pending',
        notification: input.notification,
      })),
      tryDeliver: vi.fn(async () => true),
    } as unknown as NotificationDeliveryService;
    const service = new RelanceService(persistence, delivery, logger);

    const result = await service.runRelances();

    expect(result).toEqual({ companies: 2, scanned: 2, sent: 2 });
    expect(delivery.enqueue).toHaveBeenCalledTimes(2);
    expect(delivery.tryDeliver).toHaveBeenCalledTimes(2);
  });

  it('lance les archives documentaires sur chaque société connue', async () => {
    const persistence = new InMemoryPersistence();
    persistence.companies.seed(fakeCompany('co-1'));
    persistence.companies.seed(fakeCompany('co-2'));
    const backend = {
      runDocumentArchiveJobs: vi
        .fn<BackendService['runDocumentArchiveJobs']>()
        .mockResolvedValueOnce({ ok: true, value: { scanned: 1, archived: 1, failed: 0 } })
        .mockResolvedValueOnce({ ok: true, value: { scanned: 2, archived: 0, failed: 1 } }),
    } as unknown as BackendService;
    const service = new DocumentArchiveService(backend, persistence, logger);

    const result = await service.runAllCompanies(10);

    expect(result).toEqual({ companies: 2, scanned: 3, archived: 1, failed: 1 });
    expect(backend.runDocumentArchiveJobs).toHaveBeenCalledWith({ companyId: 'co-1', limit: 10 });
    expect(backend.runDocumentArchiveJobs).toHaveBeenCalledWith({ companyId: 'co-2', limit: 10 });
  });
});
