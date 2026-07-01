import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { buildMentions, operationNatureOf } from '../../domain/services/build-mentions';
import { type InvoiceRepository, type CompanyRepository, type CustomerRepository } from '../ports/repositories';
import { type SequenceCounterPort, type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { TxDomainError } from './tx-error';

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

/**
 * Alloue le numéro de facture (no-gap) ET fige totaux + mentions + save, dans UNE transaction, sous
 * VERROU de ligne (lockById). Concurrence : la 2ᵉ émission de la même facture bloque sur le verrou,
 * relit une facture déjà numérotée et retourne son numéro AVANT d'allouer -> aucun numéro orphelin (pas de trou).
 * Toute erreur (métier via TxDomainError, ou infra) annule la transaction -> numéro non consommé.
 */
export class IssueInvoice {
  constructor(private readonly deps: IssueInvoiceDeps) {}

  async execute(input: IssueInvoiceInput): Promise<Result<{ number: string }, AppError>> {
    const pre = await this.deps.invoices.findById(input.invoiceId);
    if (!pre) return err(appNotFound('invoice', input.invoiceId));
    if (pre.number) return ok({ number: pre.number });

    const company = await this.deps.companies.findById(pre.companyId);
    if (!company) return err(appNotFound('company', pre.companyId));
    const customer = await this.deps.customers.findById(pre.customerId);
    if (!customer) return err(appNotFound('customer', pre.customerId));

    const termsR = PaymentTerms.of(input.terms ?? { days: 30, endOfMonth: false, label: 'Paiement a 30 jours' });
    if (!termsR.ok) return err(appDomain(termsR.error));
    const fiscalYear = Number(this.deps.clock.today().slice(0, 4));

    try {
      const number = await this.deps.uow.runInTransaction(async () => {
        const invoice = await this.deps.invoices.lockById(input.invoiceId);
        if (!invoice) throw new TxDomainError({ code: 'VALIDATION', field: 'invoice', message: 'Facture introuvable.' });
        // Déjà numérotée (retry réseau ou course gagnée par une autre émission) -> réponse idempotente.
        if (invoice.number) return invoice.number;

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
