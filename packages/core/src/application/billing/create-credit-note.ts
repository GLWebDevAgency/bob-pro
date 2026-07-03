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
 * numéro A- sans trou, écriture comptable inverse). Anti-doublon : un avoir déjà présent
 * sur le même devis parent est retourné tel quel (idempotence de geste).
 */
export class CreateCreditNote {
  constructor(private readonly deps: CreateCreditNoteDeps) {}

  async execute(input: { invoiceId: string }): Promise<Result<{ creditNoteId: string }, AppError>> {
    const source = await this.deps.invoices.findById(input.invoiceId);
    if (!source) return err(appNotFound('invoice', input.invoiceId));

    if (source.parentQuoteId) {
      const existing = await this.deps.invoices.findByParentQuoteId(source.companyId, source.parentQuoteId, 'credit_note');
      if (existing) return ok({ creditNoteId: existing.id });
    }

    const created = Invoice.creditNoteFor(source, this.deps.ids.newId());
    if (!created.ok) return err(appDomain(created.error));

    try {
      await this.deps.invoices.save(created.value);
    } catch (e) {
      if (source.parentQuoteId) {
        const raced = await this.deps.invoices.findByParentQuoteId(source.companyId, source.parentQuoteId, 'credit_note');
        if (raced) return ok({ creditNoteId: raced.id });
      }
      throw e;
    }
    return ok({ creditNoteId: created.value.id });
  }
}
