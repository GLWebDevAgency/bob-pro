import { describe, expect, it, vi } from 'vitest';
import type { Company, Customer, Invoice, NotificationPort } from '@bob/core';
import {
  TransmissionReminderService,
  invoiceIdOfTransmissionReminderDedupeKey,
  invoiceTransmissionReminderDedupeKey,
  isTransmissionReminderDue,
} from './transmission-reminder.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';
import type { AppLogger } from '../observability/logger';
import type { SupabaseAdminPort } from '../auth/supabase-admin';
import { InMemoryPersistence } from '../persistence/persistence.testing';

/**
 * PR-03 « Encaisser » — rappel de dépôt portail/Chorus J+2 : un seul rappel par facture (clé
 * stable dédupliquée), extinction par le dépôt déclaré (avant l'enqueue ET à la livraison),
 * jamais de rappel pour le canal email. Cas RATP EPIC : dépôt Cegedim oublié = 60 j perdus.
 */

const logger = { audit: vi.fn(), warn: vi.fn() } as unknown as AppLogger;

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function invoice(
  id: string,
  customerId: string,
  opts: {
    issuedDaysAgo?: number;
    depositedAt?: string | null;
    status?: string;
    kind?: string;
  } = {},
): Invoice {
  const depositedAt = opts.depositedAt ?? null;
  return {
    id,
    companyId: 'company-user1',
    customerId,
    kind: opts.kind ?? 'final',
    status: opts.status ?? 'issued',
    parentQuoteId: null,
    dueAt: daysAgo(-30),
    number: `F-${id}`,
    issuedAt: daysAgo(opts.issuedDaysAgo ?? 3),
    paid: 0,
    transmission: depositedAt === null ? null : { depositedAt, acceptedAt: null },
    totals: () => ({ ht: 100_000, vatByRate: {}, vat: 20_000, ttc: 120_000, netToPay: 120_000 }),
  } as unknown as Invoice;
}

function customer(id: string, channelType: 'email' | 'chorus' | 'portail' | null): Customer {
  return {
    id,
    companyId: 'company-user1',
    name: `RATP ${id}`,
    type: 'b2g',
    billingChannel: channelType === null ? undefined : { type: channelType },
    toProps: () => ({ email: 'compta@ratp.fr' }),
  } as unknown as Customer;
}

async function makeService(setup: { invoices: Invoice[]; customers: Customer[] }) {
  const persistence = new InMemoryPersistence();
  persistence.companies.seed({
    id: 'company-user1',
    isClosed: () => false,
  } as unknown as Company);
  persistence.customers.seed(setup.customers);
  for (const inv of setup.invoices) await persistence.invoices.save(inv);
  const notifier = {
    send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined),
  } satisfies NotificationPort;
  const delivery = new NotificationDeliveryService(
    persistence,
    notifier,
    new ScheduledTenantDirectory(persistence, logger),
    logger,
  );
  const supabaseAdmin = {
    getUserIdentity: vi.fn(async () => ({ email: 'artisan@fly-services.fr', displayName: null })),
  } as unknown as SupabaseAdminPort;
  const service = new TransmissionReminderService(
    persistence,
    delivery,
    new ScheduledTenantDirectory(persistence, logger),
    supabaseAdmin,
    logger,
  );
  return { service, delivery, persistence, notifier };
}

describe('isTransmissionReminderDue (pure)', () => {
  const base = {
    kind: 'final',
    status: 'issued',
    number: 'F-1',
    issuedAt: '2026-07-20',
    transmission: null,
  } as unknown as Invoice;

  it('J+2 canal chorus/portail sans dépôt : dû — jamais pour le canal email', () => {
    expect(
      isTransmissionReminderDue({ invoice: base, billingChannelType: 'chorus', today: '2026-07-22' }),
    ).toBe(true);
    expect(
      isTransmissionReminderDue({ invoice: base, billingChannelType: 'portail', today: '2026-07-22' }),
    ).toBe(true);
    expect(
      isTransmissionReminderDue({ invoice: base, billingChannelType: 'email', today: '2026-07-22' }),
    ).toBe(false);
    expect(
      isTransmissionReminderDue({ invoice: base, billingChannelType: null, today: '2026-07-22' }),
    ).toBe(false);
  });

  it('J+1 : pas encore dû ; dépôt déclaré : plus jamais dû (extinction par l’état réel)', () => {
    expect(
      isTransmissionReminderDue({ invoice: base, billingChannelType: 'chorus', today: '2026-07-21' }),
    ).toBe(false);
    const deposited = {
      ...base,
      transmission: { depositedAt: '2026-07-21', acceptedAt: null },
    } as unknown as Invoice;
    expect(
      isTransmissionReminderDue({ invoice: deposited, billingChannelType: 'chorus', today: '2026-07-25' }),
    ).toBe(false);
  });

  it('hors périmètre : brouillon, annulée, payée, avoir — mais une pièce en RETARD reste due', () => {
    const draft = { ...base, number: null, issuedAt: null } as unknown as Invoice;
    expect(isTransmissionReminderDue({ invoice: draft, billingChannelType: 'chorus', today: '2026-07-25' })).toBe(false);
    const paid = { ...base, status: 'paid' } as unknown as Invoice;
    expect(isTransmissionReminderDue({ invoice: paid, billingChannelType: 'chorus', today: '2026-07-25' })).toBe(false);
    const credit = { ...base, kind: 'credit_note' } as unknown as Invoice;
    expect(isTransmissionReminderDue({ invoice: credit, billingChannelType: 'chorus', today: '2026-07-25' })).toBe(false);
    const late = { ...base, status: 'late' } as unknown as Invoice;
    expect(isTransmissionReminderDue({ invoice: late, billingChannelType: 'chorus', today: '2026-07-25' })).toBe(true);
  });
});

