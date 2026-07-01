import { describe, expect, it } from 'vitest';
import { RefuseQuote } from './refuse-quote';
import { Quote } from '../../domain/billing/quote/quote';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { type QuoteRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';

const AT = '2026-06-01T10:00:00.000Z';
const clock = { now: () => AT, today: () => '2026-06-01' };

function draftQuote(): Quote {
  const q = Quote.compose({ id: 'quote-1', companyId: 'co-1', customerId: 'cust-1', at: AT });
  if (!q.ok) throw new Error('compose');
  return q.value;
}

function sentQuote(): Quote {
  const q = draftQuote();
  q.addLine({ id: 'line-1', label: 'Prestation', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 });
  q.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.send(AT);
  return q;
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
  };
  return { deps: { quotes, publicAccessTokens, uow, clock }, counts: () => ({ saves, transactions, revocations }) };
}

describe('RefuseQuote', () => {
  it('refuse un devis envoye et revoque les liens publics de signature actifs', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new RefuseQuote(deps).execute({ quoteId: quote.id });

    expect(r).toEqual({ ok: true, value: { status: 'refused' } });
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

  it('ne revoque pas les liens si la transition metier est refusee', async () => {
    const quote = draftQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new RefuseQuote(deps).execute({ quoteId: quote.id });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(quote.status).toBe('draft');
    expect(counts()).toEqual({ saves: 0, transactions: 1, revocations: [] });
  });

  it('renvoie not_found sans transaction quand le devis est absent', async () => {
    const { deps, counts } = makeDeps(null);
    const r = await new RefuseQuote(deps).execute({ quoteId: 'missing' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'not_found', entity: 'quote', id: 'missing' });
    expect(counts()).toEqual({ saves: 0, transactions: 0, revocations: [] });
  });
});
