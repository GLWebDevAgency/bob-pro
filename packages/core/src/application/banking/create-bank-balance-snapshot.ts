import {
  BankBalanceSnapshot,
  type BankBalanceReconciliationStatus,
  type BankBalanceSnapshotProps,
  type BankBalanceSource,
} from '../../domain/banking/bank-balance-snapshot';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { type BankBalanceSnapshotRepository } from '../ports/bank-balance-snapshot-repository';
import { type ClockPort } from '../ports/services';
import { type AppError, appConflict, appDomain } from '../result';

export interface CreateBankBalanceSnapshotInput {
  readonly id: string;
  readonly companyId: string;
  readonly amountCents: number;
  readonly currency: 'EUR';
  readonly source: BankBalanceSource;
  readonly reconciliationStatus: BankBalanceReconciliationStatus;
  readonly observedAt: Instant;
}

export interface CreateBankBalanceSnapshotDeps {
  readonly balances: BankBalanceSnapshotRepository;
  readonly clock: ClockPort;
}

function dependencyError(cause: unknown): AppError {
  return {
    kind: 'dependency',
    port: 'bank-balance-snapshot-repository',
    cause: cause instanceof Error ? cause.message : String(cause),
  };
}

/** Ajoute une observation bancaire immuable ; aucune valeur financière n'est dérivée ou complétée. */
export class CreateBankBalanceSnapshot {
  constructor(private readonly deps: CreateBankBalanceSnapshotDeps) {}

  async execute(
    input: CreateBankBalanceSnapshotInput,
  ): Promise<Result<BankBalanceSnapshotProps, AppError>> {
    const snapshot = BankBalanceSnapshot.record({
      ...input,
      recordedAt: this.deps.clock.now(),
    });
    if (!snapshot.ok) return err(appDomain(snapshot.error));

    let outcome;
    try {
      outcome = await this.deps.balances.append(snapshot.value);
    } catch (cause) {
      return err(dependencyError(cause));
    }

    if (outcome === 'id_conflict') {
      return err(appConflict('bank_balance_snapshot', input.id));
    }
    return ok(snapshot.value.toProps());
  }
}
