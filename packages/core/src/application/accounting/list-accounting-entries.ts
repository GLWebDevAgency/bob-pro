import { type Result, ok } from '../../shared-kernel/result';
import { type AccountingEntryProps } from '../../domain/accounting/accounting-entry';
import { type AppError } from '../result';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';

export interface ListAccountingEntriesInput {
  companyId: string;
}

export interface ListAccountingEntriesDeps {
  entries: AccountingEntryRepository;
}

export class ListAccountingEntries {
  constructor(private readonly deps: ListAccountingEntriesDeps) {}

  async execute(input: ListAccountingEntriesInput): Promise<Result<AccountingEntryProps[], AppError>> {
    const entries = await this.deps.entries.listByCompany(input.companyId);
    return ok(entries.map((entry) => entry.toProps()));
  }
}
