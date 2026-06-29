import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type QuoteRepository } from '../ports/repositories';
import { type SequenceCounterPort, type ClockPort } from '../ports/services';

export interface SendQuoteDeps {
  quotes: QuoteRepository;
  counters: SequenceCounterPort;
  clock: ClockPort;
}

/** Alloue le numéro de devis (no-gap) puis passe draft -> sent. */
export class SendQuote {
  constructor(private readonly deps: SendQuoteDeps) {}

  async execute(input: { quoteId: string }): Promise<Result<{ number: string }, AppError>> {
    const quote = await this.deps.quotes.findById(input.quoteId);
    if (!quote) return err(appNotFound('quote', input.quoteId));

    const fiscalYear = Number(this.deps.clock.today().slice(0, 4));
    const alloc = await this.deps.counters.allocate({ companyId: quote.companyId, counterKey: 'quote', fiscalYear });
    const assigned = quote.assignNumber(alloc.formatted, this.deps.clock.now());
    if (!assigned.ok) return err(appDomain(assigned.error));
    const sent = quote.send(this.deps.clock.now());
    if (!sent.ok) return err(appDomain(sent.error));

    await this.deps.quotes.save(quote);
    const number = quote.number;
    if (!number) return err(appDomain({ code: 'VALIDATION', field: 'number', message: 'Numero manquant.' }));
    return ok({ number });
  }
}
