import { describe, expect, it } from 'vitest';
import { CreateQuoteSignatureLink, type CreateQuoteSignatureLinkDeps } from './create-quote-signature-link';
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
  const events: string[] = [];
  const quotes: QuoteRepository = {
    findById: async () => q,
    lockById: async () => q,
    listByCompany: async () => [],
    save: async () => undefined,
  };
  const publicAccessTokens: PublicAccessTokenRepository = {
    create: async () => {
      tokenCreates++;
      events.push('create');
      return { id: `grant-${tokenCreates}`, token: `pst_token_${tokenCreates}` };
    },
    findActive: async () => null,
    markUsed: async () => undefined,
    revoke: async () => undefined,
    revokeActiveFor: async () => {
      events.push('revokeActiveFor');
    },
    revokeAllForCompany: async () => undefined,
  };
  const uow = { runInTransaction: <T>(fn: () => Promise<T>) => fn() };
  const deps: CreateQuoteSignatureLinkDeps = { quotes, publicAccessTokens, uow, clock };
  return { deps, counts: () => ({ tokenCreates }), events };
}

describe('CreateQuoteSignatureLink (P0 R4 — préparer le lien SANS effet sortant)', () => {
  it('ne peut structurellement enfiler AUCUN e-mail : les deps ne portent aucun port de notification', () => {
    // Preuve par construction : le type des dépendances est le contrat. Si quelqu'un ajoute un
    // port outbox/notification ici, ce test (et la revue) doit hurler — c'était le P0.
    const depKeys = Object.keys(makeDeps(quote('sent')).deps).sort();
    expect(depKeys).toEqual(['clock', 'publicAccessTokens', 'quotes', 'uow']);
  });

  it('révoque les jetons actifs PUIS crée le nouveau (rotation : l’ancien lien meurt immédiatement)', async () => {
    const { deps, events } = makeDeps(quote('sent'));
    const r = await new CreateQuoteSignatureLink(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.token).toBe('pst_token_1');
      expect(r.value.expiresAt).toBe('2026-07-30T00:00:00.000Z');
    }
    expect(events).toEqual(['revokeActiveFor', 'create']);
  });

  it('rappelé deux fois : deux jetons distincts, chaque rotation révoque la précédente', async () => {
    const { deps, events, counts } = makeDeps(quote('viewed'));
    const first = await new CreateQuoteSignatureLink(deps).execute({ quoteId: 'quote-1' });
    const second = await new CreateQuoteSignatureLink(deps).execute({ quoteId: 'quote-1' });

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.token).not.toBe(second.value.token);
    expect(counts()).toEqual({ tokenCreates: 2 });
    expect(events).toEqual(['revokeActiveFor', 'create', 'revokeActiveFor', 'create']);
  });

  it('refuse un devis brouillon (pas encore numéroté/envoyé) sans créer ni révoquer', async () => {
    const { deps, events } = makeDeps(quote('draft', null));
    const r = await new CreateQuoteSignatureLink(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(false);
    expect(events).toEqual([]);
  });

  it('refuse un devis déjà signé (le lien ne doit plus jamais renaître)', async () => {
    const { deps, events } = makeDeps(quote('signed'));
    const r = await new CreateQuoteSignatureLink(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(false);
    expect(events).toEqual([]);
  });

  it('refuse un devis expiré', async () => {
    const { deps, events } = makeDeps(quote('sent', 'D-2026-0001', '2026-06-29'));
    const r = await new CreateQuoteSignatureLink(deps).execute({ quoteId: 'quote-1' });

    expect(r.ok).toBe(false);
    expect(events).toEqual([]);
  });
});
