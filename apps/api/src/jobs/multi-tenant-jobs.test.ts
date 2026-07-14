import { describe, expect, it, vi } from 'vitest';
import type { Company, Customer, Invoice, NotificationPort } from '@bob/core';
import { NotificationDeliveryService } from './notification-delivery.service';
import { RelanceService } from './relance.service';
import { DocumentArchiveService } from './document-archive.service';
import { ScheduledTenantDirectory } from './tenant-directory';
import type { BackendService } from '../backend.service';
import { requestContext, type AppLogger } from '../observability/logger';
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

/** DateOnly à `days` jours dans le passé (le plan @bob/core juge le retard vs aujourd'hui). */
function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function overdueInvoice(id: string, companyId: string, customerId: string, daysLate = 12): Invoice {
  return {
    id,
    companyId,
    customerId,
    kind: 'final',
    status: 'issued',
    parentQuoteId: null,
    dueAt: daysAgo(daysLate),
    number: `F-${id}`,
    paid: 0,
    totals: () => ({ ht: 10_000, vatByRate: {}, vat: 2_000, ttc: 12_000, netToPay: 12_000 }),
  } as unknown as Invoice;
}

describe('scheduled jobs multi-tenant', () => {
  it('utilise JOB_COMPANY_IDS comme source explicite de tenants', async () => {
    const previous = process.env.JOB_COMPANY_IDS;
    process.env.JOB_COMPANY_IDS = 'co-2, co-1, co-2';
    try {
      const directory = new ScheduledTenantDirectory(new InMemoryPersistence(), logger);

      await expect(directory.listCompanyIds()).resolves.toEqual(['co-2', 'co-1']);
    } finally {
      if (previous === undefined) delete process.env.JOB_COMPANY_IDS;
      else process.env.JOB_COMPANY_IDS = previous;
    }
  });

  it('livre les notifications dues pour chaque société connue', async () => {
    const persistence = new InMemoryPersistence();
    persistence.companies.seed(fakeCompany('co-1'));
    persistence.companies.seed(fakeCompany('co-2'));
    const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
    const service = new NotificationDeliveryService(persistence, notifier, new ScheduledTenantDirectory(persistence, logger), logger);

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

  it('prépare les relances en parcourant toutes les sociétés (politique @bob/core)', async () => {
    const persistence = new InMemoryPersistence();
    persistence.companies.seed(fakeCompany('co-1'));
    persistence.companies.seed(fakeCompany('co-2'));
    persistence.customers.seed([fakeCustomer('cu-1', 'co-1', 'a@example.com'), fakeCustomer('cu-2', 'co-2', 'b@example.com')]);
    await persistence.invoices.save(overdueInvoice('inv-1', 'co-1', 'cu-1', 12)); // J+12 → ton neutre
    await persistence.invoices.save(overdueInvoice('inv-2', 'co-2', 'cu-2', 25)); // J+25 → ton ferme
    const delivery = {
      enqueue: vi.fn(async (input: { notification: unknown }) => ({
        id: 'job',
        status: 'pending',
        notification: input.notification,
      })),
      tryDeliver: vi.fn(async () => true),
    } as unknown as NotificationDeliveryService;
    const service = new RelanceService(persistence, delivery, new ScheduledTenantDirectory(persistence, logger), logger, { autoDunningEntitlement: () => ({ allowed: true as const, plan: 'business' as const }) });

    const result = await service.runRelances();

    expect(result).toEqual({ companies: 2, scanned: 2, queued: 2, sent: 0, deduplicated: 0 });
    expect(delivery.enqueue).toHaveBeenCalledTimes(2);
    expect(delivery.tryDeliver).not.toHaveBeenCalled();
    // Le ton vient de DEFAULT_RELANCE_POLICY (@bob/core) — plus de barème local 15/30/45.
    const subjects = (delivery.enqueue as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { notification: { subject: string } }).notification.subject,
    );
    expect(subjects[0]).toContain('relance'); // neutre : « — relance »
    expect(subjects[1]).toContain('relance ferme');
  });

  it("auto_dunning non inclus au plan → le cron SAUTE le tenant sans erreur (relance manuelle non concernée)", async () => {
    const persistence = new InMemoryPersistence();
    persistence.companies.seed(fakeCompany('co-1'));
    persistence.customers.seed([fakeCustomer('cu-1', 'co-1', 'a@example.com')]);
    await persistence.invoices.save(overdueInvoice('inv-1', 'co-1', 'cu-1', 12));
    const delivery = {
      enqueue: vi.fn(),
      tryDeliver: vi.fn(),
    } as unknown as NotificationDeliveryService;
    const service = new RelanceService(persistence, delivery, new ScheduledTenantDirectory(persistence, logger), logger, { autoDunningEntitlement: () => ({ allowed: false as const, plan: 'solo' as const }) });

    const result = await service.runRelances();

    // Refus AUDITÉ, zéro relance enfilée, zéro erreur : le batch continue pour les autres tenants.
    expect(result).toEqual({ companies: 1, scanned: 0, queued: 0, sent: 0, deduplicated: 0 });
    expect(delivery.enqueue).not.toHaveBeenCalled();
  });

  it('le déclenchement HTTP reste strictement limité au tenant authentifié', async () => {
    const persistence = new InMemoryPersistence();
    persistence.companies.seed(fakeCompany('co-1'));
    persistence.companies.seed(fakeCompany('co-2'));
    persistence.customers.seed([
      fakeCustomer('cu-1', 'co-1', 'a@example.com'),
      fakeCustomer('cu-2', 'co-2', 'b@example.com'),
    ]);
    await persistence.invoices.save(overdueInvoice('inv-1', 'co-1', 'cu-1', 12));
    await persistence.invoices.save(overdueInvoice('inv-2', 'co-2', 'cu-2', 12));
    const notifier = { send: vi.fn<NotificationPort['send']>() } satisfies NotificationPort;
    const delivery = new NotificationDeliveryService(
      persistence,
      notifier,
      new ScheduledTenantDirectory(persistence, logger),
      logger,
    );
    const service = new RelanceService(
      persistence,
      delivery,
      new ScheduledTenantDirectory(persistence, logger),
      logger,
      { autoDunningEntitlement: () => ({ allowed: true as const, plan: 'business' as const }) },
    );

    const result = await requestContext.run(
      { correlationId: 'tenant-a-job', principal: { userId: 'u-1', companyId: 'co-1' } },
      () => service.runRelancesForCurrentTenant(),
    );

    expect(result).toEqual({ scanned: 1, queued: 1, sent: 0, deduplicated: 0 });
    expect(await persistence.notificationJobs.listRecent('co-1', 10)).toHaveLength(1);
    expect(await persistence.notificationJobs.listRecent('co-2', 10)).toHaveLength(0);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('mise en demeure : JAMAIS envoyée par le cron (validation humaine requise — endpoint ciblé)', async () => {
    const persistence = new InMemoryPersistence();
    persistence.companies.seed(fakeCompany('co-1'));
    persistence.customers.seed([fakeCustomer('cu-1', 'co-1', 'a@example.com')]);
    await persistence.invoices.save(overdueInvoice('inv-med', 'co-1', 'cu-1', 45)); // J+45 → mise en demeure
    const delivery = {
      enqueue: vi.fn(),
      tryDeliver: vi.fn(),
    } as unknown as NotificationDeliveryService;
    const service = new RelanceService(persistence, delivery, new ScheduledTenantDirectory(persistence, logger), logger, { autoDunningEntitlement: () => ({ allowed: true as const, plan: 'business' as const }) });

    const result = await service.runRelancesForCompany('co-1');

    expect(result).toEqual({ scanned: 1, queued: 0, sent: 0, deduplicated: 0 });
    expect(delivery.enqueue).not.toHaveBeenCalled();
    expect(logger.audit).toHaveBeenCalledWith('relance.med_awaiting_validation', expect.objectContaining({ invoiceId: 'inv-med' }));
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
    const service = new DocumentArchiveService(backend, new ScheduledTenantDirectory(persistence, logger), logger);

    const result = await service.runAllCompanies(10);

    expect(result).toEqual({ companies: 2, scanned: 3, archived: 1, failed: 1 });
    expect(backend.runDocumentArchiveJobs).toHaveBeenCalledWith({ companyId: 'co-1', limit: 10 });
    expect(backend.runDocumentArchiveJobs).toHaveBeenCalledWith({ companyId: 'co-2', limit: 10 });
  });
});
