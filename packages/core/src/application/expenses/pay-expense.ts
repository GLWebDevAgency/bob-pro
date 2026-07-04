import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appNotFound } from '../result';
import { type ExpenseRepository } from '../ports/repositories';
import { type ClockPort } from '../ports/services';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';
import { buildExpensePaymentAccountingEntry } from '../../domain/accounting/expense-accounting';
import { expensePaymentAccountingEntryId } from '../accounting/record-expense-accounting-entries';
import { appDomain } from '../result';

export interface PayExpenseDeps {
  expenses: ExpenseRepository;
  entries: AccountingEntryRepository;
  clock: ClockPort;
  charts?: ChartOfAccountsRepository;
}

/**
 * Règle une dépense fournisseur (E4) : transition to_pay → paid + écriture de
 * DÉCAISSEMENT 401/512 au journal de banque, à la DATE RÉELLE du règlement (aujourd'hui,
 * pas la date de la pièce). Miroir exact de l'encaissement client. Idempotent de bout en
 * bout : dépense déjà payée → ok sans effet ; écriture déjà postée (id déterministe
 * expense:{id}:paid) → jamais doublée. Même use case pour l'écran Dépenses et pour Bob.
 */
export class PayExpense {
  constructor(private readonly deps: PayExpenseDeps) {}

  async execute(input: { expenseId: string }): Promise<Result<{ status: 'paid'; alreadyPaid: boolean }, AppError>> {
    const expense = await this.deps.expenses.findById(input.expenseId);
    if (!expense) return err(appNotFound('expense', input.expenseId));

    const alreadyPaid = expense.status === 'paid';
    if (!alreadyPaid) {
      expense.markPaid();
      await this.deps.expenses.save(expense);
    }

    const entryId = expensePaymentAccountingEntryId(expense.id);
    const existing = await this.deps.entries.findById(expense.companyId, entryId);
    if (!existing) {
      const chart = this.deps.charts ? await this.deps.charts.findByCompany(expense.companyId) : null;
      const entry = buildExpensePaymentAccountingEntry({
        entryId,
        expense,
        paidOn: this.deps.clock.today(),
        ...(chart ? { chart } : {}),
      });
      if (!entry.ok) return err(appDomain(entry.error));
      await this.deps.entries.save(entry.value);
    }

    return ok({ status: 'paid', alreadyPaid });
  }
}
