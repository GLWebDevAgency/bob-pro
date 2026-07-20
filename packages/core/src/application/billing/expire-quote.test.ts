import { describe, expect, it } from 'vitest';
import { ExpireQuote } from './expire-quote';
import { Quote } from '../../domain/billing/quote/quote';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { type QuoteRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';

const AT = '2026-06-02T10:00:00.000Z';
const clock = { now: () => AT, today: () => '2026-06-02' };

function sentQuote(validUntil: string | null): Quote {
  const input = { id: 'quote-1', companyId: 'co-1', customerId: 'cust-1', at: AT };
  const q = Quote.compose(validUntil === null ? input : { ...input, validUntil });
  if (!q.ok) throw new Error('compose');
  q.value.addLine({ id: 'line-1', label: 'Prestation', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 });
  q.value.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.value.send(AT);
  return q.value;
}

function makeDeps(quote: Quote | null, lockedQuote: Quote | null = quote) {
  let saves = 0;
  let transactions = 0;
  const revocations: Parameters<PublicAccessTokenRepository['revokeActiveFor']>[0][] = [];
  const uow = {
    runInTransaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      transactions++;
      return fn();
    },
  };
  const quotes: QuoteRepository = {
    findById: async () => quote,
    lockById: async () => lockedQuote,
    listByCompany: async () => [],
    save: async () => {
      saves++;
    },
  };
  const publicAccessTokens: PublicAccessTokenRepository = {
    create: async () => ({ id: 'grant-1', token: 'token-1' }),
    findActive: async () => null,
    markUsed: async () => undefined,
    revoke: async () => undefined,
    revokeActiveFor: async (input) => {
      revocations.push(input);
    },
    revokeAllForCompany: async () => undefined,
  };
  return { deps: { quotes, publicAccessTokens, uow, clock }, counts: () => ({ saves, transactions, revocations }) };
}

describe('ExpireQuote', () => {
  it('expire un devis dont la date de validité est dépassée et révoque ses liens publics', async () => {
    const quote = sentQuote('2026-06-01');
    const { deps, counts } = makeDeps(quote);
    const r = await new ExpireQuote(deps).execute({ quoteId: quote.id });

    expect(r).toEqual({ ok: true, value: { status: 'expired' } });
    expect(counts()).toEqual({
      saves: 1,
      transactions: 1,
      revocations: [
        {
          companyId: 'co-1',
          resourceType: 'quote',
          resourceId: 'quote-1',
          scope: 'quote_signature',
          at: AT,
        },
      ],
    });
  });

  it('rejette un devis encore valide sans mutation ni révocation', async () => {
    const quote = sentQuote('2026-06-02');
    const { deps, counts } = makeDeps(quote);
    const r = await new ExpireQuote(deps).execute({ quoteId: quote.id });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(quote.status).toBe('sent');
    expect(counts()).toEqual({ saves: 0, transactions: 0, revocations: [] });
  });

  it('reste idempotent sur un devis déjà expiré et révoque les liens actifs restants', async () => {
    const quote = sentQuote('2026-06-01');
    quote.markExpired(AT);
    const { deps, counts } = makeDeps(quote);
    const r = await new ExpireQuote(deps).execute({ quoteId: quote.id });

    expect(r).toEqual({ ok: true, value: { status: 'expired' } });
    expect(counts()).toEqual({
      saves: 0,
      transactions: 1,
      revocations: [
        {
          companyId: 'co-1',
          resourceType: 'quote',
          resourceId: 'quote-1',
          scope: 'quote_signature',
          at: AT,
        },
      ],
    });
  });
});
