import {
  UpdateCustomer,
  appForbidden,
  appNotFound,
  err,
  type AppError,
  type Result,
  type UpdateCustomerInput,
} from '@bob/core';

import type { DocumentArchiveMutationBarrier } from '../documents/document-archive-integrity.authority';
import type { Persistence } from '../persistence/persistence';

export interface CustomerUpdateAuthorityPort {
  execute(input: UpdateCustomerInput): Promise<Result<{ id: string }, AppError>>;
  executeAtRevision(
    input: UpdateCustomerInput,
    expectedRevision: number,
  ): Promise<Result<{ id: string }, AppError>>;
}

/**
 * Unique autorité applicative d'édition d'une fiche client. Les transports manuel et Jarvis ne
 * choisissent que le mode de commit (historique ou CAS) ; tenant, verrou, clôture et archives
 * restent une seule transaction et un seul ordre.
 */
export class CustomerUpdateAuthority implements CustomerUpdateAuthorityPort {
  constructor(
    private readonly p: Persistence,
    private readonly archives: DocumentArchiveMutationBarrier,
  ) {}

  execute(input: UpdateCustomerInput): Promise<Result<{ id: string }, AppError>> {
    return this.run(input, null);
  }

  executeAtRevision(
    input: UpdateCustomerInput,
    expectedRevision: number,
  ): Promise<Result<{ id: string }, AppError>> {
    return this.run(input, expectedRevision);
  }

  private run(
    input: UpdateCustomerInput,
    expectedRevision: number | null,
  ): Promise<Result<{ id: string }, AppError>> {
    return this.p.runWithTenant(input.companyId, () =>
      this.p.runInTransaction(async () => {
        const company = await this.p.companies.lockById(input.companyId);
        if (company === null) return err(appNotFound('company', input.companyId));
        if (company.isClosed()) return err(appForbidden('Compte clôturé.'));

        const signedQuotes = await this.archives
          .assertSignedQuoteArchivesComplete(input.companyId);
        if (!signedQuotes.ok) return signedQuotes;

        const issuedInvoices = await this.archives
          .assertIssuedInvoiceArchivesComplete(input.companyId);
        if (!issuedInvoices.ok) return issuedInvoices;

        const update = new UpdateCustomer({
          customers: this.p.customers,
          quotes: this.p.quotes,
          invoices: this.p.invoices,
        });
        return expectedRevision === null
          ? update.execute(input)
          : update.executeAtRevision(input, expectedRevision);
      }),
    );
  }
}
