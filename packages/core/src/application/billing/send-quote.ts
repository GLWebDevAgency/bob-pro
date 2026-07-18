import { type Result, ok, err } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import { type CompanyRepository, type QuoteRepository } from '../ports/repositories';
import { type SequenceCounterPort, type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { TxDomainError } from './tx-error';

export interface SendQuoteDeps {
  companies: CompanyRepository;
  quotes: QuoteRepository;
  counters: SequenceCounterPort;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

/**
 * Alloue le numéro de devis (no-gap) puis passe draft -> sent dans une transaction, sous verrou de ligne.
 * Un retry concurrent relit le devis déjà numéroté avant d'allouer : aucun numéro orphelin.
 */
export class SendQuote {
  constructor(private readonly deps: SendQuoteDeps) {}

  async execute(input: { quoteId: string }): Promise<Result<{ number: string }, AppError>> {
    // Exercice de numérotation = calendrier MÉTIER Europe/Paris (même correction que
    // IssueInvoice) : un devis envoyé juste après minuit au passage de l'an ne doit pas être
    // numéroté sur l'exercice précédent parce que l'UTC retarde d'1-2 h sur Paris.
    const fiscalYear = Number(parisDateOnly(this.deps.clock.now()).slice(0, 4));

    const pre = await this.deps.quotes.findById(input.quoteId);
    if (!pre) return err(appNotFound('quote', input.quoteId));

    try {
      const number = await this.deps.uow.runInTransaction(async () => {
        // Ordre global anti-deadlock : company (SHARE) -> quote (UPDATE) -> compteur/token.
        // Le devis lu avant l'UoW sert uniquement à localiser le tenant ; son état métier est
        // intégralement rechargé sous verrou après la barrière de cycle de vie de la société.
        const company = await this.deps.companies.lockForShareById(pre.companyId);
        if (!company || company.isClosed()) {
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'company',
            message: 'Société introuvable ou clôturée.',
          });
        }
        const quote = await this.deps.quotes.lockById(input.quoteId);
        if (!quote || quote.companyId !== company.id) {
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'quote',
            message: 'Devis introuvable.',
          });
        }

        const existing = quote.number;
        if (existing) {
          if (quote.status === 'draft') {
            const sent = quote.send(this.deps.clock.now());
            if (!sent.ok) throw new TxDomainError(sent.error);
            await this.deps.quotes.save(quote);
          }
          if (quote.status === 'sent' || quote.status === 'viewed' || quote.status === 'signed')
            return existing;
          throw new TxDomainError({ code: 'INVALID_TRANSITION', from: quote.status, to: 'sent' });
        }

        const alloc = await this.deps.counters.allocate({
          companyId: quote.companyId,
          counterKey: 'quote',
          fiscalYear,
        });
        const assigned = quote.assignNumber(alloc.formatted, this.deps.clock.now());
        if (!assigned.ok) throw new TxDomainError(assigned.error);
        const sent = quote.send(this.deps.clock.now());
        if (!sent.ok) throw new TxDomainError(sent.error);
        await this.deps.quotes.save(quote);
        const n = quote.number;
        if (!n)
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'number',
            message: 'Numero manquant.',
          });
        return n;
      });
      return ok({ number });
    } catch (e) {
      if (e instanceof TxDomainError) return err(appDomain(e.domainError));
      throw e;
    }
  }
}
