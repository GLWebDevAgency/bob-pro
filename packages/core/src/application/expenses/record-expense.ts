import { type Result, ok, err } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain } from '../result';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { type ExpenseRepository } from '../ports/repositories';
import { Expense, type ExpenseCategory, type ExpenseSource } from '../../domain/expense/expense';
import { type PaymentMethod } from '../../domain/payment/payment';

/**
 * Règlement DÉJÀ effectué au moment de la création (ticket de caisse scanné, par exemple) :
 * la dépense naît PAYÉE avec sa preuve (chaîne paymentEvidence) au lieu d'un « à payer »
 * absurde qu'il faudrait re-payer. Sans cette déclaration, la dépense reste à payer.
 */
export interface RecordExpensePaymentDeclaration {
  paidOn: string;
  method: PaymentMethod;
  reference?: string | null;
  /** Pièce du coffre qui justifie le règlement — le scan lui-même pour un ticket. */
  proofDocumentId?: string | null;
}

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
  /** Présent → la dépense est créée PAYÉE avec cette preuve ; absent/null → « à payer ». */
  payment?: RecordExpensePaymentDeclaration | null;
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
    // Additif : la clé n'apparaît que si un règlement est déclaré, afin que l'empreinte
    // d'une création « à payer » reste identique à celle des versions antérieures
    // (un retry qui traverse un déploiement ne doit jamais devenir un faux conflit).
    ...(input.payment
      ? {
          payment: {
            paidOn: input.payment.paidOn,
            method: input.payment.method,
            reference: input.payment.reference?.trim() || null,
            proofDocumentId: input.payment.proofDocumentId?.trim() || null,
          },
        }
      : {}),
  };
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
    // Ticket déjà réglé (scan) : la dépense naît payée avec sa preuve — le domaine revalide
    // date/moyen/justificatif comme pour tout règlement (jamais de « payée sans preuve »).
    const payment = input.payment ?? null;
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
      status: payment ? 'paid' : 'to_pay',
      paymentEvidence: payment
        ? {
            paidOn: payment.paidOn,
            method: payment.method,
            reference: payment.reference ?? null,
            proofDocumentId: payment.proofDocumentId ?? null,
          }
        : null,
      source: input.source ?? 'manual',
      supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
      dueAt: input.dueAt ?? null,
      // Borne « documentDate dans le futur » : jour MÉTIER Europe/Paris, pas l'UTC brut — une
      // pièce datée d'aujourd'hui (Paris) saisie entre minuit et ~2 h serait sinon rejetée
      // (même correction que RecordExpensePayment / GetCashflow « Audit correction 3 »).
    }, { today: parisDateOnly(this.deps.clock.now()) });
    if (!r.ok) return err(appDomain(r.error));
    await this.deps.expenses.save(r.value);
    return ok({ id });
  }
}
