import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type LineInput } from '../../domain/billing/shared/line-item';
import { type Totals } from '../../domain/billing/shared/totals';
import { Quote } from '../../domain/billing/quote/quote';
import { suggestVatRate } from '../../domain/services/suggest-vat-rate';
import { type QuoteRepository, type CompanyRepository, type CustomerRepository } from '../ports/repositories';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';

export interface CreateQuoteInput {
  companyId: string;
  customerId: string;
  lines: LineInput[];
  depositPct?: number;
  validUntil?: string;
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
}

export interface CreateQuoteOutput {
  quoteId: string;
  totals: Totals;
}

export interface CreateQuoteDeps {
  quotes: QuoteRepository;
  companies: CompanyRepository;
  customers: CustomerRepository;
  ids: IdGeneratorPort;
  clock: ClockPort;
}

/** Compose un devis. La règle TVA (franchise/autoliquidation) est appliquée ICI via suggestVatRate. */
export class CreateQuote {
  constructor(private readonly deps: CreateQuoteDeps) {}

  async execute(input: CreateQuoteInput): Promise<Result<CreateQuoteOutput, AppError>> {
    const company = await this.deps.companies.findById(input.companyId);
    if (!company) return err(appNotFound('company', input.companyId));
    const customer = await this.deps.customers.findById(input.customerId);
    // Intégrité référentielle / anti-IDOR : le client doit appartenir au tenant (cf. CreateChantier).
    if (!customer || customer.companyId !== input.companyId) return err(appNotFound('customer', input.customerId));

    const composed = Quote.compose({
      id: this.deps.ids.newId(),
      companyId: input.companyId,
      customerId: input.customerId,
      at: this.deps.clock.now(),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
    });
    if (!composed.ok) return err(appDomain(composed.error));
    const quote = composed.value;

    for (const line of input.lines) {
      const rate = suggestVatRate({
        company,
        customer,
        category: line.category,
        requestedRate: line.vatRate,
        ...(input.context !== undefined ? { context: input.context } : {}),
      });
      if (!rate.ok) return err(appDomain(rate.error));
      const added = quote.addLine({ ...line, id: this.deps.ids.newId(), vatRate: rate.value });
      if (!added.ok) return err(appDomain(added.error));
    }

    if (input.depositPct !== undefined) {
      const dep = quote.setDeposit(input.depositPct);
      if (!dep.ok) return err(appDomain(dep.error));
    }

    await this.deps.quotes.save(quote);
    return ok({ quoteId: quote.id, totals: quote.totals() });
  }
}
