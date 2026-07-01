import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type Signature } from '../../domain/billing/shared/signature';
import { type QuoteRepository } from '../ports/repositories';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { TxDomainError } from './tx-error';

export interface SignQuoteDeps {
  quotes: QuoteRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

function normalizeSignerName(value: unknown): Result<string, AppError> {
  if (typeof value !== 'string') {
    return err(appDomain({ code: 'VALIDATION', field: 'signerName', message: 'Nom du signataire requis.' }));
  }
  if (hasForbiddenFormatCharacter(value)) {
    return err(appDomain({ code: 'VALIDATION', field: 'signerName', message: 'Nom du signataire invalide.' }));
  }
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 120) {
    return err(appDomain({ code: 'VALIDATION', field: 'signerName', message: 'Nom du signataire invalide.' }));
  }
  const normalized = trimmed.replace(/\s+/g, ' ');
  return ok(normalized);
}

function hasForbiddenFormatCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
    if (code >= 0x80 && code <= 0x9f) return true;
    if (code >= 0x200b && code <= 0x200d) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (code === 0xfeff) return true;
  }
  return false;
}

/** Signature « sur place » : enregistre la signature dessinée et passe le devis en signed. */
export class SignQuote {
  constructor(private readonly deps: SignQuoteDeps) {}

  async execute(input: { quoteId: string; signerName: string }): Promise<Result<{ status: string }, AppError>> {
    const signerName = normalizeSignerName(input.signerName);
    if (!signerName.ok) return signerName;

    const pre = await this.deps.quotes.findById(input.quoteId);
    if (!pre) return err(appNotFound('quote', input.quoteId));

    try {
      const status = await this.deps.uow.runInTransaction(async () => {
        const quote = await this.deps.quotes.lockById(input.quoteId);
        if (!quote) throw new TxDomainError({ code: 'VALIDATION', field: 'quote', message: 'Devis introuvable.' });

        const signature: Signature = {
          signerName: signerName.value,
          signedAt: this.deps.clock.now(),
          method: 'draw',
          accepted: true,
        };
        const signed = quote.sign(signature, this.deps.clock.now());
        if (!signed.ok) throw new TxDomainError(signed.error);

        await this.deps.quotes.save(quote);
        return quote.status;
      });
      return ok({ status });
    } catch (e) {
      if (e instanceof TxDomainError) return err(appDomain(e.domainError));
      throw e;
    }
  }
}
