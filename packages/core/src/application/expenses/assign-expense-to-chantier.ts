import { type Result, err, ok } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type ExpenseRepository } from '../ports/repositories';
import { type DocumentLinkTargetPort } from '../ports/document-link-target';

export interface AssignExpenseToChantierInput {
  companyId: string;
  expenseId: string;
  /** Id d'un chantier du tenant — ou null EXPLICITE pour délier la dépense (geste légitime). */
  chantierId: string | null;
}

export interface AssignExpenseToChantierOutput {
  /** Imputation effective après la commande (null = dépense hors chantier). */
  chantierId: string | null;
  /** false = la commande n'a rien changé (retry / imputation déjà en place) — aucune écriture. */
  changed: boolean;
}

export interface AssignExpenseToChantierDeps {
  expenses: ExpenseRepository;
  /**
   * Preuve d'existence tenant-scoped du chantier cible — même port anti-IDOR que le coffre
   * (ClassifyDocument) : l'adaptateur répond false pour « absent » COMME pour « autre tenant »,
   * sans jamais distinguer les deux (pas d'oracle).
   */
  chantierTargets: DocumentLinkTargetPort;
}

/**
 * Impute une dépense à un chantier (rentabilité par chantier) — ou la délie (chantierId null).
 *
 * Même use case pour l'écran Dépenses et pour Bob (parité d'actions). Tenant scoping strict :
 * une dépense d'un autre tenant est un `not_found` indistinguable d'une dépense inexistante ;
 * le chantier cible est PROUVÉ dans le tenant via le port avant toute mutation. Idempotent :
 * ré-imputer le même chantier (ou délier une dépense déjà hors chantier) réussit sans écriture.
 * L'agrégat Expense n'a pas de révision optimiste : comme les autres mutations de dépense
 * (RecordExpensePayment…), la commande s'appuie sur le verrou pessimiste `lockById` quand
 * l'adaptateur le fournit.
 */
export class AssignExpenseToChantier {
  constructor(private readonly deps: AssignExpenseToChantierDeps) {}

  async execute(
    input: AssignExpenseToChantierInput,
  ): Promise<Result<AssignExpenseToChantierOutput, AppError>> {
    const expense = this.deps.expenses.lockById
      ? await this.deps.expenses.lockById(input.expenseId)
      : await this.deps.expenses.findById(input.expenseId);
    if (!expense || expense.companyId !== input.companyId)
      return err(appNotFound('expense', input.expenseId));

    // Anti-IDOR : le chantier visé doit exister DANS le tenant avant de muter quoi que ce soit.
    // (Le retrait — null — ne vise aucune cible : rien à prouver ; un id BLANC file au domaine,
    // qui le refuse en VALIDATION sans consommer le port.)
    const targetChantierId = input.chantierId === null ? null : input.chantierId.trim();
    if (targetChantierId) {
      const exists = await this.deps.chantierTargets.exists({
        companyId: input.companyId,
        linkedEntityType: 'chantier',
        linkedEntityId: targetChantierId,
      });
      if (!exists) return err(appNotFound('chantier', targetChantierId));
    }

    const assigned = expense.assignToChantier(input.chantierId);
    if (!assigned.ok) return err(appDomain(assigned.error));
    if (assigned.value.changed) await this.deps.expenses.save(expense);

    return ok({ chantierId: expense.chantierId, changed: assigned.value.changed });
  }
}
