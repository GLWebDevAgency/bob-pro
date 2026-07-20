import { type Result, err, ok } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import {
  Expense,
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

export interface RecordExpensePaymentInput extends ExpensePaymentEvidenceInput {
  companyId: string;
  expenseId: string;
}

export interface RecordExpensePaymentOutput {
  status: 'paid';
  alreadyRecorded: boolean;
  paymentEntryId: string;
}

export interface RecordExpensePaymentDeps {
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
 * Enregistre un règlement fournisseur DEJA réalisé hors de Bob.
 *
 * La commande exige date + moyen explicites et doit être appelée dans l'unité de travail du
 * tenant : dépense et écriture comptable sont alors persistées atomiquement. Son idempotence est
 * stricte : un retry identique réussit, tandis qu'un retry qui change la preuve ou rencontre une
 * écriture différente échoue en conflit au lieu de réécrire l'historique.
 */
export class RecordExpensePayment {
  constructor(private readonly deps: RecordExpensePaymentDeps) {}

  async execute(
    input: RecordExpensePaymentInput,
  ): Promise<Result<RecordExpensePaymentOutput, AppError>> {
    // Borne calendrier MÉTIER (même décision que GetCashflow, « Audit correction 3 ») :
    // `clock.today()` (SystemClock, UTC brut) retarde d'1-2 h sur le jour Europe/Paris juste
    // après minuit local — la sheet mobile pré-remplit « Aujourd'hui » en jour Paris
    // (parisDateOnly), et un règlement daté du jour Paris serait rejeté « futur » pendant
    // cette fenêtre, poussant l'utilisateur à antidater. Le jour métier est le jour Paris.
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

    const persistedEvidence = expense.paymentEvidence;
    if (expense.status === 'paid') {
      // Entité DÉDIÉE : les appelants (outil vocal, UI) distinguent ce cas et orientent vers la
      // régularisation explicite (RegularizeLegacyExpensePayment) au lieu d'une erreur sèche.
      if (!persistedEvidence)
        return err(appConflict(
          'expense_payment_legacy',
          'Cette dépense date d’avant le suivi des preuves de paiement : elle est marquée payée sans preuve. Régularise-la explicitement depuis l’écran Dépenses (« Payée — à justifier »).',
        ));
      if (!sameExpensePaymentEvidence(persistedEvidence, normalized.value))
        return err(appConflict(
          'expense_payment',
          'Ce règlement existe déjà avec une date, un moyen ou une référence différente.',
        ));
    } else if (persistedEvidence) {
      return err(appConflict(
        'expense_payment',
        'Une preuve de règlement existe alors que la dépense est encore à payer.',
      ));
    }

    // Construire et vérifier l'écriture AVANT de muter l'agrégat évite qu'un adaptateur mémoire
    // conservant la même référence observe un statut partiellement modifié en cas de conflit.
    const projected = Expense.rehydrate({
      ...expense.toProps(),
      status: 'paid',
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

    const alreadyRecorded = expense.status === 'paid';
    if (!alreadyRecorded) {
      const transition = expense.recordPayment(normalized.value, { today: businessToday });
      if (!transition.ok) return err(appDomain(transition.error));
      await this.deps.expenses.save(expense);
    }
    if (!existingEntry) await this.deps.entries.save(built.value);

    return ok({ status: 'paid', alreadyRecorded, paymentEntryId });
  }
}
