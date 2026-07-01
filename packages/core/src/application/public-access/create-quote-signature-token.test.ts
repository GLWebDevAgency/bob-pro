import { describe, expect, it } from 'vitest';
import { CreateQuoteSignatureToken } from './create-quote-signature-token';
import { type Quote } from '../../domain/billing/quote/quote';
import { type QuoteRepository } from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';

const clock = { now: () => '2026-06-30T00:00:00.000Z', today: () => '2026-06-30' };

function quote(status: string, number: string | null = 'D-2026-0001', validUntil: string | null = null): Quote {
  return {
    id: 'quote-1',
    companyId: 'co-1',
    status,
    number,
    validUntil,
  } as unknown as Quote;
}

function makeDeps(q: Quote | null) {
  let tokenCreates = 0;
  let revokeActiveCalls = 0;
  const quotes: QuoteRepository = {
    findById: async () => q,
    lockById: async () => q,
    listByCompany: async () => [],
    save: async () => undefined,
  };
  const publicAccessTokens: PublicAccessTokenRepository = {
    create: async () => {
      tokenCreates++;
      return { id: 'grant-1', token: 'pst_token' };
    },
    findActive: async () => null,
    markUsed: async () => undefined,
    revoke: async () => undefined,
    revokeActiveFor: async () => {
      revokeActiveCalls++;
    },
  };
  return { deps: { quotes, publicAccessTokens, clock }, counts: () => ({ tokenCreates, revokeActiveCalls }) };
}

describe('CreateQuoteSignatureToken', () => {
  it('crée un token pour un devis envoyé', async () => {
    const { deps, counts } = makeDeps(quote('sent'));
    const r = await new CreateQuoteSignatureToken(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.token).toBe('pst_token');
    expect(counts()).toEqual({ tokenCreates: 1, revokeActiveCalls: 1 });
  });

  it('rejette un devis draft même s’il a déjà un numéro', async () => {
    const { deps, counts } = makeDeps(quote('draft'));
    const r = await new CreateQuoteSignatureToken(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toEqual({ tokenCreates: 0, revokeActiveCalls: 0 });
  });

  it('rejette un devis déjà signé', async () => {
    const { deps, counts } = makeDeps(quote('signed'));
    const r = await new CreateQuoteSignatureToken(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toEqual({ tokenCreates: 0, revokeActiveCalls: 0 });
  });

  it('rejette un devis dont la date de validité est dépassée', async () => {
    const { deps, counts } = makeDeps(quote('sent', 'D-2026-0001', '2026-06-29'));
    const r = await new CreateQuoteSignatureToken(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(counts()).toEqual({ tokenCreates: 0, revokeActiveCalls: 0 });
  });
});
