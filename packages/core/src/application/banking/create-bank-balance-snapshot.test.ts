import { describe, expect, it } from 'vitest';
import { type BankBalanceSnapshot } from '../../domain/banking/bank-balance-snapshot';
import { type BankBalanceSnapshotRepository } from '../ports/bank-balance-snapshot-repository';
import { CreateBankBalanceSnapshot } from './create-bank-balance-snapshot';

class MemoryBankBalances implements BankBalanceSnapshotRepository {
  readonly snapshots: BankBalanceSnapshot[] = [];
  outcome: 'created' | 'id_conflict' = 'created';
  appendError: Error | null = null;

  async append(snapshot: BankBalanceSnapshot): Promise<'created' | 'id_conflict'> {
    if (this.appendError !== null) throw this.appendError;
    if (this.outcome === 'created') this.snapshots.push(snapshot);
    return this.outcome;
  }

  async findLatestByCompanyId(companyId: string): Promise<BankBalanceSnapshot | null> {
    return this.snapshots.find((snapshot) => snapshot.companyId === companyId) ?? null;
  }
}

const input = () => ({
  id: 'balance-1',
  companyId: 'company-1',
  amountCents: -98_765,
  currency: 'EUR' as const,
  source: 'manual_confirmed' as const,
  reconciliationStatus: 'reconciled' as const,
  observedAt: '2026-07-17T07:30:00.000Z',
});

describe('CreateBankBalanceSnapshot', () => {
  it('enregistre exactement le montant observé et date l’écriture avec l’horloge serveur', async () => {
    const balances = new MemoryBankBalances();
    const useCase = new CreateBankBalanceSnapshot({
      balances,
      clock: { now: () => '2026-07-17T08:00:00.000Z', today: () => '2026-07-17' },
    });

    const result = await useCase.execute(input());

    expect(result).toEqual({
      ok: true,
      value: {
        ...input(),
        recordedAt: '2026-07-17T08:00:00.000Z',
      },
    });
    expect(balances.snapshots[0]?.toProps()).toEqual(result.ok ? result.value : null);
  });

  it('refuse un montant invalide avant toute persistance', async () => {
    const balances = new MemoryBankBalances();
    const useCase = new CreateBankBalanceSnapshot({
      balances,
      clock: { now: () => '2026-07-17T08:00:00.000Z', today: () => '2026-07-17' },
    });

    const result = await useCase.execute({ ...input(), amountCents: 12.34 });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'domain', error: { code: 'VALIDATION', field: 'amountCents' } },
    });
    expect(balances.snapshots).toHaveLength(0);
  });

  it('refuse un observedAt futur par rapport à l’horloge serveur', async () => {
    const balances = new MemoryBankBalances();
    const useCase = new CreateBankBalanceSnapshot({
      balances,
      clock: { now: () => '2026-07-17T08:00:00.000Z', today: () => '2026-07-17' },
    });

    const result = await useCase.execute({ ...input(), observedAt: '2026-07-17T08:00:00.001Z' });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'domain', error: { code: 'VALIDATION', field: 'observedAt' } },
    });
    expect(balances.snapshots).toHaveLength(0);
  });

  it('ne remplace jamais une capture existante portant le même id', async () => {
    const balances = new MemoryBankBalances();
    balances.outcome = 'id_conflict';
    const useCase = new CreateBankBalanceSnapshot({
      balances,
      clock: { now: () => '2026-07-17T08:00:00.000Z', today: () => '2026-07-17' },
    });

    const result = await useCase.execute(input());

    expect(result).toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'bank_balance_snapshot', reason: 'balance-1' },
    });
    expect(balances.snapshots).toHaveLength(0);
  });

  it('rend une panne de persistance explicite', async () => {
    const balances = new MemoryBankBalances();
    balances.appendError = new Error('database offline');
    const useCase = new CreateBankBalanceSnapshot({
      balances,
      clock: { now: () => '2026-07-17T08:00:00.000Z', today: () => '2026-07-17' },
    });

    const result = await useCase.execute(input());

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'bank-balance-snapshot-repository',
        cause: 'database offline',
      },
    });
  });
});
