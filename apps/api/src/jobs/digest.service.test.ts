import { describe, expect, it, vi } from 'vitest';
import type { Company, Invoice, NotificationPort, Payment } from '@bob/core';
import { DigestService, weeklyDigestWindow, type DigestWindow } from './digest.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import type { SupabaseAdminPort } from '../auth/supabase-admin';
import { requestContext, type AppLogger } from '../observability/logger';

const logger = {
  audit: vi.fn(),
  warn: vi.fn(),
} as unknown as AppLogger;

function fakeCompany(id: string): Company {
  return { id, isClosed: () => false } as unknown as Company;
}

function fakePayment(id: string, companyId: string, invoiceId: string, amount: number, receivedAt: string): Payment {
  return { id, companyId, invoiceId, amount, method: 'transfer', receivedAt, idempotencyKey: null } as unknown as Payment;
}

function fakeIssuedInvoice(id: string, companyId: string, issuedAt: string): Invoice {
  return { id, companyId, kind: 'final', status: 'issued', issuedAt } as unknown as Invoice;
}

/** Instant à `days` jours + `hours` heures après le début de la fenêtre digérée (toujours dedans). */
function inWindow(window: DigestWindow, days: number, hours: number): string {
  return new Date(Date.parse(window.periodStart) + days * 86_400_000 + hours * 3_600_000).toISOString();
}

/** Relance DONE datée DANS la fenêtre : enqueue outbox puis claim + markDone (mêmes ports que prod). */
async function seedDoneRelance(
  persistence: InMemoryPersistence,
  companyId: string,
  invoiceId: string,
  at: string,
): Promise<void> {
  const id = `relance-${companyId}-${invoiceId}`;
  await persistence.notificationJobs.enqueue({
    id,
    companyId,
    kind: 'invoice-relance',
    dedupeKey: `invoice:${invoiceId}:relance:auto:v1:neutre`,
    notification: { channel: 'email', to: 'client@example.com', subject: 'Relance', body: 'Corps', idempotencyKey: id },
    now: at,
  });
  const leaseUntil = new Date(Date.parse(at) + 5 * 60_000).toISOString();
  const claim = await persistence.notificationJobs.claimForDelivery(id, companyId, at, at, leaseUntil, 'lease-seed');
  if (claim.outcome !== 'claimed') throw new Error('seed relance done : claim impossible');
  const done = await persistence.notificationJobs.markDone(id, companyId, 'lease-seed', at);
  if (!done) throw new Error('seed relance done : markDone impossible');
}

function setup() {
  const persistence = new InMemoryPersistence();
  const window = weeklyDigestWindow(new Date());
  const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
  const tenants = new ScheduledTenantDirectory(persistence, logger);
  const delivery = new NotificationDeliveryService(persistence, notifier, tenants, logger);
  const supabaseAdmin: SupabaseAdminPort = {
    setUserCompanyId: vi.fn(async () => undefined),
    getUserIdentity: vi.fn(async (userId: string) => ({ email: `${userId}@artisan.example`, displayName: null })),
    deleteUser: vi.fn(async () => undefined),
  };
  const trackedEvents: import('@bob/core').TrackedEvent[] = [];
  const service = new DigestService(persistence, delivery, tenants, supabaseAdmin, logger, {
    track: (event) => trackedEvents.push(event),
  });
  return { persistence, window, service, supabaseAdmin, notifier, trackedEvents };
}

async function weeklyDigestJobs(persistence: InMemoryPersistence, companyId: string) {
  return (await persistence.notificationJobs.listRecent(companyId, 50)).filter((j) => j.kind === 'weekly-digest');
}

