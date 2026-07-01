import { type Result, ok, err } from '../../shared-kernel/result';
import {
  ChartOfAccounts,
  type AccountingAccountInput,
  createFrenchOperationalChartOfAccounts,
} from '../../domain/accounting/chart-of-accounts';
import { type AppError, appDomain } from '../result';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';

export interface InitializeChartOfAccountsInput {
  companyId: string;
  /** Si absent, Bob initialise le gabarit operationnel FR. */
  accounts?: AccountingAccountInput[];
}

export interface InitializeChartOfAccountsDeps {
  charts: ChartOfAccountsRepository;
}

export interface InitializeChartOfAccountsOutput {
  companyId: string;
  created: boolean;
  accountCount: number;
  postingAccountCount: number;
}

/**
 * Initialise le plan comptable d'une societe.
 * Idempotent : si le plan existe deja, il est renvoye sans ecraser les personnalisations.
 */
export class InitializeChartOfAccounts {
  constructor(private readonly deps: InitializeChartOfAccountsDeps) {}

  async execute(input: InitializeChartOfAccountsInput): Promise<Result<InitializeChartOfAccountsOutput, AppError>> {
    const existing = await this.deps.charts.findByCompany(input.companyId);
    if (existing) return ok(this.output(existing, false));

    const chart = input.accounts
      ? ChartOfAccounts.create({ companyId: input.companyId, accounts: input.accounts })
      : createFrenchOperationalChartOfAccounts(input.companyId);
    if (!chart.ok) return err(appDomain(chart.error));

    await this.deps.charts.save(chart.value);
    return ok(this.output(chart.value, true));
  }

  private output(chart: ChartOfAccounts, created: boolean): InitializeChartOfAccountsOutput {
    return {
      companyId: chart.companyId,
      created,
      accountCount: chart.accounts.length,
      postingAccountCount: chart.postingAccounts.length,
    };
  }
}
