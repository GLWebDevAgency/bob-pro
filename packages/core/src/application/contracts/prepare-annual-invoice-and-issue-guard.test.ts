import { describe, expect, it } from 'vitest';
import { makeEnv } from '../billing/in-memory-env';
import { ComposeStandaloneInvoice } from '../billing/compose-standalone-invoice';
import { IssueInvoice } from '../billing/issue-invoice';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { MaintenanceContract } from '../../domain/contract/maintenance-contract';
import {
  type ContractInvoicesReadPort,
  type MaintenanceContractRepository,
} from './maintenance-contract-repository';
import { type ContractInvoiceProjection } from './derive-contract-schedule';
import { PrepareAnnualInvoiceDraft } from './prepare-annual-invoice-draft';

/**
 * PR-12b — brouillon annuel (§2.6) + garde d'émission (direction 1, annexe errata n° 2/3) :
 * la période vit AU BROUILLON (autorité), la couverture se DÉRIVE des factures non annulées,
 * l'idempotence de période vit DANS la transaction d'émission sous le verrou du contrat.
 */

type Env = ReturnType<typeof makeEnv>;

const DEFAULT_TERMS = { days: 30, endOfMonth: false, label: 'Paiement à 30 jours' };

function contractOf(env: Env, overrides: { status?: 'draft' | 'active' | 'terminated' } = {}) {
  const status = overrides.status ?? 'active';
  return MaintenanceContract.rehydrate({
    id: 'contract-fontaines',
    companyId: env.company.id,
    customerId: 'cust-martin',
    chantierId: null,
    label: 'Entretien fontaines 2026',
    status,
    // Horloge du harnais : 2026-06-01 → période courante [2025-10-12, 2026-10-12).
    anniversaryDate: '2025-10-12',
    noticeDays: 30,
    visitsPerYear: 2,
    tacitRenewal: true,
    importCoveredUntil: null,
    activatedAt: status === 'draft' ? null : '2025-10-12T08:00:00.000Z',
    terminatedAt: status === 'terminated' ? '2026-05-01T08:00:00.000Z' : null,
    terminationEffectiveDate: status === 'terminated' ? '2026-10-12' : null,
    terminationNote: status === 'terminated' ? 'Résiliation client.' : null,
    notes: null,
    revision: 1,
    lines: [
      {
        id: 'line-1',
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

function contractPorts(env: Env, contract: MaintenanceContract) {
  const contracts: MaintenanceContractRepository &
    Required<Pick<MaintenanceContractRepository, 'lockById'>> = {
    findById: async (companyId, id) =>
      companyId === contract.companyId && id === contract.id ? contract : null,
    lockById: async (companyId, id) =>
      companyId === contract.companyId && id === contract.id ? contract : null,
    listByCompany: async () => [contract],
    listByCustomer: async () => [contract],
    save: async () => {},
    deleteById: async () => {},
  };
  const projectionsOf = async (contractId: string): Promise<ContractInvoiceProjection[]> => {
    const invoices = await env.invoiceRepo.listByCompany(env.company.id);
    return invoices
      .filter((invoice) => invoice.maintenanceContractId === contractId)
      .map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        kind: invoice.kind,
        status: invoice.status,
        servicePeriodStart: invoice.servicePeriod?.start ?? null,
        servicePeriodEnd: invoice.servicePeriod?.end ?? null,
      }));
  };
  const contractInvoices: ContractInvoicesReadPort = {
    listByMaintenanceContract: async (_companyId, contractId) => projectionsOf(contractId),
    listContractInvoicesByCompany: async () =>
      new Map([[contract.id, await projectionsOf(contract.id)]]),
  };
  return { contracts, contractInvoices };
}

function composeUseCase(env: Env, contracts: MaintenanceContractRepository) {
  return new ComposeStandaloneInvoice({
    invoices: env.invoiceRepo,
    companies: env.companyRepo,
    customers: env.customerRepo,
    ids: env.ids,
    clock: env.clock,
    contracts,
  });
}

function prepareUseCase(env: Env, contract: MaintenanceContract) {
  const ports = contractPorts(env, contract);
  return {
    ports,
    prepare: new PrepareAnnualInvoiceDraft({
      contracts: ports.contracts,
      contractInvoices: ports.contractInvoices,
      compose: composeUseCase(env, ports.contracts),
      clock: env.clock,
    }),
  };
}

function issueUseCase(env: Env, ports?: ReturnType<typeof contractPorts>) {
  return new IssueInvoice({
    invoices: env.invoiceRepo,
    companies: env.companyRepo,
    customers: env.customerRepo,
    quotes: env.quoteRepo,
    counters: env.counters,
    uow: env.uow,
    clock: env.clock,
    ...(ports !== undefined
      ? { contracts: ports.contracts, contractInvoices: ports.contractInvoices }
      : {}),
  });
}

describe('PrepareAnnualInvoiceDraft — brouillon en un tap (§2.6)', () => {
  it('crée un BROUILLON portant contrat + période humaine inclusive, lignes en subscription', async () => {
    const env = makeEnv();
    const contract = contractOf(env);
    const { prepare } = prepareUseCase(env, contract);
    const prepared = await prepare.execute({ companyId: env.company.id, contractId: contract.id });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.period).toEqual({ start: '2025-10-12', end: '2026-10-12' });
    expect(prepared.value.servicePeriod).toEqual({ start: '2025-10-12', end: '2026-10-11' });
    expect(prepared.value.vatDivergence).toBe(false);
    expect(prepared.value.totals.ttc).toBe(prepared.value.contractTotals.ttc);
    const draft = await env.invoiceRepo.findById(prepared.value.invoiceId);
    expect(draft!.status).toBe('draft');
    expect(draft!.maintenanceContractId).toBe('contract-fontaines');
    expect(draft!.servicePeriod).toEqual({ start: '2025-10-12', end: '2026-10-11' });
    expect(draft!.lines.every((line) => line.category === 'subscription')).toBe(true);
  });

  it('refus actionnable AVEC le numéro couvrant quand la période est déjà facturée', async () => {
    const env = makeEnv();
    const contract = contractOf(env);
    const { prepare, ports } = prepareUseCase(env, contract);
    const first = await prepare.execute({ companyId: env.company.id, contractId: contract.id });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const issued = await issueUseCase(env, ports).execute({
      invoiceId: first.value.invoiceId,
      defaultTerms: DEFAULT_TERMS,
    });
    expect(issued.ok).toBe(true);
    const again = await prepare.execute({ companyId: env.company.id, contractId: contract.id });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(JSON.stringify(again.error)).toContain('déjà couverte par la facture F-2026-0001');
    }
  });

  it('refuse un contrat brouillon ou résilié (refus actionnable distinct)', async () => {
    const env = makeEnv();
    const draftContract = contractOf(env, { status: 'draft' });
    const { prepare } = prepareUseCase(env, draftContract);
    const refused = await prepare.execute({ companyId: env.company.id, contractId: draftContract.id });
    expect(refused.ok).toBe(false);
    const env2 = makeEnv();
    const terminated = contractOf(env2, { status: 'terminated' });
    const { prepare: prepare2 } = prepareUseCase(env2, terminated);
    const refused2 = await prepare2.execute({ companyId: env2.company.id, contractId: terminated.id });
    expect(refused2.ok).toBe(false);
  });

  it('[amélioration 2] bascule de régime (franchise 293 B) → refus actionnable de suggestVatRate', async () => {
    const env = makeEnv();
    const contract = contractOf(env);
    // La société est passée en franchise APRÈS la création du contrat (lignes à 20 %).
    const franchiseCompany = { ...env.company, isVatFranchise: () => true } as typeof env.company;
    env.companyRepo.findById = async (id) => (id === env.company.id ? franchiseCompany : null);
    const { prepare } = prepareUseCase(env, contract);
    const refused = await prepare.execute({ companyId: env.company.id, contractId: contract.id });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(JSON.stringify(refused.error)).toContain('VAT_RATE_NOT_APPLICABLE');
  });

  it('ComposeStandaloneInvoice SANS contractAttachment : comportement inchangé (aucun contrat posé)', async () => {
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
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    const draft = await env.invoiceRepo.findById(composed.value.invoiceId);
    expect(draft!.maintenanceContractId).toBeNull();
    expect(draft!.servicePeriod).toBeNull();
    // attachment fourni SANS port câblé → refus fail-closed (jamais un lien non vérifié).
    const failClosed = await compose.execute({
      companyId: env.company.id,
      customerId: 'cust-martin',
      lines: [{ label: 'Forfait', category: 'subscription', qty: 1, unitPriceHT: 20_000, vatRate: 20 }],
      contractAttachment: {
        maintenanceContractId: 'contract-fontaines',
        servicePeriod: { start: '2025-10-12', end: '2026-10-11' },
      },
    });
    expect(failClosed.ok).toBe(false);
    if (!failClosed.ok) expect(failClosed.error.kind).toBe('dependency');
  });
});

