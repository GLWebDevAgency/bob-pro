import { type Result, err, ok } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import {
  Expense,
  isLegacyUnverifiedExpensePayment,
  normalizeExpensePaymentEvidence,
  sameExpensePaymentEvidence,
  type ExpensePaymentEvidenceInput,
} from '../../domain/expense/expense';
import { buildExpensePaymentAccountingEntry } from '../../domain/accounting/expense-accounting';
import { type AccountingEntry } from '../../domain/accounting/accounting-entry';
import { type ExpenseRepository } from '../ports/repositories';
import { type ClockPort } from '../ports/services';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';
import { type DocumentRepository } from '../ports/document-repository';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { expensePaymentAccountingEntryId } from '../accounting/record-expense-accounting-entries';

export interface RegularizeLegacyExpensePaymentInput extends ExpensePaymentEvidenceInput {
  companyId: string;
  expenseId: string;
}

export interface RegularizeLegacyExpensePaymentOutput {
  status: 'paid';
  alreadyRegularized: boolean;
  paymentEntryId: string;
}

export interface RegularizeLegacyExpensePaymentDeps {
  expenses: ExpenseRepository;
  entries: AccountingEntryRepository;
  clock: ClockPort;
  charts?: ChartOfAccountsRepository;
  /** Lecture minimale : le use case vérifie uniquement que le justificatif existe dans le tenant. */
  documents: Pick<DocumentRepository, 'findById'>;
}

function sameAccountingEntry(left: AccountingEntry, right: AccountingEntry): boolean {
  const a = left.toProps();
  const b = right.toProps();
  return a.id === b.id
    && a.companyId === b.companyId
    && a.journal === b.journal
    && a.sourceType === b.sourceType
    && a.sourceId === b.sourceId
    && a.entryDate === b.entryDate
    && a.reference === b.reference
    && a.label === b.label
    && a.lines.length === b.lines.length
    && a.lines.every((line, index) => {
      const other = b.lines[index];
      return other !== undefined
        && line.account === other.account
        && line.label === other.label
        && line.debitCents === other.debitCents
        && line.creditCents === other.creditCents;
    });
}

/**
 * Régularise une dépense HISTORIQUE « payée sans preuve » (posée par la migration de la lane
 * preuves : `paymentEvidenceLegacyUnverified`) : c'est la sortie de l'impasse promise par les
 * messages « une régularisation explicite est requise ».
 *
 * La commande valide la preuve exactement comme RecordExpensePayment (date au jour métier
 * Europe/Paris, moyen explicite, justificatif du tenant), POSE l'écriture de décaissement
 * 401/512-530 manquante (id déterministe `expense:{id}:paid`) et attache la preuve à la ligne —
 * ce qui bascule `paymentEvidenceLegacyUnverified` → false à la persistance. Une dépense encore
 * à payer ou déjà justifiée est refusée ; un retry strictement identique réussit sans double
 * écriture (idempotence stricte, même doctrine que RecordExpensePayment).
 */
export class RegularizeLegacyExpensePayment {
  constructor(private readonly deps: RegularizeLegacyExpensePaymentDeps) {}

  async execute(
    input: RegularizeLegacyExpensePaymentInput,
  ): Promise<Result<RegularizeLegacyExpensePaymentOutput, AppError>> {
    // Même borne calendrier MÉTIER que RecordExpensePayment : le jour Europe/Paris, jamais
    // l'UTC brut (fenêtre nocturne où « aujourd'hui » Paris serait rejeté « futur »).
    const businessToday = parisDateOnly(this.deps.clock.now());
    const normalized = normalizeExpensePaymentEvidence(input, { today: businessToday });
    if (!normalized.ok) return err(appDomain(normalized.error));

    const expense = this.deps.expenses.lockById
      ? await this.deps.expenses.lockById(input.expenseId)
      : await this.deps.expenses.findById(input.expenseId);
    if (!expense || expense.companyId !== input.companyId)
      return err(appNotFound('expense', input.expenseId));

    if (normalized.value.proofDocumentId !== null) {
      const proof = await this.deps.documents.findById(
        input.companyId,
        normalized.value.proofDocumentId,
      );
      if (!proof || proof.status !== 'active')
        return err(appNotFound('document', normalized.value.proofDocumentId));
    }

    if (expense.status !== 'paid')
      return err(appConflict(
        'expense_payment',
        'Cette dépense est encore à payer : enregistre son règlement (RecordExpensePayment), pas une régularisation.',
      ));
    const persistedEvidence = expense.paymentEvidence;
    if (persistedEvidence && !sameExpensePaymentEvidence(persistedEvidence, normalized.value))
      return err(appConflict(
        'expense_payment',
        'Cette dépense est déjà justifiée par une preuve différente : rien à régulariser.',
      ));

    // Construire et vérifier l'écriture AVANT de muter l'agrégat (même doctrine que
    // RecordExpensePayment) : aucun état partiel observable en cas de conflit.
    const projected = Expense.rehydrate({
      ...expense.toProps(),
      paymentEvidence: normalized.value,
    });
    const chart = this.deps.charts ? await this.deps.charts.findByCompany(input.companyId) : null;
    const paymentEntryId = expensePaymentAccountingEntryId(expense.id);
    const built = buildExpensePaymentAccountingEntry({
      entryId: paymentEntryId,
      expense: projected,
      ...(chart ? { chart } : {}),
    });
    if (!built.ok) return err(appDomain(built.error));

    const existingEntry = await this.deps.entries.findById(input.companyId, paymentEntryId);
    if (existingEntry && !sameAccountingEntry(existingEntry, built.value))
      return err(appConflict(
        'accounting_entry',
        'Une écriture de règlement différente existe déjà pour cette dépense.',
      ));

    const alreadyRegularized = !isLegacyUnverifiedExpensePayment(expense.toProps());
    if (!alreadyRegularized) {
      const transition = expense.regularizeLegacyPayment(normalized.value, { today: businessToday });
      if (!transition.ok) return err(appDomain(transition.error));
      await this.deps.expenses.save(expense);
    }
    if (!existingEntry) await this.deps.entries.save(built.value);

    return ok({ status: 'paid', alreadyRegularized, paymentEntryId });
  }
}
