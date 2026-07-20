import { describe, expect, it } from 'vitest';
import { UpdateQuoteLine } from './update-quote-line';
import { Quote } from '../../domain/billing/quote/quote';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { type QuoteRepository } from '../ports/repositories';
import { type UnitOfWorkPort } from '../ports/services';

const AT = '2026-06-01T10:00:00.000Z';

function draftQuote(): Quote {
  const composed = Quote.compose({ id: 'quote-1', companyId: 'co-1', customerId: 'cust-1', at: AT });
  if (!composed.ok) throw new Error('compose');
  const q = composed.value;
  q.addLine({ id: 'line-1', label: 'Pose chauffe-eau', category: 'labor', qty: 1, unitPriceHT: 8000, vatRate: 10 });
  return q;
}

function makeRepo(quote: Quote | null): {
  quotes: QuoteRepository;
  uow: UnitOfWorkPort;
  counts: () => { locks: number; saves: number; transactions: number };
} {
  const map = new Map<string, Quote>();
  if (quote) map.set(quote.id, quote);
  let saves = 0;
  let locks = 0;
  let transactions = 0;
  const quotes: QuoteRepository = {
    findById: async (id) => map.get(id) ?? null,
    lockById: async (id) => {
      locks += 1;
      return map.get(id) ?? null;
    },
    listByCompany: async (companyId) => [...map.values()].filter((q) => q.companyId === companyId),
    save: async (q) => {
      saves++;
      map.set(q.id, q);
    },
  };
  const uow: UnitOfWorkPort = {
    runInTransaction: async (fn) => {
      transactions += 1;
      return fn();
    },
  };
  return { quotes, uow, counts: () => ({ locks, saves, transactions }) };
}

describe('UpdateQuoteLine', () => {
  it('modifie une ligne du devis brouillon et persiste', async () => {
    const quote = draftQuote();
    const { quotes, uow, counts } = makeRepo(quote);
    const r = await new UpdateQuoteLine({ quotes, uow }).execute({
      quoteId: quote.id,
      lineId: 'line-1',
      patch: { qty: 3, unitPriceHT: 9000 },
    });

    expect(r).toEqual({ ok: true, value: { status: 'draft' } });
    expect(counts()).toEqual({ locks: 1, saves: 1, transactions: 1 });
    const saved = await quotes.findById(quote.id);
    expect(saved?.lines[0]).toMatchObject({ qty: 3, unitPriceHT: 9000 });
  });

  it('quote introuvable -> not_found', async () => {
    const { quotes, uow, counts } = makeRepo(null);
    const r = await new UpdateQuoteLine({ quotes, uow }).execute({ quoteId: 'missing', lineId: 'line-1', patch: { qty: 2 } });
    expect(r).toEqual({ ok: false, error: { kind: 'not_found', entity: 'quote', id: 'missing' } });
    expect(counts()).toEqual({ locks: 1, saves: 0, transactions: 1 });
  });

  it('ligne introuvable -> domain error, aucune sauvegarde', async () => {
    const quote = draftQuote();
    const { quotes, uow, counts } = makeRepo(quote);
    const r = await new UpdateQuoteLine({ quotes, uow }).execute({ quoteId: quote.id, lineId: 'missing', patch: { qty: 2 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toEqual({ locks: 1, saves: 0, transactions: 1 });
  });

  it('devis signé (hors draft) -> domain error INVALID_TRANSITION', async () => {
    const quote = draftQuote();
    quote.assignNumber(DocNumber.format('D', 2026, 1), AT);
    quote.send(AT);
    const { quotes, uow, counts } = makeRepo(quote);
    const r = await new UpdateQuoteLine({ quotes, uow }).execute({ quoteId: quote.id, lineId: 'line-1', patch: { qty: 2 } });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain') expect(r.error.error.code).toBe('INVALID_TRANSITION');
    expect(counts()).toEqual({ locks: 1, saves: 0, transactions: 1 });
  });

  it('refuse les champs non modifiables et ne persiste pas', async () => {
    const quote = draftQuote();
    const { quotes, uow, counts } = makeRepo(quote);
    const r = await new UpdateQuoteLine({ quotes, uow }).execute({
      quoteId: quote.id,
      lineId: 'line-1',
      patch: { id: 'line-attacker' } as never,
    });

    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain') {
      expect('field' in r.error.error ? r.error.error.field : undefined).toBe('patch');
    }
    expect(counts()).toEqual({ locks: 1, saves: 0, transactions: 1 });
    expect(quote.lines[0]?.id).toBe('line-1');
  });
});