describe('IssueInvoice — garde d’émission de contrat (direction 1, erratum n° 2)', () => {
  it('deux brouillons de la MÊME période : la 2ᵉ émission est refusée avec le numéro de la 1ʳᵉ, aucun numéro consommé', async () => {
    const env = makeEnv();
    const contract = contractOf(env);
    const { prepare, ports } = prepareUseCase(env, contract);
    const first = await prepare.execute({ companyId: env.company.id, contractId: contract.id });
    const second = await prepare.execute({ companyId: env.company.id, contractId: contract.id });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const issue = issueUseCase(env, ports);
    const won = await issue.execute({ invoiceId: first.value.invoiceId, defaultTerms: DEFAULT_TERMS });
    expect(won.ok).toBe(true);
    const lost = await issue.execute({ invoiceId: second.value.invoiceId, defaultTerms: DEFAULT_TERMS });
    expect(lost.ok).toBe(false);
    if (!lost.ok) {
      expect(JSON.stringify(lost.error)).toContain('Période déjà facturée par F-2026-0001');
    }
    const loser = await env.invoiceRepo.findById(second.value.invoiceId);
    expect(loser!.number).toBeNull();
    expect(loser!.status).toBe('draft');
  });

  it('annulation de la facture couvrante → la re-préparation ET la ré-émission redeviennent possibles', async () => {
    const env = makeEnv();
    const contract = contractOf(env);
    const { prepare, ports } = prepareUseCase(env, contract);
    const first = await prepare.execute({ companyId: env.company.id, contractId: contract.id });
    if (!first.ok) throw new Error('prepare');
    const issue = issueUseCase(env, ports);
    const issued = await issue.execute({ invoiceId: first.value.invoiceId, defaultTerms: DEFAULT_TERMS });
    expect(issued.ok).toBe(true);
    const covering = await env.invoiceRepo.findById(first.value.invoiceId);
    const cancelled = covering!.cancel('Erreur de montant', env.clock.now());
    expect(cancelled.ok).toBe(true);
    await env.invoiceRepo.save(covering!);
    // Réallumage par l'état réel : la dérivation rend la période due, sans aucun code nouveau.
    const again = await prepare.execute({ companyId: env.company.id, contractId: contract.id });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const reissued = await issue.execute({ invoiceId: again.value.invoiceId, defaultTerms: DEFAULT_TERMS });
    expect(reissued.ok).toBe(true);
  });

  it('input.servicePeriod divergent du brouillon → refus ; identique → émission idempotente', async () => {
    const env = makeEnv();
    const contract = contractOf(env);
    const { prepare, ports } = prepareUseCase(env, contract);
    const prepared = await prepare.execute({ companyId: env.company.id, contractId: contract.id });
    if (!prepared.ok) throw new Error('prepare');
    const issue = issueUseCase(env, ports);
    const divergent = await issue.execute({
      invoiceId: prepared.value.invoiceId,
      defaultTerms: DEFAULT_TERMS,
      servicePeriod: { start: '2025-01-01', end: '2025-12-31' },
    });
    expect(divergent.ok).toBe(false);
    if (!divergent.ok) expect(JSON.stringify(divergent.error)).toContain('portée par le brouillon');
    const identical = await issue.execute({
      invoiceId: prepared.value.invoiceId,
      defaultTerms: DEFAULT_TERMS,
      servicePeriod: { start: '2025-10-12', end: '2026-10-11' },
    });
    expect(identical.ok).toBe(true);
    const stored = await env.invoiceRepo.findById(prepared.value.invoiceId);
    expect(stored!.servicePeriod).toEqual({ start: '2025-10-12', end: '2026-10-11' });
  });

  it('facture de contrat SANS période (état legacy) → refus actionnable, rien d’émis', async () => {
    const env = makeEnv();
    const contract = contractOf(env);
    const ports = contractPorts(env, contract);
    // État anormal fabriqué par rehydrate (aucun chemin applicatif ne le produit) : la garde
    // (a) doit refuser AVANT le compteur — jamais une couverture indéfinissable.
    const legacy = Invoice.rehydrate({
      id: 'legacy-contract-draft',
      companyId: env.company.id,
      customerId: 'cust-martin',
      kind: 'final',
      status: 'draft',
      lines: [
        { id: 'line-x', label: 'Forfait', category: 'subscription', qty: 1, unitPriceHT: 10_000, vatRate: 20 },
      ],
      number: null,
      frozenTotals: null,
      mentions: [],
      issuedAt: null,
      dueAt: null,
      paid: 0,
      depositPct: null,
      parentQuoteId: null,
      maintenanceContractId: 'contract-fontaines',
    });
    await env.invoiceRepo.save(legacy);
    const refused = await issueUseCase(env, ports).execute({
      invoiceId: 'legacy-contract-draft',
      defaultTerms: DEFAULT_TERMS,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(JSON.stringify(refused.error)).toContain('sans période de service');
    const stored = await env.invoiceRepo.findById('legacy-contract-draft');
    expect(stored!.number).toBeNull();
  });

  it('ports contrats ABSENTS + facture de contrat → refus dependency (fail-closed), aucun numéro', async () => {
    const env = makeEnv();
    const contract = contractOf(env);
    const { prepare } = prepareUseCase(env, contract);
    const prepared = await prepare.execute({ companyId: env.company.id, contractId: contract.id });
    if (!prepared.ok) throw new Error('prepare');
    const refused = await issueUseCase(env).execute({
      invoiceId: prepared.value.invoiceId,
      defaultTerms: DEFAULT_TERMS,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe('dependency');
    const stored = await env.invoiceRepo.findById(prepared.value.invoiceId);
    expect(stored!.number).toBeNull();
  });
});
