import { type Result, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type ExpenseRepository } from '../ports/repositories';
import { type ClockPort } from '../ports/services';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';

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
    void this.deps;
    void input;
    return err(appDomain({
      code: 'VALIDATION',
      field: 'paymentEvidence',
      message: 'Date et moyen du règlement requis. Utiliser RecordExpensePayment.',
    }));
  }
}
