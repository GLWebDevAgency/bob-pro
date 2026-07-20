import { describe, expect, it } from 'vitest';
import { SignQuote } from './sign-quote';
import { type Company } from '../../domain/company/company';
import { Customer } from '../../domain/customer/customer';
import { Quote } from '../../domain/billing/quote/quote';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { type CompanyRepository, type QuoteRepository } from '../ports/repositories';
import {
  type PublicAccessGrant,
  type PublicAccessTokenRepository,
} from '../ports/public-access-token';

const AT = '2026-06-01T10:00:00.000Z';
const clock = { now: () => AT, today: () => '2026-06-01' };

function sentQuote(): Quote {
  const q = Quote.compose({ id: 'quote-1', companyId: 'co-1', customerId: 'cust-1', at: AT });
  if (!q.ok) throw new Error('compose');
  q.value.addLine({
    id: 'line-1',
    label: 'Prestation',
    category: 'labor',
    qty: 1,
    unitPriceHT: 10000,
    vatRate: 20,
  });
  q.value.assignNumber(DocNumber.format('D', 2026, 1), AT);
  q.value.send(AT);
  return q.value;
}

function testCustomer(type: 'b2c' | 'b2b' | 'b2g'): Customer {
  const r = Customer.of({
    id: 'cust-1',
    companyId: 'co-1',
    type,
    name: type === 'b2c' ? 'M. Bernard' : 'SARL Martin',
    address: { line1: '8 allée des Roses', zip: '92190', city: 'Meudon' },
  });
  if (!r.ok) throw new Error('customer');
  return r.value;
}

function makeDeps(
  quote: Quote | null,
  options: {
    activeGrant?: PublicAccessGrant | null;
    companyClosed?: boolean;
    customerType?: 'b2c' | 'b2b' | 'b2g';
    customerMissing?: boolean;
  } = {},
) {
  let saves = 0;
  const revokeActiveCalls: { companyId: string; resourceId: string }[] = [];
  const createCalls: { scope: string; expiresAt: string }[] = [];
  let findActiveCalls = 0;
  const uow = { runInTransaction: <T>(fn: () => Promise<T>): Promise<T> => fn() };
  const company = {
    id: quote?.companyId ?? 'co-1',
    isClosed: () => options.companyClosed === true,
  } as Company;
  const companies: CompanyRepository = {
    findById: async () => company,
    lockById: async () => company,
    lockForShareById: async () => company,
    list: async () => [company],
    save: async () => undefined,
  };
  const quotes: QuoteRepository = {
    findById: async () => quote,
    lockById: async () => quote,
    listByCompany: async () => [],
    save: async () => {
      saves++;
    },
  };
  const publicAccessTokens: PublicAccessTokenRepository = {
    create: async (input) => {
      createCalls.push({ scope: input.scope, expiresAt: input.expiresAt });
      return { id: 'grant-x', token: 'pst_new' };
    },
    findActive: async () => {
      findActiveCalls++;
      return options.activeGrant ?? null;
    },
    markUsed: async () => undefined,
    revoke: async () => undefined,
    revokeActiveFor: async (input) => {
      revokeActiveCalls.push({ companyId: input.companyId, resourceId: input.resourceId });
    },
    revokeAllForCompany: async () => undefined,
  };
  const customers = {
    findById: async () =>
      options.customerMissing === true ? null : testCustomer(options.customerType ?? 'b2c'),
  };
  return {
    deps: { companies, customers, quotes, publicAccessTokens, uow, clock },
    counts: () => ({ saves, revokeActiveCalls: revokeActiveCalls.length, findActiveCalls }),
    createCalls,
  };
}

