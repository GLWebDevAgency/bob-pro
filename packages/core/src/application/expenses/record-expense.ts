import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { type ExpenseRepository } from '../ports/repositories';
import { Expense, type ExpenseCategory, type ExpenseSource } from '../../domain/expense/expense';

export interface RecordExpenseInput {
  companyId: string;
  supplierName: string;
  supplierSiren?: string | null;
  documentDate: string;
  totalTtcCents: number;
  totalHtCents?: number | null;
  vatCents?: number | null;
  vatRatePct?: number | null;
  category: ExpenseCategory;
  source?: ExpenseSource;
}

export interface RecordExpenseDeps {
  expenses: ExpenseRepository;
  ids: IdGeneratorPort;
  clock: ClockPort;
}

/** Enregistre une dépense fournisseur (saisie manuelle ou confirmation d'une extraction OCR). */
export class RecordExpense {
  constructor(private readonly deps: RecordExpenseDeps) {}

  async execute(input: RecordExpenseInput): Promise<Result<{ id: string }, AppError>> {
    const id = this.deps.ids.newId();
    const r = Expense.record({
      id,
      companyId: input.companyId,
      supplierName: input.supplierName,
      supplierSiren: input.supplierSiren ?? null,
      documentDate: input.documentDate,
      totalTtcCents: input.totalTtcCents,
      totalHtCents: input.totalHtCents ?? null,
      vatCents: input.vatCents ?? null,
      vatRatePct: input.vatRatePct ?? null,
      category: input.category,
      status: 'to_pay',
      source: input.source ?? 'manual',
    }, { today: this.deps.clock.today() });
    if (!r.ok) return err(appDomain(r.error));
    await this.deps.expenses.save(r.value);
    return ok({ id });
  }
}
