import { type Result, ok } from '../../shared-kernel/result';
import { type AppError } from '../result';
import {
  projectCashflow,
  type Scenario,
  type Horizon,
  type CashflowProjection,
} from '../../domain/services/project-cashflow';
import { type CashflowSnapshotPort } from '../ports/services';

export class GetCashflow {
  constructor(private readonly deps: { snapshots: CashflowSnapshotPort }) {}

  async execute(input: {
    companyId: string;
    scenario: Scenario;
    horizon: Horizon;
  }): Promise<Result<CashflowProjection, AppError>> {
    const snapshot = await this.deps.snapshots.get(input.companyId);
    return ok(projectCashflow(snapshot, input.scenario, input.horizon));
  }
}
