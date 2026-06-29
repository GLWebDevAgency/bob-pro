import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { buildMentions } from '../../domain/services/build-mentions';
import { type InvoiceRepository, type CompanyRepository, type CustomerRepository } from '../ports/repositories';
import { type SequenceCounterPort, type ClockPort } from '../ports/services';

export interface IssueInvoiceInput {
  invoiceId: string;
  terms?: { days: number; endOfMonth: boolean; label: string };
}

export interface IssueInvoiceDeps {
  invoices: InvoiceRepository;
  companies: CompanyRepository;
  customers: CustomerRepository;
  counters: SequenceCounterPort;
  clock: ClockPort;
}

/** Alloue le numéro de facture (no-gap), fige totaux + mentions, passe en issued. */
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
    const alloc = await this.deps.counters.allocate({ companyId: invoice.companyId, counterKey: 'invoice', fiscalYear });
    const assigned = invoice.assignNumber(alloc.formatted, this.deps.clock.now());
    if (!assigned.ok) return err(appDomain(assigned.error));

    const mentions = buildMentions({ company, customer, kind: 'invoice', asOf: this.deps.clock.today() });
    const issued = invoice.issue({
      mentions,
      terms: termsR.value,
      issuedAt: this.deps.clock.today(),
      at: this.deps.clock.now(),
    });
    if (!issued.ok) return err(appDomain(issued.error));

    await this.deps.invoices.save(invoice);
    const number = invoice.number;
    if (!number) return err(appDomain({ code: 'VALIDATION', field: 'number', message: 'Numero manquant.' }));
    return ok({ number });
  }
}
