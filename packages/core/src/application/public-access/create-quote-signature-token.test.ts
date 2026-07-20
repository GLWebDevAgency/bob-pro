import { describe, expect, it } from 'vitest';
import { CreateQuoteSignatureToken } from './create-quote-signature-token';
import { type Company } from '../../domain/company/company';
import { type Quote } from '../../domain/billing/quote/quote';
import { type CompanyRepository, type QuoteRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';

const clock = { now: () => '2026-06-30T00:00:00.000Z', today: () => '2026-06-30' };

function quote(
  status: string,
  number: string | null = 'D-2026-0001',
  validUntil: string | null = null,
): Quote {
  return {
    id: 'quote-1',
    companyId: 'co-1',
    status,
    number,
    validUntil,
  } as unknown as Quote;
}

function makeDeps(
  q: Quote | null,
  options: { lockedQuote?: Quote | null; failCreate?: boolean; companyClosed?: boolean } = {},
) {
  let tokenCreates = 0;
  let revokeActiveCalls = 0;
  let transactions = 0;
  let lockCalls = 0;
  let findCalls = 0;
  let companyShareLocks = 0;
  let clockCalls = 0;
  let activeGrants = ['legacy-grant'];
  const events: string[] = [];
  const company = {
    id: 'co-1',
    isClosed: () => options.companyClosed === true,
  } as Company;
  const companies: CompanyRepository = {
    findById: async () => company,
    lockById: async () => company,
    lockForShareById: async () => {
      companyShareLocks++;
      events.push('company.share');
      return company;
    },
    list: async () => [company],
    save: async () => undefined,
  };
  const quotes: QuoteRepository = {
    findById: async () => {
      findCalls++;
      return q;
    },
    lockById: async () => {
      lockCalls++;
      events.push('quote.lock');
      return options.lockedQuote === undefined ? q : options.lockedQuote;
    },
    listByCompany: async () => [],
    save: async () => undefined,
  };
  const publicAccessTokens: PublicAccessTokenRepository = {
    create: async () => {
      tokenCreates++;
      events.push('create');
      if (options.failCreate) throw new Error('token-create-failed');
      activeGrants.push('grant-1');
      return { id: 'grant-1', token: 'pst_token' };
    },
    findActive: async () => null,
    markUsed: async () => undefined,
    revoke: async () => undefined,
    revokeActiveFor: async () => {
      revokeActiveCalls++;
      events.push('revoke');
      activeGrants = [];
    },
    revokeAllForCompany: async () => undefined,
  };
  const uow = {
    runInTransaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      transactions++;
      events.push('tx.begin');
      const snapshot = [...activeGrants];
      try {
        const result = await fn();
        events.push('tx.commit');
        return result;
      } catch (error) {
        activeGrants = snapshot;
        events.push('tx.rollback');
        throw error;
      }
    },
  };
  const countedClock = {
    ...clock,
    now: () => {
      clockCalls++;
      return clock.now();
    },
  };
  return {
    deps: { companies, quotes, publicAccessTokens, uow, clock: countedClock },
    counts: () => ({
      tokenCreates,
      revokeActiveCalls,
      transactions,
      companyShareLocks,
      lockCalls,
      findCalls,
      clockCalls,
    }),
    state: () => ({ activeGrants: [...activeGrants] }),
    events,
  };
}

describe('CreateQuoteSignatureToken', () => {
  it('crée un token pour un devis envoyé', async () => {
    const { deps, counts } = makeDeps(quote('sent'));
    const r = await new CreateQuoteSignatureToken(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.token).toBe('pst_token');
    expect(counts()).toEqual({
      tokenCreates: 1,
      revokeActiveCalls: 1,
      transactions: 1,
      companyShareLocks: 1,
      lockCalls: 1,
      findCalls: 1,
      clockCalls: 1,
    });
  });

  it('rejette un devis draft même s’il a déjà un numéro', async () => {
    const { deps, counts } = makeDeps(quote('draft'));
    const r = await new CreateQuoteSignatureToken(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toMatchObject({
      tokenCreates: 0,
      revokeActiveCalls: 0,
      transactions: 1,
      lockCalls: 1,
    });
  });

  it('rejette un devis déjà signé', async () => {
    const { deps, counts } = makeDeps(quote('signed'));
    const r = await new CreateQuoteSignatureToken(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toMatchObject({
      tokenCreates: 0,
      revokeActiveCalls: 0,
      transactions: 1,
      lockCalls: 1,
    });
  });

  it('rejette un devis dont la date de validité est dépassée', async () => {
    const { deps, counts } = makeDeps(quote('sent', 'D-2026-0001', '2026-06-29'));
    const r = await new CreateQuoteSignatureToken(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toMatchObject({
      tokenCreates: 0,
      revokeActiveCalls: 0,
      transactions: 1,
      lockCalls: 1,
    });
  });

  it('valide exclusivement la rélecture verrouillée, jamais un snapshot sent périmé', async () => {
    const { deps, counts } = makeDeps(quote('sent'), { lockedQuote: quote('signed') });
    const r = await new CreateQuoteSignatureToken(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(false);
    expect(counts()).toMatchObject({
      tokenCreates: 0,
      revokeActiveCalls: 0,
      findCalls: 1,
      lockCalls: 1,
    });
  });

  it('refuse une société clôturée avant de verrouiller ou toucher le devis', async () => {
    const { deps, counts, events } = makeDeps(quote('sent'), { companyClosed: true });

    const r = await new CreateQuoteSignatureToken(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('forbidden');
    expect(counts()).toMatchObject({ companyShareLocks: 1, lockCalls: 0, tokenCreates: 0 });
    expect(events).toEqual(['tx.begin', 'company.share', 'tx.commit']);
  });

  it('annule la révocation si la création du nouveau jeton échoue', async () => {
    const { deps, state, events } = makeDeps(quote('sent'), { failCreate: true });

    await expect(
      new CreateQuoteSignatureToken(deps).execute({ quoteId: 'quote-1' }),
    ).rejects.toThrow('token-create-failed');
    expect(state().activeGrants).toEqual(['legacy-grant']);
    expect(events).toEqual([
      'tx.begin',
      'company.share',
      'quote.lock',
      'revoke',
      'create',
      'tx.rollback',
    ]);
  });
});
