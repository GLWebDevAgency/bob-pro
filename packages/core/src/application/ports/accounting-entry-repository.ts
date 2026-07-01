import { type AccountingEntry } from '../../domain/accounting/accounting-entry';

export interface AccountingEntryRepository {
  save(entry: AccountingEntry): Promise<void>;
  findById(companyId: string, id: string): Promise<AccountingEntry | null>;
  listByCompany(companyId: string): Promise<AccountingEntry[]>;
}