describe('SignQuote', () => {
  it('normalise le nom du signataire avant signature', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new SignQuote(deps).execute({
      quoteId: quote.id,
      signerName: '  M.   Martin  ',
    });

    expect(r.ok).toBe(true);
    expect(quote.signature?.signerName).toBe('M. Martin');
    expect(counts()).toEqual({ saves: 1, revokeActiveCalls: 1, findActiveCalls: 0 });
  });

  it('rejette un nom vide avant toute mutation', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: '   ' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(quote.signature).toBeNull();
    expect(counts()).toEqual({ saves: 0, revokeActiveCalls: 0, findActiveCalls: 0 });
  });

  it('rejette un nom trop long avant toute mutation', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: 'A'.repeat(121) });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(quote.signature).toBeNull();
    expect(counts()).toEqual({ saves: 0, revokeActiveCalls: 0, findActiveCalls: 0 });
  });

  it('rejette les caractères de contrôle avant toute mutation', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: 'M.\nMartin' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(quote.signature).toBeNull();
    expect(counts()).toEqual({ saves: 0, revokeActiveCalls: 0, findActiveCalls: 0 });
  });

  it.each(['Martin​', 'Martin‮', 'Martin⁦', 'Martin﻿'])(
    'rejette les caractères invisibles/bidi (%s)',
    async (signerName) => {
      const quote = sentQuote();
      const { deps, counts } = makeDeps(quote);
      const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName });

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('domain');
      expect(quote.signature).toBeNull();
      expect(counts()).toEqual({ saves: 0, revokeActiveCalls: 0, findActiveCalls: 0 });
    },
  );

  // P0 R4 — signature interne (sur place) : les jetons publics actifs du devis doivent être
  // révoqués DANS la même transaction que l'écriture (un lien partagé ne doit plus rien
  // exposer une fois le devis signé, même s'il n'a jamais servi à signer).
  it('une signature interne (sur place) révoque les jetons publics actifs du devis', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: 'Martin Dupont' });

    expect(r.ok).toBe(true);
    expect(quote.signature?.method).toBe('onsite_draw');
    expect(counts().revokeActiveCalls).toBe(1);
  });

  it('refuse toute signature lorsque le verrou relit une société clôturée', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote, { companyClosed: true });

    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: 'Martin Dupont' });

    expect(r.ok).toBe(false);
    expect(quote.signature).toBeNull();
    expect(counts()).toEqual({ saves: 0, revokeActiveCalls: 0, findActiveCalls: 0 });
  });

  // P0 R4 — le tracé transmis (hash déjà calculé côté serveur) devient une preuve d'intégrité
  // liée à la signature. Absent = pas de `proof` fabriqué.
  it('porte la preuve du tracé quand un hash est fourni, aucune preuve sinon', async () => {
    const withProof = sentQuote();
    const r1 = await new SignQuote(makeDeps(withProof).deps).execute({
      quoteId: withProof.id,
      signerName: 'Martin Dupont',
      proofSha256: 'a'.repeat(64),
    });
    expect(r1.ok).toBe(true);
    expect(withProof.signature?.proof).toEqual({
      method: 'onsite_draw',
      sha256: 'a'.repeat(64),
      capturedAt: AT,
    });

    const withoutProof = sentQuote();
    const r2 = await new SignQuote(makeDeps(withoutProof).deps).execute({
      quoteId: withoutProof.id,
      signerName: 'Martin Dupont',
    });
    expect(r2.ok).toBe(true);
    expect(withoutProof.signature?.proof).toBeUndefined();
  });

  // P0 R4 — cycle de vie non atomique : le grant public est REVALIDÉ dans la transaction de
  // signature. Course simulée (jeton révoqué/rotaté après la résolution initiale, avant
  // l'écriture) -> refus propre, aucune mutation.
  it('signe à distance quand le grant est encore actif au moment de la revalidation', async () => {
    const quote = sentQuote();
    const activeGrant: PublicAccessGrant = {
      id: 'grant-1',
      companyId: 'co-1',
      resourceType: 'quote',
      resourceId: quote.id,
      scope: 'quote_signature',
      expiresAt: '2026-06-30T00:00:00.000Z',
      revokedAt: null,
    };
    const { deps, counts } = makeDeps(quote, { activeGrant });
    const r = await new SignQuote(deps).execute({
      quoteId: quote.id,
      signerName: 'Client Distant',
      remoteGrant: { token: 'pst_abc', grantId: 'grant-1' },
    });

    expect(r.ok).toBe(true);
    expect(quote.signature?.method).toBe('remote_link');
    expect(counts()).toEqual({ saves: 1, revokeActiveCalls: 1, findActiveCalls: 1 });
  });

  it('refuse proprement une signature distante dont le jeton a été révoqué pendant la course', async () => {
    const quote = sentQuote();
    // La revalidation (findActive) ne retrouve plus le grant : rotation/révocation concurrente
    // survenue entre la résolution initiale (hors transaction) et l'écriture de la signature.
    const { deps, counts } = makeDeps(quote, { activeGrant: null });
    const r = await new SignQuote(deps).execute({
      quoteId: quote.id,
      signerName: 'Client Distant',
      remoteGrant: { token: 'pst_abc', grantId: 'grant-1' },
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(quote.signature).toBeNull();
    expect(counts()).toEqual({ saves: 0, revokeActiveCalls: 0, findActiveCalls: 1 });
  });

  // ── A3 — demande d'exécution anticipée (art. L221-25 c. conso) tracée dans la signature ──

  it('A3 : b2c + case cochée → renonciation tracée et horodatée dans la signature', async () => {
    const quote = sentQuote();
    const { deps } = makeDeps(quote, { customerType: 'b2c' });
    const r = await new SignQuote(deps).execute({
      quoteId: quote.id,
      signerName: 'M. Bernard',
      earlyExecutionRequested: true,
    });

    expect(r.ok).toBe(true);
    expect(quote.signature?.earlyExecution).toEqual({ requestedAt: AT });
  });

  it('A3 : b2c sans case cochée → aucune renonciation fabriquée', async () => {
    const quote = sentQuote();
    const { deps } = makeDeps(quote, { customerType: 'b2c' });
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: 'M. Bernard' });

    expect(r.ok).toBe(true);
    expect(quote.signature?.earlyExecution).toBeUndefined();
  });

  it.each(['b2b', 'b2g'] as const)(
    'A3 : %s + case cochée → drapeau IGNORÉ (aucun droit de rétractation à renoncer)',
    async (customerType) => {
      const quote = sentQuote();
      const { deps } = makeDeps(quote, { customerType });
      const r = await new SignQuote(deps).execute({
        quoteId: quote.id,
        signerName: 'Acheteur Pro',
        earlyExecutionRequested: true,
      });

      expect(r.ok).toBe(true);
      expect(quote.signature).not.toBeNull();
      expect(quote.signature?.earlyExecution).toBeUndefined();
    },
  );

  it('A3 : case cochée mais client introuvable → refus fail-closed, aucune mutation', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote, { customerMissing: true });
    const r = await new SignQuote(deps).execute({
      quoteId: quote.id,
      signerName: 'M. Bernard',
      earlyExecutionRequested: true,
    });

    expect(r.ok).toBe(false);
    expect(quote.signature).toBeNull();
    expect(counts()).toEqual({ saves: 0, revokeActiveCalls: 0, findActiveCalls: 0 });
  });

  it('refuse une signature distante dont le grant revalidé pointe vers un autre devis (mismatch)', async () => {
    const quote = sentQuote();
    const foreignGrant: PublicAccessGrant = {
      id: 'grant-1',
      companyId: 'co-1',
      resourceType: 'quote',
      resourceId: 'quote-other',
      scope: 'quote_signature',
      expiresAt: '2026-06-30T00:00:00.000Z',
      revokedAt: null,
    };
    const { deps, counts } = makeDeps(quote, { activeGrant: foreignGrant });
    const r = await new SignQuote(deps).execute({
      quoteId: quote.id,
      signerName: 'Client Distant',
      remoteGrant: { token: 'pst_abc', grantId: 'grant-1' },
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
    expect(quote.signature).toBeNull();
    expect(counts()).toEqual({ saves: 0, revokeActiveCalls: 0, findActiveCalls: 1 });
  });
});

