import { describe, expect, it } from 'vitest';
import { makeEnv } from './in-memory-env';
import { ComposeStandaloneInvoice } from './compose-standalone-invoice';
import { IssueInvoice } from './issue-invoice';
import { UpdateInvoiceServicePeriod } from './update-invoice-service-period';
import { MaintenanceContract } from '../../domain/contract/maintenance-contract';
import { composeAnnualInvoiceDesignation } from '../../domain/contract/annual-invoice-designation';
import { type MaintenanceContractRepository } from '../contracts/maintenance-contract-repository';

/**
 * Écrans §6.5 — « éditable en brouillon, figé à l'émission » : le geste que la garde
 * d'émission promet (« modifie le brouillon, jamais l'émission ») existe et respecte les
 * invariants : brouillon uniquement, pièces de CONTRAT uniquement, bornes valides, CAS
 * révision, idempotence — les colonnes du brouillon restent l'AUTORITÉ de la garde.
 */

type Env = ReturnType<typeof makeEnv>;

function contractRepoOf(env: Env): MaintenanceContractRepository {
  const contract = MaintenanceContract.rehydrate({
    id: 'contract-fontaines',
    companyId: env.company.id,
    customerId: 'cust-martin',
    chantierId: null,
    label: 'Entretien fontaines 2026',
    status: 'active',
    anniversaryDate: '2025-10-12',
    noticeDays: 30,
    visitsPerYear: 2,
    tacitRenewal: true,
    importCoveredUntil: null,
    activatedAt: '2025-10-12T08:00:00.000Z',
    terminatedAt: null,
    terminationEffectiveDate: null,
    terminationNote: null,
    notes: null,
    revision: 1,
    lines: [],
    equipmentIds: [],
  });
  return {
    findById: async (companyId, id) =>
      companyId === contract.companyId && id === contract.id ? contract : null,
    lockById: async (companyId, id) =>
      companyId === contract.companyId && id === contract.id ? contract : null,
    listByCompany: async () => [contract],
    listByCustomer: async () => [contract],
    save: async () => {},
    deleteById: async () => {},
  };
}

async function composeContractDraft(env: Env): Promise<string> {
  const compose = new ComposeStandaloneInvoice({
    invoices: env.invoiceRepo,
    companies: env.companyRepo,
    customers: env.customerRepo,
    ids: env.ids,
    clock: env.clock,
    contracts: contractRepoOf(env),
  });
  const composed = await compose.execute({
    companyId: env.company.id,
    customerId: 'cust-martin',
    // La ligne d'une pièce de contrat ne porte QUE la désignation composée par le domaine.
    lines: [
      {
        label: composeAnnualInvoiceDesignation({
          servicePeriod: { start: '2025-10-12', end: '2026-10-11' },
          contractName: 'Entretien fontaines',
        }),
        category: 'subscription',
        qty: 1,
        unitPriceHT: 160_000,
        vatRate: 20,
      },
    ],
    contractAttachment: {
      maintenanceContractId: 'contract-fontaines',
      servicePeriod: { start: '2025-10-12', end: '2026-10-11' },
    },
  });
  if (!composed.ok) throw new Error('compose contract draft');
  return composed.value.invoiceId;
}

function useCase(env: Env): UpdateInvoiceServicePeriod {
  return new UpdateInvoiceServicePeriod({ invoices: env.invoiceRepo, clock: env.clock });
}

