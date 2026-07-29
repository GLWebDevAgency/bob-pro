import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { type DateOnly } from '../../shared-kernel/time';
import { Invoice, type ServicePeriod } from '../../domain/billing/invoice/invoice';
import { type InvoiceRepository } from '../ports/repositories';
import { type ClockPort } from '../ports/services';

/**
 * PR-12b / écrans §6.5 — la période de service d'une facture de CONTRAT est « éditable en
 * brouillon, figée à l'émission » : le geste que la garde d'émission promet (« modifie le
 * brouillon, jamais l'émission », issue-invoice) existe ici. Même patron transactionnel que
 * AttachPurchaseOrderToInvoice (tenant-scoped, révision optimiste, clone avant mutation) ;
 * la garde d'émission relit ensuite CES colonnes comme autorité (annexe erratum n° 2) et le
 * trigger SQL fige tout post-émission — aucune écriture parallèle possible.
 */

export interface UpdateInvoiceServicePeriodInput {
  companyId: string;
  invoiceId: string;
  expectedRevision: number;
  /** Bornes HUMAINES inclusives — début ET fin requis (couverture définissable). */
  servicePeriod: { start: DateOnly; end: DateOnly };
}

export interface UpdateInvoiceServicePeriodOutput {
  invoiceId: string;
  revision: number;
  servicePeriod: ServicePeriod | null;
}

export interface UpdateInvoiceServicePeriodDeps {
  invoices: Pick<InvoiceRepository, 'findById' | 'save'>;
  clock: ClockPort;
}

const INVOICE_STALE_MESSAGE =
  'La facture a été modifiée. Recharge avant de changer la période de service.';

export class UpdateInvoiceServicePeriod {
  constructor(private readonly deps: UpdateInvoiceServicePeriodDeps) {}

  async execute(
    input: UpdateInvoiceServicePeriodInput,
  ): Promise<Result<UpdateInvoiceServicePeriodOutput, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      return err({
        kind: 'validation',
        issues: [{ field: 'expectedRevision', message: 'Révision invalide.' }],
      });
    const invoice = await this.deps.invoices.findById(input.invoiceId);
    // Tenant-scoped : une facture d'une autre société est INVISIBLE (not_found, pas forbidden).
    if (!invoice || invoice.companyId !== input.companyId)
      return err(appNotFound('invoice', input.invoiceId));
    if (invoice.revision !== input.expectedRevision)
      return err(appConflict('invoice', INVOICE_STALE_MESSAGE));

    // Clone avant mutation : une tentative perdante ne mute jamais l'agrégat partagé in-memory.
    const next = Invoice.rehydrate(invoice.toSnapshot());
    const updated = next.updateContractServicePeriod(input.servicePeriod, this.deps.clock.now());
    if (!updated.ok) return err(appDomain(updated.error));
    if (next.revision !== invoice.revision) await this.deps.invoices.save(next);
    return ok({
      invoiceId: next.id,
      revision: next.revision,
      servicePeriod: next.servicePeriod,
    });
  }
}
