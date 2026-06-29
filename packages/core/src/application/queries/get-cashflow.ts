import { type Result, ok } from '../../shared-kernel/result';
import { type AppError } from '../result';
import {
  projectCashflow,
  type Scenario,
  type Horizon,
  type CashflowProjection,
} from '../../domain/services/project-cashflow';
import { type CashflowSnapshotPort } from '../ports/services';
import { type ExpenseRepository } from '../ports/repositories';

export class GetCashflow {
  constructor(private readonly deps: { snapshots: CashflowSnapshotPort; expenses?: ExpenseRepository }) {}

  async execute(input: {
    companyId: string;
    scenario: Scenario;
    horizon: Horizon;
  }): Promise<Result<CashflowProjection, AppError>> {
    const snapshot = await this.deps.snapshots.get(input.companyId);
    let charges = snapshot.charges;
    if (this.deps.expenses) {
      // Les dépenses « à payer » sont des charges à venir : elles réduisent le prévisionnel.
      const list = await this.deps.expenses.listByCompany(input.companyId);
      charges += list.filter((e) => e.status === 'to_pay').reduce((sum, e) => sum + e.totalTtcCents, 0);
    }
    return ok(projectCashflow({ ...snapshot, charges }, input.scenario, input.horizon));
  }
}