describe('TransmissionReminderService — cron 6 h', () => {
  it('facture émise J+3 canal chorus sans dépôt : UN rappel interne, dédupliqué au rejeu du cron', async () => {
    const { service, delivery, persistence, notifier } = await makeService({
      invoices: [invoice('inv-ratp', 'cu-epic', { issuedDaysAgo: 3 })],
      customers: [customer('cu-epic', 'chorus')],
    });

    const first = await service.runForCompany('company-user1');
    expect(first).toEqual({ queued: 1, deduplicated: 0 });
    const jobs = await persistence.notificationJobs.listRecent('company-user1', 10);
    expect(jobs[0]).toMatchObject({
      kind: 'invoice-transmission-reminder',
      dedupeKey: 'invoice:inv-ratp:transmission-reminder',
      status: 'pending',
    });

    // Livraison réelle (worker) : e-mail interne à l'artisan — jamais au client.
    const delivered = await delivery.runForCompany('company-user1');
    expect(delivered).toEqual({ scanned: 1, sent: 1, failed: 0 });
    const sent = (notifier.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      to: string;
      subject: string;
    };
    expect(sent.to).toBe('artisan@fly-services.fr');
    expect(sent.subject).toContain('dépôt');

    // Rejeu du cron le lendemain : clé stable → dédupliqué, JAMAIS un second rappel.
    const second = await service.runForCompany('company-user1');
    expect(second).toEqual({ queued: 0, deduplicated: 1 });
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it('extinction : dépôt déclaré → aucun rappel ; canal email → aucun rappel ; J+1 → pas encore', async () => {
    const { service, persistence } = await makeService({
      invoices: [
        invoice('inv-deposee', 'cu-epic', { issuedDaysAgo: 5, depositedAt: daysAgo(1) }),
        invoice('inv-email', 'cu-cap', { issuedDaysAgo: 5 }),
        invoice('inv-fraiche', 'cu-epic', { issuedDaysAgo: 1 }),
      ],
      customers: [customer('cu-epic', 'chorus'), customer('cu-cap', 'email')],
    });

    const result = await service.runForCompany('company-user1');
    expect(result).toEqual({ queued: 0, deduplicated: 0 });
    expect(await persistence.notificationJobs.listRecent('company-user1', 10)).toEqual([]);
  });

  it('revalidation à la livraison : dépôt déclaré APRÈS l’enqueue → job ANNULÉ, jamais livré', async () => {
    const { service, delivery, persistence, notifier } = await makeService({
      invoices: [invoice('inv-course', 'cu-epic', { issuedDaysAgo: 3 })],
      customers: [customer('cu-epic', 'chorus')],
    });

    await service.runForCompany('company-user1');
    // Le dépôt est déclaré entre l'enqueue (6 h) et le passage du worker (*/5 min).
    const stored = await persistence.invoices.findById('inv-course');
    (stored as unknown as { transmission: { depositedAt: string; acceptedAt: null } }).transmission =
      { depositedAt: daysAgo(0), acceptedAt: null };
    await persistence.invoices.save(stored!);

    const delivered = await delivery.runForCompany('company-user1');
    expect(delivered.sent).toBe(0);
    expect(notifier.send).not.toHaveBeenCalled();
    const jobs = await persistence.notificationJobs.listRecent('company-user1', 10);
    // Un job annulé ne surface plus dans le fil (C25) — plus aucun rappel en attente.
    expect(jobs.filter((job) => job.status === 'pending')).toEqual([]);
  });

  it('clé de dédup : construction et inverse fail-closed', () => {
    const key = invoiceTransmissionReminderDedupeKey('inv-9');
    expect(key).toBe('invoice:inv-9:transmission-reminder');
    expect(invoiceIdOfTransmissionReminderDedupeKey(key)).toBe('inv-9');
    expect(invoiceIdOfTransmissionReminderDedupeKey('invoice:inv-9:relance:auto')).toBeNull();
    expect(invoiceIdOfTransmissionReminderDedupeKey('quote:inv-9:transmission-reminder')).toBeNull();
  });
});
