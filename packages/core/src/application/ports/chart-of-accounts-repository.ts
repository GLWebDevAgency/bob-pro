import { type ChartOfAccounts } from '../../domain/accounting/chart-of-accounts';

export interface ChartOfAccountsRepository {
  save(chart: ChartOfAccounts): Promise<void>;
  findByCompany(companyId: string): Promise<ChartOfAccounts | null>;
}
