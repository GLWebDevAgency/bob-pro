import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appConflict, appNotFound } from '../result';
import { type InvoiceRepository } from '../ports/repositories';
import { type UnitOfWorkPort } from '../ports/services';

export interface DeleteDraftInvoiceInput {
  invoiceId: string;
}

/**
 * PR-16 (Bloc C §3.5) — port ÉTROIT de détachement des passages liés : la suppression d'un
 * brouillon créé par « Facturer ce passage » remet `billedInvoiceId` à null sur la ou les
 * fiches qui le référencent — la priorité `intervention_a_facturer` se rallume par l'état
 * réel. Optionnel : les hôtes sans interventions restent inchangés.
 */
export interface InterventionBillingDetachPort {
  detachByInvoice(companyId: string, invoiceId: string): Promise<void>;
}

export interface DeleteDraftInvoiceDeps {
  invoices: InvoiceRepository;
  uow: UnitOfWorkPort;
  /** PR-16 — audit consommateur : détache les fiches de passage liées au brouillon supprimé. */
  interventionBillingLinks?: InterventionBillingDetachPort;
}

/** Sentinelle : lever DANS runInTransaction pour annuler proprement (rollback) sur erreur applicative. */
class TxAppError extends Error {
  constructor(readonly appError: AppError) {
    super('tx-app-error');
  }
}

/**
 * R6 : supprime définitivement une facture BROUILLON (cas d'usage : erreur détectée après
 * génération depuis un devis). Garde STRICTE : status === 'draft' uniquement — une facture
 * émise est irréversible (avoir dédié). Relecture SOUS VERROU (lockById) pour éviter de
 * supprimer une facture qui vient d'être émise par une opération concurrente.
 */
export class DeleteDraftInvoice {
  constructor(private readonly deps: DeleteDraftInvoiceDeps) {}

  async execute(input: DeleteDraftInvoiceInput): Promise<Result<{ deleted: true }, AppError>> {
    const pre = await this.deps.invoices.findById(input.invoiceId);
    if (!pre) return err(appNotFound('invoice', input.invoiceId));

    try {
      await this.deps.uow.runInTransaction(async () => {
        const invoice = await this.deps.invoices.lockById(input.invoiceId);
        if (!invoice) throw new TxAppError(appNotFound('invoice', input.invoiceId));
        if (invoice.status !== 'draft')
          throw new TxAppError(appConflict('invoice', 'Seule une facture brouillon peut être supprimée.'));
        await this.deps.invoices.deleteById(invoice.id);
        // PR-16 — même transaction : la fiche de passage liée est détachée, jamais orpheline.
        if (this.deps.interventionBillingLinks) {
          await this.deps.interventionBillingLinks.detachByInvoice(invoice.companyId, invoice.id);
        }
      });
    } catch (e) {
      if (e instanceof TxAppError) return err(e.appError);
      throw e;
    }
    return ok({ deleted: true });
  }
}
