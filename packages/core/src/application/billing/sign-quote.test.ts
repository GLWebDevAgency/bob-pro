import { describe, expect, it } from 'vitest';
import { SignQuote } from './sign-quote';
import { Quote } from '../../domain/billing/quote/quote';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { type QuoteRepository } from '../ports/repositories';

const AT = '2026-06-01T10:00:00.000Z';
const clock = { now: () => AT, today: () => '2026-06-01' };

function sentQuote(): Quote {
  const q = Quote.compose({ id: 'quote-1', companyId: 'co-1', customerId: 'cust-1', at: AT });
  if (!q.ok) throw new Error('compose');
  q.value.addLine({ id: 'line-1', label: 'Prestation', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 });
  q.value.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.value.send(AT);
  return q.value;
}

function makeDeps(quote: Quote | null) {
  let saves = 0;
  const uow = { runInTransaction: <T>(fn: () => Promise<T>): Promise<T> => fn() };
  const quotes: QuoteRepository = {
    findById: async () => quote,
    lockById: async () => quote,
    listByCompany: async () => [],
    save: async () => {
      saves++;
    },
  };
  return { deps: { quotes, uow, clock }, counts: () => ({ saves }) };
}

describe('SignQuote', () => {
  it('normalise le nom du signataire avant signature', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: '  M.   Martin  ' });

    expect(r.ok).toBe(true);
    expect(quote.signature?.signerName).toBe('M. Martin');
    expect(counts()).toEqual({ saves: 1 });
  });

  it('rejette un nom vide avant toute mutation', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: '   ' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(quote.signature).toBeNull();
    expect(counts()).toEqual({ saves: 0 });
  });

  it('rejette un nom trop long avant toute mutation', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: 'A'.repeat(121) });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(quote.signature).toBeNull();
    expect(counts()).toEqual({ saves: 0 });
  });

  it('rejette les caractères de contrôle avant toute mutation', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: 'M.\nMartin' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(quote.signature).toBeNull();
    expect(counts()).toEqual({ saves: 0 });
  });

  it.each(['Martin\u200B', 'Martin\u202E', 'Martin\u2066', 'Martin\uFEFF'])(
    'rejette les caractères invisibles/bidi (%s)',
    async (signerName) => {
      const quote = sentQuote();
      const { deps, counts } = makeDeps(quote);
      const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName });

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('domain');
      expect(quote.signature).toBeNull();
      expect(counts()).toEqual({ saves: 0 });
    },
  );
});
