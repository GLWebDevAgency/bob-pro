import { describe, expect, it, vi } from 'vitest';
import {
  Invoice,
  MaintenanceContract,
  addDays,
  clampedAnniversary,
  formatDateOnlyFr,
  type Company,
  type NotificationPort,
  type InvoiceSnapshot,
} from '@bob/core';
import { ContractRenewalService } from './contract-renewal.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';
import {
  contractAnnualInvoiceReminderDedupeKey,
  contractAnnualInvoiceReminderDedupeKeyParts,
  contractRenewalReminderDedupeKey,
  contractRenewalReminderDedupeKeyParts,
} from './reminder-dedupe-keys';
import type { AppLogger } from '../observability/logger';
import type { SupabaseAdminPort } from '../auth/supabase-admin';
import { InMemoryPersistence } from '../persistence/persistence.testing';

/**
 * PR-13 — alertes de renouvellement (Bloc B §2.5) : cron 6 h qui MATÉRIALISE des
 * NotificationJob dédupliqués (clés dans le module PUR reminder-dedupe-keys — jamais de
 * cycle d'imports Nest), J-60/J-30 (UN palier, le plus récent — amélioration 14), extinction
 * si résilié (candidature ET revalidation worker à l'horloge RÉELLE), AUCUN envoi client
 * (interne), lecture BATCHÉE par société (annexe erratum n° 8). Tests exigés : dédup
 * ANNUELLE, extinction, fenêtre −30 j vivante TOUTES les années.
 *
 * Ancrage temporel : les tests qui LIVRENT (worker) sont ancrés sur la date RÉELLE (la
 * revalidation du worker lit l'horloge système — livrer un contenu re-dérivé est le
 * comportement testé) ; les tests pluriannuels injectent `today` à l'ENQUEUE seulement.
 */

const logger = { audit: vi.fn(), warn: vi.fn() } as unknown as AppLogger;
const COMPANY = 'company-user1';

const TODAY = new Date().toISOString().slice(0, 10);
/** (today + 22 j) ramené un an en arrière : l'anniversaire du contrat tombe à J-22 réels. */
function minusOneYear(dateOnly: string): string {
  const year = Number(dateOnly.slice(0, 4)) - 1;
  const monthDay = dateOnly.slice(5) === '02-29' ? '02-28' : dateOnly.slice(5);
  return `${year}-${monthDay}`;
}
const ANNIVERSARY = minusOneYear(addDays(TODAY, 22));
/** Prochain anniversaire CALCULÉ (clampé) — la clé de dédup du palier. */
const NEXT_ANNIVERSARY = clampedAnniversary(ANNIVERSARY, 1);
const CURRENT_PERIOD_END_INCLUSIVE = addDays(NEXT_ANNIVERSARY, -1);
const NEXT_PERIOD_END_INCLUSIVE = addDays(clampedAnniversary(ANNIVERSARY, 2), -1);

function contract(input: {
  id: string;
  status?: 'draft' | 'active' | 'terminated';
  anniversaryDate?: string;
  tacitRenewal?: boolean;
}): MaintenanceContract {
  const status = input.status ?? 'active';
  const anniversaryDate = input.anniversaryDate ?? ANNIVERSARY;
  return MaintenanceContract.rehydrate({
    id: input.id,
    companyId: COMPANY,
    customerId: 'cus-ratp',
    chantierId: null,
    label: `Entretien ${input.id}`,
    status,
    anniversaryDate,
    noticeDays: 30,
    visitsPerYear: 2,
    tacitRenewal: input.tacitRenewal ?? true,
    importCoveredUntil: null,
    activatedAt: status === 'draft' ? null : `${anniversaryDate}T08:00:00.000Z`,
    terminatedAt: status === 'terminated' ? `${TODAY}T05:00:00.000Z` : null,
    terminationEffectiveDate: status === 'terminated' ? NEXT_ANNIVERSARY : null,
    terminationNote: status === 'terminated' ? 'Marché perdu.' : null,
    notes: null,
    revision: 1,
    lines: [
      {
        id: `${input.id}:line`,
        catalogueItemId: null,
        label: 'Forfait entretien annuel',
        quantity: 2,
        unitPriceHtCents: 80_000,
        vatRate: 20,
        position: 0,
      },
    ],
    equipmentIds: [],
  });
}

