import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import {
  projectCashflow,
  type Scenario,
  type Horizon,
  type CashflowProjection,
} from '../../domain/services/project-cashflow';
import { type CashflowSnapshotPort } from '../ports/services';
import { type ExpenseRepository, type InvoiceRepository } from '../ports/repositories';
import { deriveVatPosition } from '../argent/derive-vat-position';
import { type Expense } from '../../domain/expense/expense';

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
  constructor(
    private readonly deps: {
      snapshots: CashflowSnapshotPort;
      expenses?: ExpenseRepository;
      /** Fournir les factures = position de TVA RÉELLE (deriveVatPosition, chantier 2) ;
       *  sans elles, repli sur le vatDue du snapshot (compat implémentations amont). */
      invoices?: InvoiceRepository;
    },
  ) {}

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
    let expenseList: Expense[] = [];
    if (this.deps.expenses) {
      // Les dépenses « à payer » sont des charges à venir : elles réduisent le prévisionnel.
      expenseList = await this.deps.expenses.listByCompany(input.companyId);
      charges += expenseList.filter((e) => e.status === 'to_pay').reduce((sum, e) => sum + e.totalTtcCents, 0);
    }

    let vatDue = snapshot.vatDue;
    if (this.deps.invoices) {
      // TVA à provisionner DÉRIVÉE (collectée sur ENCAISSEMENTS − déductible mentionnée) :
      // le même chiffre ampute la dispo, calibre la réserve du payout ET alimente le KPI.
      const invoices = await this.deps.invoices.listByCompany(input.companyId);
      vatDue = deriveVatPosition({
        invoices: invoices.map((i) => ({ kind: i.kind, status: i.status, totals: i.totals(), paid: i.paid })),
        expenses: expenseList.map((e) => ({ vatCents: e.toProps().vatCents })),
      }).netDueCents;
    }

    return ok(projectCashflow({ ...snapshot, charges, vatDue }, scenario.value, horizon.value));
  }
}