describe('digest de valeur hebdo multi-tenant (pilier 2)', () => {
  it('enfile UN digest pour la société avec substance, RIEN pour celle sans substance', async () => {
    const { persistence, window, service, trackedEvents } = setup();
    persistence.companies.seed(fakeCompany('company-u1'));
    persistence.companies.seed(fakeCompany('company-u2'));
    // Substance company-u1 : relance DONE mardi, paiement 2 340 € TTC mercredi sur la MÊME facture
    // (→ overdue_recovered), facture émise dans la fenêtre (→ document_created).
    await seedDoneRelance(persistence, 'company-u1', 'inv-1', inWindow(window, 1, 9));
    await persistence.payments.save(fakePayment('pay-1', 'company-u1', 'inv-1', 234_000, inWindow(window, 2, 10)));
    await persistence.invoices.save(fakeIssuedInvoice('inv-doc', 'company-u1', window.startDate));
    // company-u2 : aucun fait sur la période → digest null → AUCUNE notification (contrainte codée).

    const result = await service.runDigests();

    expect(result).toMatchObject({
      companies: 2,
      queued: 1,
      deduplicated: 0,
      skippedNoSubstance: 1,
      skippedNoEmail: 0,
      failed: 0,
      isoWeek: window.isoWeek,
    });
    const jobs = await weeklyDigestJobs(persistence, 'company-u1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.dedupeKey).toBe(`digest:company-u1:${window.isoWeek}:v1`);
    // Destinataire = email du COMPTE artisan (Supabase Auth, dérivation company-<userId>), jamais un client.
    expect(jobs[0]!.recipient).toBe('u1@artisan.example');
    // Recouvrement post-relance → l'accroche unique est l'argent récupéré.
    expect(jobs[0]!.subject).toContain('récupérés');
    expect(jobs[0]!.notification?.body).toContain('Relances envoyées : 1');
    expect(jobs[0]!.notification?.body).toContain('Documents créés : 1');
    // Analytics produit : value_digest_sent émis UNE fois, tenant opaque, accroche du domaine.
    expect(trackedEvents).toHaveLength(1);
    expect(trackedEvents[0]).toMatchObject({
      tenantId: 'company-u1',
      event: { name: 'value_digest_sent', highlightKind: 'money' },
    });
    expect(jobs[0]!.notification?.body).toContain('environ');
    await expect(weeklyDigestJobs(persistence, 'company-u2')).resolves.toHaveLength(0);
  });

  it('re-run de la même semaine → dédup : AUCUN nouveau job', async () => {
    const { persistence, window, service } = setup();
    persistence.companies.seed(fakeCompany('company-u1'));
    await persistence.payments.save(fakePayment('pay-1', 'company-u1', 'inv-1', 50_000, inWindow(window, 3, 8)));

    const first = await service.runDigests();
    const second = await service.runDigests();

    expect(first).toMatchObject({ queued: 1, deduplicated: 0 });
    expect(second).toMatchObject({ queued: 0, deduplicated: 1, failed: 0 });
    await expect(weeklyDigestJobs(persistence, 'company-u1')).resolves.toHaveLength(1);
  });

  it('flag DIGEST_WORKER_ENABLED absent ou ≠ true → le cron ne fait RIEN', async () => {
    const previous = process.env.DIGEST_WORKER_ENABLED;
    try {
      const { persistence, window, service } = setup();
      persistence.companies.seed(fakeCompany('company-u1'));
      await persistence.payments.save(fakePayment('pay-1', 'company-u1', 'inv-1', 50_000, inWindow(window, 3, 8)));

      delete process.env.DIGEST_WORKER_ENABLED;
      await service.scheduled();
      process.env.DIGEST_WORKER_ENABLED = 'false';
      await service.scheduled();
      await expect(weeklyDigestJobs(persistence, 'company-u1')).resolves.toHaveLength(0);

      process.env.DIGEST_WORKER_ENABLED = 'true';
      await service.scheduled();
      await expect(weeklyDigestJobs(persistence, 'company-u1')).resolves.toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.DIGEST_WORKER_ENABLED;
      else process.env.DIGEST_WORKER_ENABLED = previous;
    }
  });

  it("tenant sans email de compte dérivable (id hors provisioning company-<userId>) → skip compté, jamais l'email d'un client", async () => {
    const { persistence, window, service, supabaseAdmin } = setup();
    persistence.companies.seed(fakeCompany('co-legacy'));
    await persistence.payments.save(fakePayment('pay-1', 'co-legacy', 'inv-1', 80_000, inWindow(window, 2, 14)));

    const result = await service.runDigests();

    expect(result).toMatchObject({ companies: 1, queued: 0, skippedNoEmail: 1, failed: 0 });
    await expect(weeklyDigestJobs(persistence, 'co-legacy')).resolves.toHaveLength(0);
    expect(supabaseAdmin.getUserIdentity).not.toHaveBeenCalled();
  });

  it('paiement SANS relance done préalable → encaissé simple (jamais un recouvrement inventé)', async () => {
    const { persistence, window, service } = setup();
    persistence.companies.seed(fakeCompany('company-u1'));
    await persistence.payments.save(fakePayment('pay-1', 'company-u1', 'inv-1', 120_050, inWindow(window, 4, 16)));

    await service.runDigests();

    const jobs = await weeklyDigestJobs(persistence, 'company-u1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.subject).toContain('encaissés');
    expect(jobs[0]!.subject).not.toContain('récupérés');
    expect(jobs[0]!.notification?.body).not.toContain('après relance');
  });
});

/** Exécute fn dans le contexte tenant (comme le guard en requête réelle). */
function asTenant<T>(companyId: string, fn: () => T): T {
  return requestContext.run({ correlationId: 'test', principal: { userId: 'u-test', companyId } }, fn);
}

describe('bilan de fin d’essai (pilier 2) — agrégats du digest CUMULÉS sur la période d’essai', () => {
  const DAY = 86_400_000;

  it('essai en cours : digest cumulé depuis le DÉBUT de l’essai + phase/jours restants réels', async () => {
    const { persistence, service } = setup();
    persistence.companies.seed(fakeCompany('company-u1'));
    const startedAt = new Date(Date.now() - 10 * DAY).toISOString();
    const endsAt = new Date(Date.now() + 4 * DAY).toISOString();
    await persistence.subscriptions.startTrial({
      id: 'sub-company-u1',
      companyId: 'company-u1',
      plan: 'pro',
      trialEndsAt: endsAt,
      now: startedAt,
    });
    // Fait PENDANT l'essai (compté) et fait AVANT l'essai (jamais compté — période exacte).
    await persistence.payments.save(
      fakePayment('pay-in', 'company-u1', 'inv-1', 234_000, new Date(Date.now() - 3 * DAY).toISOString()),
    );
    await persistence.payments.save(
      fakePayment('pay-before', 'company-u1', 'inv-0', 999_999, new Date(Date.now() - 20 * DAY).toISOString()),
    );

    const r = await asTenant('company-u1', () => service.trialReportForCurrentTenant());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trial).toMatchObject({ plan: 'pro', endsAt, phase: 'active', daysLeft: 4 });
    expect(r.value.periodStart).toBe(startedAt);
    expect(r.value.digest?.collectedCents).toBe(234_000); // le paiement pré-essai n'est JAMAIS compté
    expect(r.value.digest?.highlight).toMatchObject({ kind: 'money', amountCents: 234_000 });
  });

  it('tenant SANS ligne d’essai (early-access, pré-migration) : trial null, digest null — zéro bruit', async () => {
    const { persistence, service } = setup();
    persistence.companies.seed(fakeCompany('co-legacy'));

    const r = await asTenant('co-legacy', () => service.trialReportForCurrentTenant());

    expect(r.ok && r.value).toEqual({ digest: null, periodStart: null, periodEnd: null, trial: null });
  });

  it('essai EXPIRÉ : la période est bornée à l’échéance — un fait postérieur à l’essai ne gonfle jamais le bilan', async () => {
    const { persistence, service } = setup();
    persistence.companies.seed(fakeCompany('company-u1'));
    const startedAt = new Date(Date.now() - 20 * DAY).toISOString();
    const endsAt = new Date(Date.now() - 6 * DAY).toISOString();
    await persistence.subscriptions.startTrial({
      id: 'sub-company-u1',
      companyId: 'company-u1',
      plan: 'pro',
      trialEndsAt: endsAt,
      now: startedAt,
    });
    await persistence.payments.save(
      fakePayment('pay-in', 'company-u1', 'inv-1', 50_000, new Date(Date.now() - 10 * DAY).toISOString()),
    );
    await persistence.payments.save(
      fakePayment('pay-after', 'company-u1', 'inv-2', 70_000, new Date(Date.now() - 1 * DAY).toISOString()),
    );

    const r = await asTenant('company-u1', () => service.trialReportForCurrentTenant());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trial).toMatchObject({ phase: 'expired', daysLeft: 0 });
    expect(r.value.periodEnd).toBe(endsAt);
    expect(r.value.digest?.collectedCents).toBe(50_000); // le paiement post-essai n'appartient pas au bilan
  });
});

describe('value_digest_opened (pilier 2) — l’OUVERTURE réelle du digest, jamais son rendu', () => {
  it('accroche valide → événement tracké UNE fois, tenant opaque', async () => {
    const { service, trackedEvents } = setup();

    const r = await asTenant('company-u1', () => service.recordDigestOpened({ highlightKind: 'money' }));

    expect(r.ok && r.value).toEqual({ recorded: true });
    expect(trackedEvents).toHaveLength(1);
    expect(trackedEvents[0]).toMatchObject({
      tenantId: 'company-u1',
      event: { name: 'value_digest_opened', highlightKind: 'money' },
    });
  });

  it('accroche inconnue → validation refusée, AUCUN événement (schéma typé sans PII)', async () => {
    const { service, trackedEvents } = setup();

    const r = await asTenant('company-u1', () => service.recordDigestOpened({ highlightKind: 'weird' }));

    expect(r.ok).toBe(false);
    expect(trackedEvents).toHaveLength(0);
  });
});
