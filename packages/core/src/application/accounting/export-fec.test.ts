import { describe, expect, it } from 'vitest';
import { AccountingEntry, type AccountingEntryProps } from '../../domain/accounting/accounting-entry';
import { createFrenchOperationalChartOfAccounts, type ChartOfAccounts } from '../../domain/accounting/chart-of-accounts';
import { seedCompany } from '../fixtures';
import { type CompanyRepository } from '../ports/repositories';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';
import { ExportFec, FEC_HEADERS, type FecAuxiliaryData } from './export-fec';

function entry(props: AccountingEntryProps): AccountingEntry {
  const r = AccountingEntry.create(props);
  if (!r.ok) throw new Error('entry');
  return r.value;
}

class MemoryCompanies implements CompanyRepository {
  private readonly company = seedCompany();
  async findById(id: string) {
    return id === this.company.id ? this.company : null;
  }
  async list() {
    return [this.company];
  }
  async save(): Promise<void> {
    throw new Error('not used');
  }
}

class MemoryEntries implements AccountingEntryRepository {
  constructor(private readonly rows: AccountingEntry[]) {}

  async save(_entry: AccountingEntry): Promise<void> {
    throw new Error('not used');
  }

  async findById(companyId: string, id: string): Promise<AccountingEntry | null> {
    return this.rows.find((entry) => entry.companyId === companyId && entry.id === id) ?? null;
  }

  async listByCompany(companyId: string): Promise<AccountingEntry[]> {
    return this.rows.filter((entry) => entry.companyId === companyId);
  }
}

class MemoryCharts implements ChartOfAccountsRepository {
  constructor(private readonly chart: ChartOfAccounts | null) {}

  async save(_chart: ChartOfAccounts): Promise<void> {
    throw new Error('not used');
  }

  async findByCompany(companyId: string): Promise<ChartOfAccounts | null> {
    return this.chart?.companyId === companyId ? this.chart : null;
  }
}

function makeUseCase(entries: AccountingEntry[], chart: ChartOfAccounts | null = null): ExportFec {
  return new ExportFec({
    companies: new MemoryCompanies(),
    entries: new MemoryEntries(entries),
    charts: new MemoryCharts(chart),
  });
}

function makeUseCaseWithAuxiliary(
  entries: AccountingEntry[],
  auxiliary: FecAuxiliaryData,
  chart: ChartOfAccounts | null = null,
): ExportFec {
  return new ExportFec({
    companies: new MemoryCompanies(),
    entries: new MemoryEntries(entries),
    charts: new MemoryCharts(chart),
    auxiliary: { get: async () => auxiliary },
  });
}

