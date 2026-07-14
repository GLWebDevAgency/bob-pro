import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { type InvoiceRepository } from '../ports/repositories';
import { type IdGeneratorPort } from '../ports/services';

export interface CreateCreditNoteDeps {
  invoices: InvoiceRepository;
  ids: IdGeneratorPort;
}

/**
 * Crée l'AVOIR TOTAL (brouillon) d'une facture émise (A6) — même use case pour l'UI et
 * pour Bob (parité d'actions). L'avoir s'émet ensuite par le circuit normal (IssueInvoice :
 * numéro A- sans trou, écriture comptable inverse). Anti-doublon : l'idempotence porte sur
 * l'identité de la facture source, jamais sur le devis parent qui peut avoir plusieurs pièces.
 */
export class CreateCreditNote {
  constructor(private readonly deps: CreateCreditNoteDeps) {}

  async execute(input: { invoiceId: string }): Promise<Result<{ creditNoteId: string }, AppError>> {
    const source = await this.deps.invoices.findById(input.invoiceId);
    if (!source) return err(appNotFound('invoice', input.invoiceId));

    const existing = await this.deps.invoices.findCreditNoteBySourceInvoiceId(source.companyId, source.id);
    if (existing) return ok({ creditNoteId: existing.id });

    const created = Invoice.creditNoteFor(source, this.deps.ids.newId());
    if (!created.ok) return err(appDomain(created.error));

    // Le repository persistant publie l'avoir avec un upsert sur (tenant, sourceInvoiceId).
    // On relit ensuite l'identité gagnante : deux requêtes concurrentes convergent sans devoir
    // rattraper une unique violation dans une transaction PostgreSQL déjà avortée.
    await this.deps.invoices.save(created.value);
    const persisted = await this.deps.invoices.findCreditNoteBySourceInvoiceId(source.companyId, source.id);
    if (!persisted) throw new Error('Credit note persistence invariant violated.');
    return ok({ creditNoteId: persisted.id });
  }
}
