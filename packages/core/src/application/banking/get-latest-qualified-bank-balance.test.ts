import { describe, expect, it } from 'vitest';
import { BANK_BALANCE_FRESHNESS_POLICY_V1 } from '../../domain/banking/bank-balance-freshness';
import {
  BankBalanceSnapshot,
  type BankBalanceSnapshotProps,
} from '../../domain/banking/bank-balance-snapshot';
import { type BankBalanceSnapshotRepository } from '../ports/bank-balance-snapshot-repository';
import { GetLatestQualifiedBankBalance } from './get-latest-qualified-bank-balance';

function record(patch: Partial<BankBalanceSnapshotProps> = {}): BankBalanceSnapshot {
  const result = BankBalanceSnapshot.record({
    id: 'balance-1',
    companyId: 'company-1',
    amountCents: 250_000,
    currency: 'EUR',
    source: 'bank_connector',
    reconciliationStatus: 'unreconciled',
    observedAt: '2026-07-17T08:00:00.000Z',
    recordedAt: '2026-07-17T08:00:01.000Z',
    ...patch,
  });
  if (!result.ok) throw new Error('Donnée de test invalide.');
  return result.value;
}

class LatestBalanceRepository implements BankBalanceSnapshotRepository {
  latest: BankBalanceSnapshot | null = null;
  findError: Error | null = null;

  async append(): Promise<'created'> {
    return 'created';
  }

  async findLatestByCompanyId(): Promise<BankBalanceSnapshot | null> {
    if (this.findError !== null) throw this.findError;
    return this.latest;
  }
}

function useCase(repository: LatestBalanceRepository, now = '2026-07-17T09:00:00.000Z') {
  return new GetLatestQualifiedBankBalance({
    balances: repository,
    clock: { now: () => now, today: () => now.slice(0, 10) },
    freshnessPolicy: BANK_BALANCE_FRESHNESS_POLICY_V1,
  });
}

describe('GetLatestQualifiedBankBalance', () => {
  it('retourne le solde DB avec sa preuve de fraîcheur et son rapprochement', async () => {
    const repository = new LatestBalanceRepository();
    repository.latest = record({ amountCents: -1_500, reconciliationStatus: 'reconciled' });

    const result = await useCase(repository).execute({ companyId: 'company-1' });

    expect(result).toEqual({
      ok: true,
      value: {
        id: 'balance-1',
        companyId: 'company-1',
        amountCents: -1_500,
        currency: 'EUR',
        source: 'bank_connector',
        reconciliationStatus: 'reconciled',
        observedAt: '2026-07-17T08:00:00.000Z',
        recordedAt: '2026-07-17T08:00:01.000Z',
        freshness: {
          status: 'fresh',
          ageSeconds: 3_600,
          maximumAgeSeconds: 21_600,
          evaluatedAt: '2026-07-17T09:00:00.000Z',
          policyVersion: 'bank-balance-freshness/1',
        },
      },
    });
  });

  it('échoue not_found si le tenant ne possède aucune observation', async () => {
    const repository = new LatestBalanceRepository();

    const result = await useCase(repository).execute({ companyId: 'company-empty' });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'bank_balance_snapshot', id: 'company-empty' },
    });
  });

  it('refuse un tenant vide avant la lecture du repository', async () => {
    const repository = new LatestBalanceRepository();

    const result = await useCase(repository).execute({ companyId: '' });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'companyId', message: 'Identifiant de société invalide.' }],
      },
    });
  });

  it('échoue unavailable si la dernière observation est périmée, sans inventer zéro', async () => {
    const repository = new LatestBalanceRepository();
    repository.latest = record();

    const result = await useCase(repository, '2026-07-17T14:00:01.000Z').execute({
      companyId: 'company-1',
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'bank-balance-stale' },
    });
  });

  it('rejette fail-closed une fuite inter-tenant du repository', async () => {
    const repository = new LatestBalanceRepository();
    repository.latest = record({ companyId: 'company-b' });

    const result = await useCase(repository).execute({ companyId: 'company-a' });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'bank-balance-tenant-scope' },
    });
  });

  it('échoue unavailable si l’horloge ou la politique ne permettent pas de qualifier la donnée', async () => {
    const repository = new LatestBalanceRepository();
    repository.latest = record();

    const result = await useCase(repository, '2026-07-17T07:00:00.000Z').execute({
      companyId: 'company-1',
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'bank-balance-qualification' },
    });
  });

  it('rend une panne de lecture explicite', async () => {
    const repository = new LatestBalanceRepository();
    repository.findError = new Error('database offline');

    const result = await useCase(repository).execute({ companyId: 'company-1' });

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
