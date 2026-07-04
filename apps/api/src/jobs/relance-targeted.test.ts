import { describe, expect, it, vi } from 'vitest';
import type { Company, Customer, Invoice, NotificationPort } from '@bob/core';
import { RelanceService } from './relance.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';
import type { AppLogger } from '../observability/logger';
import { InMemoryPersistence } from '../persistence/persistence';

const logger = { audit: vi.fn(), warn: vi.fn() } as unknown as AppLogger;

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function invoice(id: string, customerId: string, opts: { daysLate?: number; paid?: number; status?: string } = {}): Invoice {
  return {
    id,
    companyId: 'co-1',
    customerId,
    kind: 'final',
    status: opts.status ?? 'issued',
    parentQuoteId: null,
    dueAt: opts.daysLate !== undefined ? daysAgo(opts.daysLate) : daysAgo(-10), // défaut : pas échue
    number: `F-${id}`,
    paid: opts.paid ?? 0,
    totals: () => ({ ht: 100_000, vatByRate: {}, vat: 24_000, ttc: 124_000, netToPay: 124_000 }),
  } as unknown as Invoice;
}

function customer(id: string, email: string | null, type: 'b2c' | 'b2b' | 'b2g' = 'b2b'): Customer {
  return { id, companyId: 'co-1', name: `SARL ${id}`, type, toProps: () => ({ email }) } as unknown as Customer;
}

async function makeService(setup: { invoices: Invoice[]; customers: Customer[] }) {
  const persistence = new InMemoryPersistence();
  persistence.companies.seed({ id: 'co-1' } as Company);
  persistence.customers.seed(setup.customers);
  for (const inv of setup.invoices) await persistence.invoices.save(inv);
  const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
  const delivery = new NotificationDeliveryService(persistence, notifier, new ScheduledTenantDirectory(persistence, logger), logger);
  return { service: new RelanceService(persistence, delivery, new ScheduledTenantDirectory(persistence, logger), logger), persistence, notifier };
}

describe('sendRelanceForInvoice — envoi ciblé validé (C25 ②, POST /invoices/:id/relance)', () => {
  it('envoie la relance de LA facture visée, au ton du plan — mise en demeure incluse (le geste = la validation)', async () => {
    const { service, persistence, notifier } = await makeService({
      invoices: [invoice('inv-med', 'cu-1', { daysLate: 45 }), invoice('inv-neutre', 'cu-1', { daysLate: 12 })],
      customers: [customer('cu-1', 'client@example.com')],
    });

    const r = await service.sendRelanceForInvoice('co-1', 'inv-med');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ status: 'done', tone: 'miseendemeure' });
    expect(notifier.send).toHaveBeenCalledTimes(1);
    const sent = (notifier.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { subject: string; body: string };
    expect(sent.subject).toContain('Mise en demeure');
    expect(sent.body).toContain('L441-10'); // texte légal du domaine (buildRelance, débiteur b2b)
    const feed = await persistence.notificationJobs.listRecent('co-1', 10);
    expect(feed[0]).toMatchObject({ kind: 'invoice-relance', status: 'done' });
  });

  it('mise en demeure B2C : le type du client traverse la projection — code civil, jamais L441-10 ni 40 € (P01)', async () => {
    const { service, notifier } = await makeService({
      invoices: [invoice('inv-med', 'cu-part', { daysLate: 45 })],
      customers: [customer('cu-part', 'particulier@example.com', 'b2c')],
    });

    const r = await service.sendRelanceForInvoice('co-1', 'inv-med');

    expect(r.ok).toBe(true);
    const sent = (notifier.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
    expect(sent.body).toContain('art. 1344 du code civil');
    expect(sent.body).not.toContain('L441-10');
    expect(sent.body).not.toContain('40 €');
  });

  it('refus honnête : facture pas encore échue / réglée → validation ; inconnue → not_found', async () => {
    const { service } = await makeService({
      invoices: [invoice('inv-future', 'cu-1'), invoice('inv-paid', 'cu-1', { daysLate: 12, paid: 124_000, status: 'paid' })],
      customers: [customer('cu-1', 'client@example.com')],
    });

    const notDue = await service.sendRelanceForInvoice('co-1', 'inv-future');
    expect(!notDue.ok && notDue.error.kind).toBe('validation');

    const paid = await service.sendRelanceForInvoice('co-1', 'inv-paid');
    expect(!paid.ok && paid.error.kind).toBe('validation');

    const unknown = await service.sendRelanceForInvoice('co-1', 'inv-ghost');
    expect(!unknown.ok && unknown.error.kind).toBe('not_found');
  });

  it("email du client manquant : refus explicite (pas d'envoi fantôme)", async () => {
    const { service, notifier } = await makeService({
      invoices: [invoice('inv-1', 'cu-1', { daysLate: 12 })],
      customers: [customer('cu-1', null)],
    });

    const r = await service.sendRelanceForInvoice('co-1', 'inv-1');

    expect(!r.ok && r.error.kind).toBe('validation');
    if (!r.ok && r.error.kind === 'validation') {
      expect(r.error.issues[0]!.field).toBe('customer.email');
    }
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('dédup quotidienne : une relance déjà livrée aujourd’hui renvoie le job done, sans ré-envoyer', async () => {
    const { service, notifier } = await makeService({
      invoices: [invoice('inv-1', 'cu-1', { daysLate: 12 })],
      customers: [customer('cu-1', 'client@example.com')],
    });

    const first = await service.sendRelanceForInvoice('co-1', 'inv-1');
    const second = await service.sendRelanceForInvoice('co-1', 'inv-1');

    expect(first.ok && first.value.status).toBe('done');
    expect(second.ok && second.value.status).toBe('done');
    expect(notifier.send).toHaveBeenCalledTimes(1); // dedupeKey invoice:{id}:relance:{today}
  });
});
