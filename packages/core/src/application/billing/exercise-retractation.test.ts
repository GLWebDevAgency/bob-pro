import { describe, expect, it } from 'vitest';
import { ExerciseRetractation } from './exercise-retractation';
import { type Company } from '../../domain/company/company';
import { Customer } from '../../domain/customer/customer';
import { Quote, type QuoteSnapshot } from '../../domain/billing/quote/quote';
import { type CompanyRepository, type QuoteRepository } from '../ports/repositories';
import {
  type PublicAccessGrant,
  type PublicAccessTokenRepository,
} from '../ports/public-access-token';

const SIGNED_AT = '2026-06-01T09:00:00.000Z';
const DURING_PERIOD = '2026-06-10T12:30:00.000Z';
const AFTER_PERIOD = '2026-06-15T22:00:00.000Z';

function signedQuote(over: Partial<QuoteSnapshot> = {}): Quote {
  return Quote.rehydrate({
    id: 'quote-1',
    companyId: 'co-1',
    customerId: 'cust-1',
    status: 'signed',
    number: 'D-2026-0001',
    depositPct: null,
    validUntil: null,
    signature: {
      signerName: 'M. Bernard',
      signedAt: SIGNED_AT,
      method: 'remote_link',
      accepted: true,
      customerType: 'b2c',
    },
    lines: [
      { id: 'line-1', label: 'Intervention', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 },
    ],
    ...over,
  });
}

function activeGrant(over: Partial<PublicAccessGrant> = {}): PublicAccessGrant {
  return {
    id: 'grant-1',
    companyId: 'co-1',
    resourceType: 'quote',
    resourceId: 'quote-1',
    scope: 'quote_retractation',
    expiresAt: '2026-06-15T22:00:00.000Z',
    revokedAt: null,
    ...over,
  };
}

function makeDeps(
  quote: Quote | null,
  options: {
    grant?: PublicAccessGrant | null;
    now?: string;
    companyClosed?: boolean;
    customerType?: 'b2c' | 'b2b';
  } = {},
) {
  let saves = 0;
  const revoked: string[] = [];
  const company = {
    id: 'co-1',
    name: 'Mercier Plomberie',
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
    create: async () => ({ id: 'x', token: 'x' }),
    findActive: async () => (options.grant === undefined ? activeGrant() : options.grant),
    markUsed: async () => undefined,
    revoke: async () => undefined,
    revokeActiveFor: async (input) => {
      revoked.push(input.scope);
    },
    revokeAllForCompany: async () => undefined,
  };
  const customerR = Customer.of({
    id: 'cust-1',
    companyId: 'co-1',
    type: options.customerType ?? 'b2c',
    name: 'M. Bernard',
    address: { line1: '8 allée des Roses', zip: '92190', city: 'Meudon' },
  });
  if (!customerR.ok) throw new Error('customer');
  const deps = {
    companies,
    customers: { findById: async () => customerR.value },
    quotes,
    publicAccessTokens,
    uow: { runInTransaction: <T>(fn: () => Promise<T>): Promise<T> => fn() },
    clock: { now: () => options.now ?? DURING_PERIOD, today: () => (options.now ?? DURING_PERIOD).slice(0, 10) },
  };
  return { deps, counts: () => ({ saves, revoked }) };
}

const input = {
  quoteId: 'quote-1',
  grant: { token: 'pst_r1', grantId: 'grant-1' },
  declarantName: 'M. Bernard',
  acknowledgmentEmail: 'bernard@example.fr',
};

describe('ExerciseRetractation (fonctionnalité en ligne, L221-21/D221-5)', () => {
  it('cas nominal : rétractation enregistrée, jetons révoqués, déclaration + accusé produits', async () => {
    const quote = signedQuote();
    const { deps, counts } = makeDeps(quote);
    const r = await new ExerciseRetractation(deps).execute(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.retractedAt).toBe(DURING_PERIOD);
    expect(quote.retractedAt).toBe(DURING_PERIOD);
    expect(counts()).toEqual({ saves: 1, revoked: ['quote_retractation'] });
    // Accusé D221-5, IV : contenu de la déclaration + date/heure d'envoi.
    const acknowledgment = r.value.acknowledgmentLines.join('\n');
    expect(acknowledgment).toContain('Accusé de réception');
    expect(acknowledgment).toContain('D-2026-0001');
    expect(acknowledgment).toContain('M. Bernard');
    expect(acknowledgment).toContain('bernard@example.fr');
    expect(acknowledgment).toContain('10/06/2026 à 14:30 (heure de Paris)');
    for (const line of r.value.declarationLines) expect(r.value.acknowledgmentLines).toContain(line);
  });

  it('délai expiré → refus honnête (la fonctionnalité n’est due que pendant le délai)', async () => {
    const { deps, counts } = makeDeps(signedQuote(), { now: AFTER_PERIOD });
    const r = await new ExerciseRetractation(deps).execute(input);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain' && r.error.error.code === 'VALIDATION')
      expect(r.error.error.message).toContain('expiré');
    expect(counts().saves).toBe(0);
  });

  it('déjà rétracté → refus (une seule rétractation par contrat), rien de réécrit', async () => {
    const quote = signedQuote({ retractedAt: '2026-06-05T10:00:00.000Z' });
    const { deps, counts } = makeDeps(quote);
    const r = await new ExerciseRetractation(deps).execute(input);
    expect(r.ok).toBe(false);
    expect(quote.retractedAt).toBe('2026-06-05T10:00:00.000Z');
    expect(counts().saves).toBe(0);
  });

  it('contrat conclu avec un PROFESSIONNEL (qualité figée) → aucun droit, refus', async () => {
    const quote = signedQuote({
      signature: {
        signerName: 'SARL Martin',
        signedAt: SIGNED_AT,
        method: 'remote_link',
        accepted: true,
        customerType: 'b2b',
      },
    });
    const { deps } = makeDeps(quote, { customerType: 'b2b' });
    const r = await new ExerciseRetractation(deps).execute(input);
    expect(r.ok).toBe(false);
  });

  it('jeton révoqué/expiré ou d’un autre scope → refus (revalidation EN transaction)', async () => {
    const wrongScope = activeGrant({ scope: 'quote_signature' });
    const { deps, counts } = makeDeps(signedQuote(), { grant: wrongScope });
    const r = await new ExerciseRetractation(deps).execute(input);
    expect(r.ok).toBe(false);
    expect(counts().saves).toBe(0);
    const { deps: deps2 } = makeDeps(signedQuote(), { grant: null });
    expect((await new ExerciseRetractation(deps2).execute(input)).ok).toBe(false);
  });

  it('adresse électronique invalide → refus (l’accusé sur support durable est dû, D221-5)', async () => {
    const { deps, counts } = makeDeps(signedQuote());
    const r = await new ExerciseRetractation(deps).execute({ ...input, acknowledgmentEmail: 'pas-un-email' });
    expect(r.ok).toBe(false);
    expect(counts().saves).toBe(0);
  });

  it('nom du déclarant requis (D221-5 : la déclaration porte le nom du consommateur)', async () => {
    const { deps } = makeDeps(signedQuote());
    const r = await new ExerciseRetractation(deps).execute({ ...input, declarantName: ' ' });
    expect(r.ok).toBe(false);
  });

  it('compte clôturé → refus', async () => {
    const { deps } = makeDeps(signedQuote(), { companyClosed: true });
    const r = await new ExerciseRetractation(deps).execute(input);
    expect(r.ok).toBe(false);
  });
});
