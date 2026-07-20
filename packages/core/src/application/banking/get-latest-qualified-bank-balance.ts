import {
  assessBankBalanceFreshness,
  type BankBalanceFreshnessAssessment,
  type BankBalanceFreshnessPolicy,
} from '../../domain/banking/bank-balance-freshness';
import { type BankBalanceSnapshotProps } from '../../domain/banking/bank-balance-snapshot';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type BankBalanceSnapshotRepository } from '../ports/bank-balance-snapshot-repository';
import { type ClockPort } from '../ports/services';
import { type AppError, appNotFound, appUnavailable } from '../result';

export interface QualifiedBankBalanceSnapshot extends BankBalanceSnapshotProps {
  readonly freshness: BankBalanceFreshnessAssessment & { readonly status: 'fresh' };
}

export interface GetLatestQualifiedBankBalanceDeps {
  readonly balances: BankBalanceSnapshotRepository;
  readonly clock: ClockPort;
  /** Obligatoire : aucun seuil implicite n'est appliqué par le use case. */
  readonly freshnessPolicy: BankBalanceFreshnessPolicy;
}

function dependencyError(cause: unknown): AppError {
  return {
    kind: 'dependency',
    port: 'bank-balance-snapshot-repository',
    cause: cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * Retourne uniquement une preuve bancaire fraîche et du tenant demandé.
 * Absence = not_found ; observation périmée = unavailable. Aucun zéro ni solde estimé ne remplace
 * ces états.
 */
export class GetLatestQualifiedBankBalance {
  constructor(private readonly deps: GetLatestQualifiedBankBalanceDeps) {}

  async execute(input: {
    companyId: string;
  }): Promise<Result<QualifiedBankBalanceSnapshot, AppError>> {
    if (
      input.companyId.trim() !== input.companyId ||
      input.companyId.length === 0 ||
      input.companyId.length > 128
    ) {
      return err({
        kind: 'validation',
        issues: [{ field: 'companyId', message: 'Identifiant de société invalide.' }],
      });
    }

    let snapshot;
    try {
      snapshot = await this.deps.balances.findLatestByCompanyId(input.companyId);
    } catch (cause) {
      return err(dependencyError(cause));
    }

    if (snapshot === null) {
      return err(appNotFound('bank_balance_snapshot', input.companyId));
    }
    if (snapshot.companyId !== input.companyId) {
      return err(appUnavailable('bank-balance-tenant-scope'));
    }

    const freshness = assessBankBalanceFreshness(
      snapshot,
      this.deps.clock.now(),
      this.deps.freshnessPolicy,
    );
    if (!freshness.ok) {
      return err(appUnavailable('bank-balance-qualification'));
    }
    if (freshness.value.status === 'stale') {
      return err(appUnavailable('bank-balance-stale'));
    }

    return ok({
      ...snapshot.toProps(),
      freshness: { ...freshness.value, status: 'fresh' },
    });
  }
}
