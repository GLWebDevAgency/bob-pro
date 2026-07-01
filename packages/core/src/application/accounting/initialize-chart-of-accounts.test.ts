import { describe, it, expect } from 'vitest';
import { ChartOfAccounts } from '../../domain/accounting/chart-of-accounts';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';
import { InitializeChartOfAccounts } from './initialize-chart-of-accounts';

class MemoryCharts implements ChartOfAccountsRepository {
  saved: ChartOfAccounts[] = [];

  async save(chart: ChartOfAccounts): Promise<void> {
    this.saved.push(chart);
  }

  async findByCompany(companyId: string): Promise<ChartOfAccounts | null> {
    return this.saved.find((chart) => chart.companyId === companyId) ?? null;
  }
}

describe('InitializeChartOfAccounts', () => {
  it('initialise le gabarit operationnel FR par defaut', async () => {
    const charts = new MemoryCharts();
    const useCase = new InitializeChartOfAccounts({ charts });

    const r = await useCase.execute({ companyId: 'co-1' });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.created).toBe(true);
      expect(r.value.accountCount).toBeGreaterThan(70);
      expect(r.value.postingAccountCount).toBeGreaterThan(40);
    }
    expect(charts.saved).toHaveLength(1);
    expect(charts.saved[0]?.acceptsPosting('706')).toBe(true);
  });

  it('est idempotent et ne remplace pas un plan existant', async () => {
    const existing = ChartOfAccounts.create({
      companyId: 'co-1',
      accounts: [{ code: '411', label: 'Clients custom', kind: 'asset' }],
    });
    expect(existing.ok).toBe(true);
    const charts = new MemoryCharts();
    if (existing.ok) charts.saved.push(existing.value);
    const useCase = new InitializeChartOfAccounts({ charts });

    const r = await useCase.execute({ companyId: 'co-1' });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.created).toBe(false);
      expect(r.value.accountCount).toBe(1);
    }
    expect(charts.saved).toHaveLength(1);
    expect(charts.saved[0]?.find('411')?.label).toBe('Clients custom');
  });

  it('retourne une erreur domaine pour un plan custom invalide', async () => {
    const charts = new MemoryCharts();
    const useCase = new InitializeChartOfAccounts({ charts });

    const r = await useCase.execute({
      companyId: 'co-1',
      accounts: [{ code: 'client', label: 'Clients', kind: 'asset' }],
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'domain' });
    expect(charts.saved).toHaveLength(0);
  });
});
