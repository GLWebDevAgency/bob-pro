import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { type ExpenseRepository } from '../ports/repositories';
import { Expense, type ExpenseCategory, type ExpenseSource } from '../../domain/expense/expense';

export interface RecordExpenseInput {
  companyId: string;
  /**
   * Clé opaque possédée par l'appelant pour rejouer une création sans doublon.
   * Le domaine ne la persiste pas : les adaptateurs serveur/local n'en conservent qu'une empreinte.
   */
  idempotencyKey?: string | null;
  supplierName: string;
  supplierSiren?: string | null;
  documentDate: string;
  totalTtcCents: number;
  totalHtCents?: number | null;
  vatCents?: number | null;
  vatRatePct?: number | null;
  category: ExpenseCategory;
  source?: ExpenseSource;
  /** N° de facture fournisseur (Factur-X BT-1, C-EXP6b) — optionnel, additif. */
  supplierInvoiceNumber?: string | null;
  /** Échéance fournisseur (Factur-X BT-9, C-EXP6b) — optionnelle, additive. */
  dueAt?: string | null;
}

/**
 * Intention métier canonique utilisée pour comparer deux retries. Les valeurs optionnelles sont
 * ramenées aux mêmes défauts que `Expense.record`, afin qu'une différence de forme JSON ne crée
 * pas un faux conflit et qu'une vraie différence comptable reste détectable.
 */
export function canonicalRecordExpensePayload(input: Omit<RecordExpenseInput, 'companyId'>) {
  return {
    supplierName: input.supplierName.trim(),
    supplierSiren: input.supplierSiren?.replace(/\s/g, '') || null,
    documentDate: input.documentDate,
    totalTtcCents: input.totalTtcCents,
    totalHtCents: input.totalHtCents ?? null,
    vatCents: input.vatCents ?? null,
    vatRatePct: input.vatRatePct ?? null,
    category: input.category,
    source: input.source ?? 'manual',
    supplierInvoiceNumber: input.supplierInvoiceNumber?.trim() || null,
    dueAt: input.dueAt ?? null,
  } as const;
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
      supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
      dueAt: input.dueAt ?? null,
    }, { today: this.deps.clock.today() });
    if (!r.ok) return err(appDomain(r.error));
    await this.deps.expenses.save(r.value);
    return ok({ id });
  }
}