/** Facture ÉMISE couvrant [start, end] (bornes humaines inclusives) pour un contrat. */
function coveringInvoice(id: string, contractId: string, start: string, end: string): Invoice {
  const snapshot: InvoiceSnapshot = {
    id,
    companyId: COMPANY,
    customerId: 'cus-ratp',
    kind: 'final',
    status: 'issued',
    lines: [
      {
        id: `${id}:line`,
        label: 'Forfait entretien annuel',
        category: 'subscription',
        qty: 2,
        unitPriceHT: 80_000,
        vatRate: 20,
      },
    ],
    number: `F-${id}`,
    frozenTotals: { ht: 160_000, vatByRate: { '20': 32_000 }, vat: 32_000, ttc: 192_000, netToPay: 192_000 },
    mentions: ['Test'],
    issuedAt: start,
    dueAt: end,
    paid: 0,
    depositPct: null,
    parentQuoteId: null,
    servicePeriod: { start, end },
    maintenanceContractId: contractId,
  };
  return Invoice.rehydrate(snapshot);
}

async function makeService(setup: { contracts: MaintenanceContract[]; invoices?: Invoice[] }) {
  const persistence = new InMemoryPersistence();
  persistence.companies.seed({ id: COMPANY } as Company);
  for (const c of setup.contracts) await persistence.maintenanceContracts.save(c);
  for (const inv of setup.invoices ?? []) await persistence.invoices.save(inv);
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
  const service = new ContractRenewalService(
    persistence,
    delivery,
    new ScheduledTenantDirectory(persistence, logger),
    supabaseAdmin,
    logger,
  );
  return { service, delivery, persistence, notifier };
}

