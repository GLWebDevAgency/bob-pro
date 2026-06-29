import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type Signature } from '../../domain/billing/shared/signature';
import { type QuoteRepository } from '../ports/repositories';
import { type ClockPort } from '../ports/services';

export interface SignQuoteDeps {
  quotes: QuoteRepository;
  clock: ClockPort;
}

/** Signature « sur place » : enregistre la signature dessinée et passe le devis en signed. */
export class SignQuote {
  constructor(private readonly deps: SignQuoteDeps) {}

  async execute(input: { quoteId: string; signerName: string }): Promise<Result<{ status: string }, AppError>> {
    const quote = await this.deps.quotes.findById(input.quoteId);
    if (!quote) return err(appNotFound('quote', input.quoteId));

    const signature: Signature = {
      signerName: input.signerName,
      signedAt: this.deps.clock.now(),
      method: 'draw',
      accepted: true,
    };
    const signed = quote.sign(signature, this.deps.clock.now());
    if (!signed.ok) return err(appDomain(signed.error));

    await this.deps.quotes.save(quote);
    return ok({ status: quote.status });
  }
}