describe('SignQuote — A3 : qualité figée + fonctionnalité de rétractation en ligne (L221-21)', () => {
  it('la qualité du client est FIGÉE dans la signature (customerType lu en transaction)', async () => {
    const quote = sentQuote();
    const { deps } = makeDeps(quote, { customerType: 'b2c' });
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: 'M. Bernard' });
    expect(r.ok).toBe(true);
    expect(quote.signature?.customerType).toBe('b2c');
  });

  it('client B2C → jeton de rétractation créé DANS la transaction, valable toute la durée du délai', async () => {
    const quote = sentQuote();
    const { deps, createCalls } = makeDeps(quote, { customerType: 'b2c' });
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: 'M. Bernard' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Signé le 01/06/2026 → délai jusqu'au 16/06 00:00 Paris = 15/06 22:00 UTC (L221-19).
    expect(r.value.retractation).toEqual({ token: 'pst_new', expiresAt: '2026-06-15T22:00:00.000Z' });
    expect(createCalls).toEqual([{ scope: 'quote_retractation', expiresAt: '2026-06-15T22:00:00.000Z' }]);
  });

  it.each(['b2b', 'b2g'] as const)(
    'client %s → AUCUN jeton de rétractation (pas de droit, jamais de fonctionnalité fantôme)',
    async (customerType) => {
      const quote = sentQuote();
      const { deps, createCalls } = makeDeps(quote, { customerType });
      const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: 'SARL Martin' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.retractation).toBeNull();
      expect(createCalls).toEqual([]);
      expect(quote.signature?.customerType).toBe(customerType);
    },
  );

  it('client introuvable → signature REFUSÉE (fail-closed : régime légal inconnaissable)', async () => {
    const quote = sentQuote();
    const { deps, counts } = makeDeps(quote, { customerMissing: true });
    const r = await new SignQuote(deps).execute({ quoteId: quote.id, signerName: 'M. Bernard' });
    expect(r.ok).toBe(false);
    expect(quote.signature).toBeNull();
    expect(counts().saves).toBe(0);
  });
});
