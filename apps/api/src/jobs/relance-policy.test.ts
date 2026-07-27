import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Company, Customer, Invoice, NotificationPort } from '@bob/core';
import { RelanceService } from './relance.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';
import type { AppLogger } from '../observability/logger';
import { InMemoryPersistence } from '../persistence/persistence.testing';

/**
 * PR-06 « Encaisser » — cadence de relance PARAMÉTRABLE (CompanyBillingSettings.relancePolicy,
 * injectée dans le MÊME moteur deriveRelancePlan que l'écran) + interrupteur des relances
 * automatiques + lien public de la facture dans CHAQUE e-mail de relance (préparé UNE fois par
 * palier — jamais de rotation quotidienne qui invaliderait le lien déjà livré).
 */

const logger = { audit: vi.fn(), warn: vi.fn() } as unknown as AppLogger;

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function invoice(id: string, daysLate: number): Invoice {
  return {
    id,
    companyId: 'co-1',
    customerId: 'cu-1',
    kind: 'final',
    status: 'issued',
    parentQuoteId: null,
    dueAt: daysAgo(daysLate),
    number: `F-${id}`,
    issuedAt: daysAgo(daysLate + 30),
    paid: 0,
    totals: () => ({ ht: 100_000, vatByRate: {}, vat: 20_000, ttc: 120_000, netToPay: 120_000 }),
  } as unknown as Invoice;
}

async function makeService(setup: { invoices: Invoice[] }) {
  const persistence = new InMemoryPersistence();
  persistence.companies.seed({
    id: 'co-1',
    isClosed: () => false,
  } as unknown as Company);
  persistence.customers.seed([
    {
      id: 'cu-1',
      companyId: 'co-1',
      name: 'RATP CAP',
      type: 'b2g',
      toProps: () => ({ email: 'compta@ratp.fr' }),
    } as unknown as Customer,
  ]);
  for (const inv of setup.invoices) await persistence.invoices.save(inv);
  await persistence.billingSettings.ensureForCompany('co-1');
  const notifier = {
    send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined),
  } satisfies NotificationPort;
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
    { autoDunningEntitlement: async () => ({ allowed: true as const, plan: 'business' as const }) },
  );
  return { service, delivery, persistence, notifier };
}

const FLY_POLICY = {
  cordialAfterDays: 15,
  neutreAfterDays: 30,
  fermeAfterDays: 45,
  miseEnDemeureAfterDays: 60,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RelanceService — cadence paramétrable (PR-06)', () => {
  it('cadence personnalisée respectée par le CRON : J+16 = encore cordial (défaut : déjà neutre)', async () => {
    const { service, persistence } = await makeService({ invoices: [invoice('inv-16', 16)] });
    await persistence.billingSettings.update({
      companyId: 'co-1',
      expectedRevision: 1,
      patch: { relancePolicy: FLY_POLICY },
    });

    const run = await service.runRelancesForCompany('co-1');
    expect(run.queued).toBe(1);
    const jobs = await persistence.notificationJobs.listRecent('co-1', 10);
    // Ton du palier atteint sous LA cadence société : cordial (J+15), pas neutre (défaut J+10).
    expect(jobs[0]!.dedupeKey).toBe('invoice:inv-16:relance:auto:v1:cordial');
    expect(jobs[0]!.subject).toContain('petit rappel');
  });

  it('snapshot DÉFAUT inchangé : sans cadence société, J+16 relance au ton neutre (J+10)', async () => {
    const { service, persistence } = await makeService({ invoices: [invoice('inv-16', 16)] });
    const run = await service.runRelancesForCompany('co-1');
    expect(run.queued).toBe(1);
    const jobs = await persistence.notificationJobs.listRecent('co-1', 10);
    expect(jobs[0]!.dedupeKey).toBe('invoice:inv-16:relance:auto:v1:neutre');
  });

  it('interrupteur OFF : le batch saute le tenant (audité) — la relance MANUELLE reste possible', async () => {
    const { service, persistence } = await makeService({ invoices: [invoice('inv-16', 16)] });
    await persistence.billingSettings.update({
      companyId: 'co-1',
      expectedRevision: 1,
      patch: { relanceAutoEnabled: false },
    });

    const run = await service.runRelancesForCompany('co-1');
    expect(run).toEqual({ scanned: 0, queued: 0, sent: 0, deduplicated: 0 });
    expect(await persistence.notificationJobs.listRecent('co-1', 10)).toEqual([]);

    const manual = await service.sendRelanceForInvoice('co-1', 'inv-16');
    expect(manual.ok).toBe(true);
    expect((await persistence.notificationJobs.listRecent('co-1', 10)).length).toBe(1);
  });
});

describe('RelanceService — facture liée dans l’e-mail (PR-06)', () => {
  it('le lien public de consultation est DANS le corps ; préparé UNE fois par palier (dédup sans rotation)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://sign.bobpro.fr');
    const { service, delivery, persistence, notifier } = await makeService({
      invoices: [invoice('inv-16', 16)],
    });

    await service.runRelancesForCompany('co-1');
    await delivery.runForCompany('co-1');
    expect(notifier.send).toHaveBeenCalledTimes(1);
    const sent = (notifier.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
    expect(sent.body).toContain('Consulter la facture : https://sign.bobpro.fr/view/');

    // Rejeu du lendemain (même palier) : dédupliqué AVANT tout effet de bord — aucun nouveau
    // lien préparé (la rotation invaliderait celui déjà livré), aucun second envoi.
    const rerun = await service.runRelancesForCompany('co-1');
    expect(rerun.deduplicated).toBe(1);
    expect(rerun.queued).toBe(0);
    expect(notifier.send).toHaveBeenCalledTimes(1);
    void persistence;
  });

  it('SIGN_WEB_BASE_URL absent (environnement de test) : la relance part SANS lien — jamais une URL fabriquée', async () => {
    const { service, delivery, notifier } = await makeService({ invoices: [invoice('inv-16', 16)] });
    await service.runRelancesForCompany('co-1');
    await delivery.runForCompany('co-1');
    const sent = (notifier.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
    expect(sent.body).not.toContain('Consulter la facture');
    expect(sent.body).not.toContain('http');
  });
});
