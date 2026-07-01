import { type Result, ok, err } from '../../shared-kernel/result';
import { AccountingEntry, type AccountingEntryLineProps, type AccountingJournal, type AccountingSourceType } from '../../domain/accounting/accounting-entry';
import { type AppError, appDomain } from '../result';
import { type IdGeneratorPort } from '../ports/services';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';

export interface RecordAccountingEntryInput {
  companyId: string;
  journal: AccountingJournal;
  sourceType: AccountingSourceType;
  sourceId: string;
  entryDate: string;
  reference: string;
  label: string;
  lines: AccountingEntryLineProps[];
}

export interface RecordAccountingEntryDeps {
  entries: AccountingEntryRepository;
  ids: IdGeneratorPort;
}

/**
 * Enregistre une écriture de pré-comptabilité déjà préparée par un workflow métier.
 * Le use case ne choisit pas les comptes : il valide et persiste une écriture équilibrée.
 */
export class RecordAccountingEntry {
  constructor(private readonly deps: RecordAccountingEntryDeps) {}

  async execute(input: RecordAccountingEntryInput): Promise<Result<{ id: string; totalDebitCents: number; totalCreditCents: number }, AppError>> {
    const id = this.deps.ids.newId();
    const entry = AccountingEntry.create({ id, ...input });
    if (!entry.ok) return err(appDomain(entry.error));
    await this.deps.entries.save(entry.value);
    return ok({ id, totalDebitCents: entry.value.totalDebitCents, totalCreditCents: entry.value.totalCreditCents });
  }
}
