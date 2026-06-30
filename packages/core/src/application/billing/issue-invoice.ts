import { type Result, ok, err, type DomainError } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { buildMentions, operationNatureOf } from '../../domain/services/build-mentions';
import { type InvoiceRepository, type CompanyRepository, type CustomerRepository } from '../ports/repositories';
import { type SequenceCounterPort, type ClockPort, type UnitOfWorkPort } from '../ports/services';

export interface IssueInvoiceInput {
  invoiceId: string;
  terms?: { days: number; endOfMonth: boolean; label: string };
}

export interface IssueInvoiceDeps {
  invoices: InvoiceRepository;
  companies: CompanyRepository;
  customers: CustomerRepository;
  counters: SequenceCounterPort;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

/** Sentinelle : lever dans la transaction pour déclencher le rollback sur erreur métier (no-gap). */
class TxDomainError extends Error {
  constructor(readonly domainError: DomainError) {
    super('tx-domain');
  }
}

/**
 * Alloue le numéro de facture (no-gap) ET fige totaux + mentions + save, dans UNE transaction.
 * Si quoi que ce soit échoue, la transaction est annulée -> le numéro n'est PAS consommé -> aucun trou fiscal.
 */
export class IssueInvoice {
  constructor(private readonly deps: IssueInvoiceDeps) {}

  async execute(input: IssueInvoiceInput): Promise<Result<{ number: string }, AppError>> {
    const invoice = await this.deps.invoices.findById(input.invoiceId);
    if (!invoice) return err(appNotFound('invoice', input.invoiceId));
    const company = await this.deps.companies.findById(invoice.companyId);
    if (!company) return err(appNotFound('company', invoice.companyId));
    const customer = await this.deps.customers.findById(invoice.customerId);
    if (!customer) return err(appNotFound('customer', invoice.customerId));

    const termsR = PaymentTerms.of(input.terms ?? { days: 30, endOfMonth: false, label: 'Paiement a 30 jours' });
    if (!termsR.ok) return err(appDomain(termsR.error));
    const fiscalYear = Number(this.deps.clock.today().slice(0, 4));

    try {
      const number = await this.deps.uow.runInTransaction(async () => {
        const alloc = await this.deps.counters.allocate({ companyId: invoice.companyId, counterKey: 'invoice', fiscalYear });
        const assigned = invoice.assignNumber(alloc.formatted, this.deps.clock.now());
        if (!assigned.ok) throw new TxDomainError(assigned.error);
        const mentions = buildMentions({
          company,
          customer,
          kind: 'invoice',
          asOf: this.deps.clock.today(),
          operationNature: operationNatureOf(invoice.lines),
        });
        const issued = invoice.issue({ mentions, terms: termsR.value, issuedAt: this.deps.clock.today(), at: this.deps.clock.now() });
        if (!issued.ok) throw new TxDomainError(issued.error);
        await this.deps.invoices.save(invoice);
        const n = invoice.number;
        if (!n) throw new TxDomainError({ code: 'VALIDATION', field: 'number', message: 'Numero manquant.' });
        return n;
      });
      return ok({ number });
    } catch (e) {
      if (e instanceof TxDomainError) return err(appDomain(e.domainError));
      throw e; // erreur d'infrastructure : la transaction a été annulée (pas de trou) -> on propage
    }
  }
}