describe('ExportFec', () => {
  it('exporte les ecritures en 18 colonnes FEC triees chronologiquement', async () => {
    const chart = createFrenchOperationalChartOfAccounts('company-mercier');
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;
    const entries = [
      entry({
        id: 'payment-1',
        companyId: 'company-mercier',
        journal: 'bank',
        sourceType: 'payment',
        sourceId: 'pay-1',
        entryDate: '2026-06-07',
        reference: 'F-2026-0001',
        label: 'Encaissement F-2026-0001',
        lines: [
          { account: '512', label: 'Encaissement F-2026-0001', debitCents: 48840, creditCents: 0 },
          { account: '411', label: 'Encaissement F-2026-0001', debitCents: 0, creditCents: 48840 },
        ],
      }),
      entry({
        id: 'invoice-1',
        companyId: 'company-mercier',
        journal: 'sales',
        sourceType: 'invoice',
        sourceId: 'inv-1',
        entryDate: '2026-06-01',
        reference: 'F-2026-0001',
        label: 'Facture F-2026-0001',
        lines: [
          { account: '411', label: 'Facture F-2026-0001', debitCents: 48840, creditCents: 0 },
          { account: '4191', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 44400 },
          { account: '44571', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 4440 },
        ],
      }),
    ];

    const r = await makeUseCase(entries, chart.value).execute({
      companyId: 'company-mercier',
      from: '2026-01-01',
      to: '2026-12-31',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.filename).toBe('732829320FEC20261231.txt');
    expect(r.value.descriptionFilename).toBe('732829320FEC20261231-description.txt');
    expect(r.value.descriptionContent).toContain('Separateur de champs: tabulation.');
    expect(r.value.descriptionContent).toContain('BQ: Journal de banque');
    expect(r.value.entryCount).toBe(2);
    expect(r.value.rowCount).toBe(5);
    expect(r.value.warnings).toEqual([]);
    const lines = r.value.content.split('\n');
    expect(lines[0]).toBe(FEC_HEADERS.join('\t'));
    const first = lines[1]!.split('\t');
    expect(first).toHaveLength(18);
    expect(first.slice(0, 6)).toEqual(['VE', 'Journal des ventes', '000001', '20260601', '411', 'Clients']);
    expect(first[8]).toBe('F-2026-0001');
    expect(first[11]).toBe('488,40');
    expect(first[12]).toBe('0,00');

    const payment = lines[4]!.split('\t');
    expect(payment.slice(0, 6)).toEqual(['BQ', 'Journal de banque', '000002', '20260607', '512', 'Banques']);
    expect(payment[11]).toBe('488,40');
  });

  it('filtre la periode demandee et conserve seulement len-tete si aucune ecriture', async () => {
    const r = await makeUseCase([
      entry({
        id: 'invoice-1',
        companyId: 'company-mercier',
        journal: 'sales',
        sourceType: 'invoice',
        sourceId: 'inv-1',
        entryDate: '2026-06-01',
        reference: 'F-2026-0001',
        label: 'Facture F-2026-0001',
        lines: [
          { account: '411', label: 'Facture F-2026-0001', debitCents: 100, creditCents: 0 },
          { account: '706', label: 'Facture F-2026-0001', debitCents: 0, creditCents: 100 },
        ],
      }),
    ]).execute({ companyId: 'company-mercier', from: '2027-01-01', to: '2027-12-31' });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.rowCount).toBe(0);
      expect(r.value.content).toBe(`${FEC_HEADERS.join('\t')}\n`);
    }
  });

  it('refuse une periode invalide', async () => {
    const r = await makeUseCase([]).execute({ companyId: 'company-mercier', from: '2026-12-31', to: '2026-01-01' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'validation' });
  });

  // ── E7 : FEC probant — lettrage 411 + comptes auxiliaires clients/fournisseurs ──

  const AUX: FecAuxiliaryData = {
    invoices: [
      { id: 'inv-paid', status: 'paid', customerId: 'cust-sevres' },
      { id: 'inv-open', status: 'issued', customerId: 'cust-sevres' },
    ],
    payments: [{ id: 'pay-1', invoiceId: 'inv-paid', receivedAt: '2026-07-02T10:00:00.000Z' }],
    customers: [{ id: 'cust-sevres', name: 'Mairie de Sèvres' }],
    expenses: [{ id: 'exp-1', supplierName: 'Leroy Merlin' }],
  };

  function saleEntry(id: string, sourceId: string, ref: string): AccountingEntry {
    return entry({
      id,
      companyId: 'company-mercier',
      journal: 'sales',
      sourceType: 'invoice',
      sourceId,
      entryDate: '2026-07-01',
      reference: ref,
      label: `Facture ${ref}`,
      lines: [
        { account: '411', label: `Facture ${ref}`, debitCents: 12000, creditCents: 0 },
        { account: '706', label: `Facture ${ref}`, debitCents: 0, creditCents: 12000 },
      ],
    });
  }

  it('E7 : lettrage posé sur les 411 de la facture SOLDÉE et de son encaissement — jamais sur l’ouverte', async () => {
    const entries = [
      saleEntry('e-sale-paid', 'inv-paid', 'F-2026-0001'),
      saleEntry('e-sale-open', 'inv-open', 'F-2026-0002'),
      entry({
        id: 'e-pay',
        companyId: 'company-mercier',
        journal: 'bank',
        sourceType: 'payment',
        sourceId: 'pay-1',
        entryDate: '2026-07-02',
        reference: 'F-2026-0001',
        label: 'Encaissement F-2026-0001',
        lines: [
          { account: '512', label: 'Encaissement', debitCents: 12000, creditCents: 0 },
          { account: '411', label: 'Encaissement', debitCents: 0, creditCents: 12000 },
        ],
      }),
    ];
    const r = await makeUseCaseWithAuxiliary(entries, AUX).execute({
      companyId: 'company-mercier',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.value.content.trimEnd().split('\n').slice(1).map((l) => l.split('\t'));
    const on411 = rows.filter((row) => row[4] === '411');
    // Facture payée (vente + encaissement) : lettre AA + DateLet = date du règlement.
    const lettered = on411.filter((row) => row[13] === 'AA');
    expect(lettered).toHaveLength(2);
    expect(lettered.every((row) => row[14] === '20260702')).toBe(true);
    // Facture ouverte : JAMAIS lettrée (lettrage partiel interdit).
    const open = rows.find((row) => row[8] === 'F-2026-0002' && row[4] === '411');
    expect(open?.[13]).toBe('');
    expect(open?.[14]).toBe('');
    // Auxiliaire client sur TOUTES les lignes 411 (solde justifiable par tiers).
    expect(on411.every((row) => row[6] === '411CUST-SEVRES' && row[7] === 'Mairie de Sèvres')).toBe(true);
  });

  it('E7 : auxiliaire FOURNISSEUR sur les lignes 401 des écritures de dépense', async () => {
    const purchase = entry({
      id: 'e-exp',
      companyId: 'company-mercier',
      journal: 'purchases',
      sourceType: 'expense',
      sourceId: 'exp-1',
      entryDate: '2026-07-03',
      reference: 'Leroy Merlin',
      label: 'Achat Leroy Merlin',
      lines: [
        { account: '606', label: 'Achat', debitCents: 15408, creditCents: 0 },
        { account: '44566', label: 'Achat', debitCents: 3082, creditCents: 0 },
        { account: '401', label: 'Achat', debitCents: 0, creditCents: 18490 },
      ],
    });
    const r = await makeUseCaseWithAuxiliary([purchase], AUX).execute({
      companyId: 'company-mercier',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.value.content.trimEnd().split('\n').slice(1).map((l) => l.split('\t'));
    const on401 = rows.find((row) => row[4] === '401');
    expect(on401?.[6]).toBe('401LEROY-MERLIN');
    expect(on401?.[7]).toBe('Leroy Merlin');
    // Les lignes de charge/TVA ne portent PAS d'auxiliaire.
    expect(rows.find((row) => row[4] === '606')?.[6]).toBe('');
  });
});
