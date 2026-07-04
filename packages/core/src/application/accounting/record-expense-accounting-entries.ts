import { type Result, ok, err } from '../../shared-kernel/result';
import {
  buildExpensePaymentAccountingEntry,
  buildRecordedExpenseAccountingEntry,
} from '../../domain/accounting/expense-accounting';
import { type AppError, appDomain, appNotFound } from '../result';
import { type ExpenseRepository } from '../ports/repositories';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';

export interface RecordExpenseAccountingEntriesDeps {
  expenses: ExpenseRepository;
  entries: AccountingEntryRepository;
  charts?: ChartOfAccountsRepository;
}

export interface RecordExpenseAccountingEntriesOutput {
  purchaseEntryId: string;
  /** Posté seulement si la dépense est PAYÉE (décaissement 401/512) — null sinon. */
  paymentEntryId: string | null;
  created: boolean;
}

export function recordedExpenseAccountingEntryId(expenseId: string): string {
  return `expense:${expenseId}:recorded`;
}
export function expensePaymentAccountingEntryId(expenseId: string): string {
  return `expense:${expenseId}:paid`;
}

/**
 * Poste les écritures définitives d'une dépense fournisseur (cycle achats) :
 * l'ACHAT au journal AC (6xx/44566/401), et — si la dépense est payée — le
 * DÉCAISSEMENT au journal BQ (401/512). Miroir du couple émission/encaissement côté
 * ventes. Idempotent : ids déterministes (expense:{id}:recorded / :paid) — un retry ou
 * un appel concurrent réutilise l'écriture existante au lieu de doubler le journal.
 */
export class RecordExpenseAccountingEntries {
  constructor(private readonly deps: RecordExpenseAccountingEntriesDeps) {}

  async execute(input: { expenseId: string }): Promise<Result<RecordExpenseAccountingEntriesOutput, AppError>> {
    const expense = await this.deps.expenses.findById(input.expenseId);
    if (!expense) return err(appNotFound('expense', input.expenseId));
    const companyId = expense.companyId;
    const chart = this.deps.charts ? await this.deps.charts.findByCompany(companyId) : null;

    const purchaseEntryId = recordedExpenseAccountingEntryId(expense.id);
    let created = false;
    const existingPurchase = await this.deps.entries.findById(companyId, purchaseEntryId);
    if (!existingPurchase) {
      const entry = buildRecordedExpenseAccountingEntry({
        entryId: purchaseEntryId,
        expense,
        ...(chart ? { chart } : {}),
      });
      if (!entry.ok) return err(appDomain(entry.error));
      await this.deps.entries.save(entry.value);
      created = true;
    }

    let paymentEntryId: string | null = null;
    if (expense.status === 'paid') {
      paymentEntryId = expensePaymentAccountingEntryId(expense.id);
      const existingPayment = await this.deps.entries.findById(companyId, paymentEntryId);
      if (!existingPayment) {
        const entry = buildExpensePaymentAccountingEntry({
          entryId: paymentEntryId,
          expense,
          ...(chart ? { chart } : {}),
        });
        if (!entry.ok) return err(appDomain(entry.error));
        await this.deps.entries.save(entry.value);
        created = true;
      }
    }

    return ok({ purchaseEntryId, paymentEntryId, created });
  }
}