describe('ContractRenewalService — cron 6 h (alerte INTERNE, jamais un envoi client)', () => {
  it('J-22 tacite : UNE alerte j30 (le palier le plus récent — jamais J-60 ET J-30) + le rappel « facture annuelle », dédupliqués au rejeu', async () => {
    const { service, delivery, persistence, notifier } = await makeService({
      contracts: [contract({ id: 'c-bastille' })],
      // L'année en cours est couverte : c'est la période SUIVANTE qui est due (fenêtre −30 j).
      invoices: [coveringInvoice('inv-n', 'c-bastille', ANNIVERSARY, CURRENT_PERIOD_END_INCLUSIVE)],
    });

    const first = await service.runForCompany(COMPANY);
    expect(first).toEqual({ queued: 2, deduplicated: 0 });
    const jobs = await persistence.notificationJobs.listRecent(COMPANY, 10);
    const keys = jobs.map((job) => job.dedupeKey).sort();
    expect(keys).toEqual(
      [
        contractRenewalReminderDedupeKey('c-bastille', NEXT_ANNIVERSARY, 'j30'),
        contractAnnualInvoiceReminderDedupeKey('c-bastille', NEXT_ANNIVERSARY),
      ].sort(),
    );

    // Livraison réelle : l'e-mail va au COMPTE de l'artisan — JAMAIS au client.
    const delivered = await delivery.runForCompany(COMPANY);
    expect(delivered.sent).toBe(2);
    for (const call of (notifier.send as ReturnType<typeof vi.fn>).mock.calls) {
      const sent = call[0] as { to: string; body: string };
      expect(sent.to).toBe('artisan@fly-services.fr');
      expect(sent.body).toContain('Rappel interne Bob');
    }

    // Rejeu du cron : clés stables → dédupliqué, JAMAIS un second rappel dans l'année.
    const second = await service.runForCompany(COMPANY);
    expect(second).toEqual({ queued: 0, deduplicated: 2 });
    expect(notifier.send).toHaveBeenCalledTimes(2);
  });

  it('[dédup ANNUELLE + fenêtre −30 j vivante TOUTES les années] l’année suivante re-alerte avec des clés NEUVES', async () => {
    // Dates INJECTÉES à l'enqueue (aucune livraison ici) : anniversaire fixe 2025-10-12.
    const { service, persistence } = await makeService({
      contracts: [contract({ id: 'c-fixe-annees', anniversaryDate: '2025-10-12' })],
      invoices: [coveringInvoice('inv-2026', 'c-fixe-annees', '2025-10-12', '2026-10-11')],
    });

    // Année N (J-22 avant le 12/10/2026) : renouvellement + facture annuelle dus.
    expect(await service.runForCompany(COMPANY, '2026-09-20')).toEqual({ queued: 2, deduplicated: 0 });
    // L'artisan émet la facture annuelle pendant l'année…
    await persistence.invoices.save(coveringInvoice('inv-2027', 'c-fixe-annees', '2026-10-12', '2027-10-11'));
    // … et l'année N+1 (J-22 avant le 12/10/2027) RE-ALERTE : clés neuves, la fenêtre VIT.
    expect(await service.runForCompany(COMPANY, '2027-09-20')).toEqual({ queued: 2, deduplicated: 0 });

    const keys = (await persistence.notificationJobs.listRecent(COMPANY, 10)).map((job) => job.dedupeKey);
    expect(keys).toContain(contractRenewalReminderDedupeKey('c-fixe-annees', '2026-10-12', 'j30'));
    expect(keys).toContain(contractRenewalReminderDedupeKey('c-fixe-annees', '2027-10-12', 'j30'));
    expect(keys).toContain(contractAnnualInvoiceReminderDedupeKey('c-fixe-annees', '2026-10-12'));
    expect(keys).toContain(contractAnnualInvoiceReminderDedupeKey('c-fixe-annees', '2027-10-12'));
  });

  it('J-45 : palier j60 seul ; hors fenêtre (J-90) : aucune alerte inventée', async () => {
    const { service, persistence } = await makeService({
      contracts: [contract({ id: 'c-fixe-paliers', anniversaryDate: '2025-10-12' })],
      invoices: [coveringInvoice('inv-2026', 'c-fixe-paliers', '2025-10-12', '2026-10-11')],
    });
    expect(await service.runForCompany(COMPANY, '2026-08-28')).toEqual({ queued: 1, deduplicated: 0 });
    const jobs = await persistence.notificationJobs.listRecent(COMPANY, 10);
    expect(jobs.map((job) => job.dedupeKey)).toEqual([
      contractRenewalReminderDedupeKey('c-fixe-paliers', '2026-10-12', 'j60'),
    ]);
    // J-90 : rien (fenêtre fermée) — le run reste silencieux, aucun job de plus.
    expect(await service.runForCompany(COMPANY, '2026-07-14')).toEqual({ queued: 0, deduplicated: 0 });
  });

  /**
   * Doctrine « papa vocal » : l'artisan ne lit pas du AAAA-MM-JJ. Toutes les autres surfaces
   * (fiche, voix, écrans) disent une date française ; le rappel INTERNE ne peut pas être la
   * seule à parler machine — c'est là que le pro décide d'appeler son client.
   */
  it('les rappels INTERNES disent une date FRANÇAISE, jamais du AAAA-MM-JJ', async () => {
    const { service, delivery, notifier } = await makeService({
      contracts: [contract({ id: 'c-dates-fr' })],
      invoices: [coveringInvoice('inv-n', 'c-dates-fr', ANNIVERSARY, CURRENT_PERIOD_END_INCLUSIVE)],
    });
    expect(await service.runForCompany(COMPANY)).toEqual({ queued: 2, deduplicated: 0 });
    expect((await delivery.runForCompany(COMPANY)).sent).toBe(2);
    const bodies = (notifier.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { body: string }).body,
    );
    expect(bodies).toHaveLength(2);
    const renewal = bodies.find((body) => body.includes('se reconduit tacitement'));
    const annual = bodies.find((body) => body.includes('facturée'));
    expect(renewal).toBeDefined();
    expect(annual).toBeDefined();
    expect(renewal).toContain(formatDateOnlyFr(NEXT_ANNIVERSARY));
    expect(annual).toContain(formatDateOnlyFr(NEXT_ANNIVERSARY));
    for (const body of bodies) expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('non-tacite : « arrive à échéance », jamais « se reconduit »', async () => {
    const { service, delivery, notifier } = await makeService({
      contracts: [contract({ id: 'c-echeance', tacitRenewal: false })],
      invoices: [coveringInvoice('inv-n', 'c-echeance', ANNIVERSARY, CURRENT_PERIOD_END_INCLUSIVE)],
    });
    // Non-tacite : une SEULE période — pas de facture annuelle suivante, seule l'échéance alerte.
    expect(await service.runForCompany(COMPANY)).toEqual({ queued: 1, deduplicated: 0 });
    const delivered = await delivery.runForCompany(COMPANY);
    expect(delivered.sent).toBe(1);
    const sent = (notifier.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { subject: string };
    expect(sent.subject).toContain('échéance');
    expect(sent.subject).not.toContain('reconduit');
  });

  it('EXTINCTION : un contrat résilié (ou brouillon) n’est JAMAIS candidat', async () => {
    const { service, persistence } = await makeService({
      contracts: [
        contract({ id: 'c-resilie', status: 'terminated' }),
        contract({ id: 'c-brouillon', status: 'draft' }),
      ],
    });
    expect(await service.runForCompany(COMPANY)).toEqual({ queued: 0, deduplicated: 0 });
    expect(await persistence.notificationJobs.listRecent(COMPANY, 10)).toEqual([]);
  });

  it('EXTINCTION à la livraison : résiliation APRÈS l’enqueue → jobs ANNULÉS, jamais livrés', async () => {
    const { service, delivery, persistence, notifier } = await makeService({
      contracts: [contract({ id: 'c-course' })],
      invoices: [coveringInvoice('inv-n', 'c-course', ANNIVERSARY, CURRENT_PERIOD_END_INCLUSIVE)],
    });
    expect(await service.runForCompany(COMPANY)).toEqual({ queued: 2, deduplicated: 0 });

    // La résiliation arrive entre l'enqueue (6 h) et le passage du worker.
    await persistence.maintenanceContracts.save(contract({ id: 'c-course', status: 'terminated' }));

    const delivered = await delivery.runForCompany(COMPANY);
    expect(delivered.sent).toBe(0);
    expect(notifier.send).not.toHaveBeenCalled();
    const jobs = await persistence.notificationJobs.listRecent(COMPANY, 10);
    expect(jobs.filter((job) => job.status === 'pending')).toEqual([]);
  });

  it('EXTINCTION à la livraison : facture émise APRÈS l’enqueue → le rappel annuel est annulé, l’alerte de renouvellement part', async () => {
    const { service, delivery, persistence, notifier } = await makeService({
      contracts: [contract({ id: 'c-vite' })],
      invoices: [coveringInvoice('inv-n', 'c-vite', ANNIVERSARY, CURRENT_PERIOD_END_INCLUSIVE)],
    });
    expect(await service.runForCompany(COMPANY)).toEqual({ queued: 2, deduplicated: 0 });

    // L'artisan émet la facture annuelle AVANT le passage du worker : la période est couverte.
    await persistence.invoices.save(
      coveringInvoice('inv-n1', 'c-vite', NEXT_ANNIVERSARY, NEXT_PERIOD_END_INCLUSIVE),
    );

    const delivered = await delivery.runForCompany(COMPANY);
    expect(delivered.sent).toBe(1);
    const sent = (notifier.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { subject: string };
    expect(sent.subject).toContain('reconduit');
  });

  it('clés de dédup : construction et inverses fail-closed (module PUR)', () => {
    const renewal = contractRenewalReminderDedupeKey('c-9', '2026-10-12', 'j30');
    expect(renewal).toBe('contract:c-9:renewal:2026-10-12:j30');
    expect(contractRenewalReminderDedupeKeyParts(renewal)).toEqual({
      contractId: 'c-9',
      anniversary: '2026-10-12',
      palier: 'j30',
    });
    expect(contractRenewalReminderDedupeKeyParts('contract:c-9:renewal:2026-10-12:j15')).toBeNull();
    expect(contractRenewalReminderDedupeKeyParts('quote:c-9:renewal:2026-10-12:j30')).toBeNull();

    const annual = contractAnnualInvoiceReminderDedupeKey('c-9', '2026-10-12');
    expect(annual).toBe('contract:c-9:annual-invoice:2026-10-12');
    expect(contractAnnualInvoiceReminderDedupeKeyParts(annual)).toEqual({
      contractId: 'c-9',
      periodStart: '2026-10-12',
    });
    expect(contractAnnualInvoiceReminderDedupeKeyParts('contract:c-9:annual-invoice:12/10/2026')).toBeNull();
  });
});