describe('UpdateInvoiceServicePeriod — période éditable en brouillon (§6.5)', () => {
  it('modifie la période du BROUILLON de contrat, révision +1, colonnes relues comme autorité', async () => {
    const env = makeEnv();
    const invoiceId = await composeContractDraft(env);
    const updated = await useCase(env).execute({
      companyId: env.company.id,
      invoiceId,
      expectedRevision: 1,
      servicePeriod: { start: '2025-11-01', end: '2026-10-31' },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.servicePeriod).toEqual({ start: '2025-11-01', end: '2026-10-31' });
    expect(updated.value.revision).toBe(2);
    const stored = await env.invoiceRepo.findById(invoiceId);
    expect(stored!.servicePeriod).toEqual({ start: '2025-11-01', end: '2026-10-31' });
  });

  it('idempotente : la MÊME période ne consomme aucune révision (aucune écriture)', async () => {
    const env = makeEnv();
    const invoiceId = await composeContractDraft(env);
    const same = await useCase(env).execute({
      companyId: env.company.id,
      invoiceId,
      expectedRevision: 1,
      servicePeriod: { start: '2025-10-12', end: '2026-10-11' },
    });
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.value.revision).toBe(1);
  });

  it('refuse une facture SANS contrat (sa période A7 se renseigne à l’émission — inchangé)', async () => {
    const env = makeEnv();
    const compose = new ComposeStandaloneInvoice({
      invoices: env.invoiceRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
    });
    const composed = await compose.execute({
      companyId: env.company.id,
      customerId: 'cust-martin',
      lines: [{ label: 'Dépannage', category: 'labor', qty: 1, unitPriceHT: 20_000, vatRate: 20 }],
    });
    if (!composed.ok) throw new Error('compose');
    const refused = await useCase(env).execute({
      companyId: env.company.id,
      invoiceId: composed.value.invoiceId,
      expectedRevision: 1,
      servicePeriod: { start: '2025-11-01', end: '2026-10-31' },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(JSON.stringify(refused.error)).toContain('n’est pas liée à un contrat');
  });

  it('refuse fin < début et une révision périmée (CAS) — rien n’est écrit', async () => {
    const env = makeEnv();
    const invoiceId = await composeContractDraft(env);
    const inverted = await useCase(env).execute({
      companyId: env.company.id,
      invoiceId,
      expectedRevision: 1,
      servicePeriod: { start: '2026-10-31', end: '2025-11-01' },
    });
    expect(inverted.ok).toBe(false);
    const stale = await useCase(env).execute({
      companyId: env.company.id,
      invoiceId,
      expectedRevision: 7,
      servicePeriod: { start: '2025-11-01', end: '2026-10-31' },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.kind).toBe('conflict');
    const stored = await env.invoiceRepo.findById(invoiceId);
    expect(stored!.servicePeriod).toEqual({ start: '2025-10-12', end: '2026-10-11' });
  });

  it('anti-IDOR : la facture d’un autre tenant est INVISIBLE (not_found)', async () => {
    const env = makeEnv();
    const invoiceId = await composeContractDraft(env);
    const foreign = await useCase(env).execute({
      companyId: 'company-autre',
      invoiceId,
      expectedRevision: 1,
      servicePeriod: { start: '2025-11-01', end: '2026-10-31' },
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.kind).toBe('not_found');
  });

  it('FIGÉE à l’émission : la période ÉDITÉE est celle que la garde d’émission fige, puis toute modification est refusée', async () => {
    const env = makeEnv();
    const invoiceId = await composeContractDraft(env);
    const edited = await useCase(env).execute({
      companyId: env.company.id,
      invoiceId,
      expectedRevision: 1,
      servicePeriod: { start: '2025-11-01', end: '2026-10-31' },
    });
    expect(edited.ok).toBe(true);
    const contracts = contractRepoOf(env);
    const issue = new IssueInvoice({
      invoices: env.invoiceRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      quotes: env.quoteRepo,
      counters: env.counters,
      uow: env.uow,
      clock: env.clock,
      contracts,
      contractInvoices: { listByMaintenanceContract: async () => [] },
    });
    const issued = await issue.execute({
      invoiceId,
      defaultTerms: { days: 30, endOfMonth: false, label: 'Paiement à 30 jours' },
    });
    expect(issued.ok).toBe(true);
    const stored = await env.invoiceRepo.findById(invoiceId);
    // L'autorité émise = la période ÉDITÉE au brouillon (jamais l'input d'émission).
    expect(stored!.servicePeriod).toEqual({ start: '2025-11-01', end: '2026-10-31' });
    const refused = await useCase(env).execute({
      companyId: env.company.id,
      invoiceId,
      expectedRevision: stored!.revision,
      servicePeriod: { start: '2025-12-01', end: '2026-11-30' },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(JSON.stringify(refused.error)).toContain('déjà émise');
  });
});
