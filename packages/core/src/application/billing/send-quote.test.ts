import { describe, expect, it } from 'vitest';
import { SendQuote } from './send-quote';
import { type Company } from '../../domain/company/company';
import { type Quote } from '../../domain/billing/quote/quote';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { type CompanyRepository, type QuoteRepository } from '../ports/repositories';
import { type ClockPort, type SequenceCounterPort, type UnitOfWorkPort } from '../ports/services';

const clock: ClockPort = { now: () => '2026-06-30T00:00:00.000Z', today: () => '2026-06-30' };

function quoteDouble(
  overrides: Partial<{ id: string; companyId: string; number: string | null; status: string }> = {},
): Quote {
  return {
    id: overrides.id ?? 'quote-1',
    companyId: overrides.companyId ?? 'co-1',
    number: overrides.number ?? null,
    status: overrides.status ?? 'draft',
    assignNumber(n: DocNumber) {
      (this as unknown as { number: string }).number = n.value;
      return { ok: true as const, value: undefined };
    },
    send() {
      (this as unknown as { status: string }).status = 'sent';
      return { ok: true as const, value: undefined };
    },
  } as unknown as Quote;
}

function companyRepository(
  input: {
    closed?: boolean;
    events?: string[];
  } = {},
): CompanyRepository {
  const company = {
    id: 'co-1',
    isClosed: () => input.closed ?? false,
  } as Company;
  return {
    findById: async (id) => (id === company.id ? company : null),
    lockById: async (id) => (id === company.id ? company : null),
    lockForShareById: async (id) => {
      input.events?.push('company');
      return id === company.id ? company : null;
    },
    list: async () => [company],
    save: async () => {},
  };
}

describe('SendQuote — no-gap transactionnel', () => {
  it("n'alloue pas un deuxième numéro quand le devis est déjà envoyé", async () => {
    let allocations = 0;
    const events: string[] = [];
    const quote = quoteDouble({ number: 'D-2026-0001', status: 'sent' });
    const quotes: QuoteRepository = {
      findById: async () => quote,
      lockById: async () => {
        events.push('quote');
        return quote;
      },
      listByCompany: async () => [],
      save: async () => {},
    };
    const counters: SequenceCounterPort = {
      allocate: async () => {
        allocations += 1;
        return { sequence: allocations, formatted: DocNumber.format('D', 2026, allocations) };
      },
    };
    const uow: UnitOfWorkPort = { runInTransaction: (fn) => fn() };

    const r = await new SendQuote({
      companies: companyRepository({ events }),
      quotes,
      counters,
      uow,
      clock,
    }).execute({ quoteId: 'quote-1' });

    expect(r.ok && r.value.number).toBe('D-2026-0001');
    expect(allocations).toBe(0);
    expect(events).toEqual(['company', 'quote']);
  });

  it('rollback le compteur si save échoue après allocation', async () => {
    let next = 0;
    let fail = true;
    const quotesById = new Map<string, Quote>([
      ['quote-1', quoteDouble({ id: 'quote-1' })],
      ['quote-2', quoteDouble({ id: 'quote-2' })],
    ]);
    const quotes: QuoteRepository = {
      findById: async (id) => quotesById.get(id) ?? null,
      lockById: async (id) => quotesById.get(id) ?? null,
      listByCompany: async () => [],
      save: async () => {
        if (fail) throw new Error('db down');
      },
    };
    const counters: SequenceCounterPort = {
      allocate: async () => {
        next += 1;
        return { sequence: next, formatted: DocNumber.format('D', 2026, next) };
      },
    };
    const uow: UnitOfWorkPort = {
      runInTransaction: async (fn) => {
        const snapshot = next;
        try {
          return await fn();
        } catch (e) {
          next = snapshot;
          throw e;
        }
      },
    };
    const send = new SendQuote({
      companies: companyRepository(),
      quotes,
      counters,
      uow,
      clock,
    });

    await expect(send.execute({ quoteId: 'quote-1' })).rejects.toThrow('db down');
    fail = false;
    const r = await send.execute({ quoteId: 'quote-2' });

    expect(r.ok && r.value.number).toBe('D-2026-0001');
  });

  it('refuse une société clôturée avant le verrou devis et toute allocation', async () => {
    let quoteLocks = 0;
    let allocations = 0;
    const quote = quoteDouble();
    const quotes: QuoteRepository = {
      findById: async () => quote,
      lockById: async () => {
        quoteLocks += 1;
        return quote;
      },
      listByCompany: async () => [],
      save: async () => {},
    };
    const result = await new SendQuote({
      companies: companyRepository({ closed: true }),
      quotes,
      counters: {
        allocate: async () => {
          allocations += 1;
          return { sequence: allocations, formatted: DocNumber.format('D', 2026, allocations) };
        },
      },
      uow: { runInTransaction: (fn) => fn() },
      clock,
    }).execute({ quoteId: quote.id });

    expect(result.ok).toBe(false);
    expect(quoteLocks).toBe(0);
    expect(allocations).toBe(0);
  });
});
