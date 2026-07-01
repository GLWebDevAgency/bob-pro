import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import {
  projectCashflow,
  type Scenario,
  type Horizon,
  type CashflowProjection,
} from '../../domain/services/project-cashflow';
import { type CashflowSnapshotPort } from '../ports/services';
import { type ExpenseRepository } from '../ports/repositories';

const SCENARIOS: readonly Scenario[] = ['optimiste', 'realiste', 'prudent'];
const HORIZONS: readonly Horizon[] = [7, 30, 60, 90];

function parseScenario(value: unknown): Result<Scenario, AppError> {
  if (typeof value === 'string' && SCENARIOS.includes(value as Scenario)) return ok(value as Scenario);
  return err(appDomain({ code: 'VALIDATION', field: 'scenario', message: 'Scenario de trésorerie invalide.' }));
}

function parseHorizon(value: unknown): Result<Horizon, AppError> {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (HORIZONS.includes(n as Horizon)) return ok(n as Horizon);
  return err(appDomain({ code: 'VALIDATION', field: 'horizon', message: 'Horizon de trésorerie invalide.' }));
}

export class GetCashflow {
  constructor(private readonly deps: { snapshots: CashflowSnapshotPort; expenses?: ExpenseRepository }) {}

  async execute(input: {
    companyId: string;
    scenario: unknown;
    horizon: unknown;
  }): Promise<Result<CashflowProjection, AppError>> {
    const scenario = parseScenario(input.scenario);
    if (!scenario.ok) return scenario;
    const horizon = parseHorizon(input.horizon);
    if (!horizon.ok) return horizon;

    const snapshot = await this.deps.snapshots.get(input.companyId);
    let charges = snapshot.charges;
    if (this.deps.expenses) {
      // Les dépenses « à payer » sont des charges à venir : elles réduisent le prévisionnel.
      const list = await this.deps.expenses.listByCompany(input.companyId);
      charges += list.filter((e) => e.status === 'to_pay').reduce((sum, e) => sum + e.totalTtcCents, 0);
    }
    return ok(projectCashflow({ ...snapshot, charges }, scenario.value, horizon.value));
  }
}
