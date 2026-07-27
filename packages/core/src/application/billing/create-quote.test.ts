import { describe, expect, it } from 'vitest';
import { CreateQuote, canonicalCreateQuotePayload, type CreateQuoteInput } from './create-quote';
import { makeEnv } from './in-memory-env';

function input(
  overrides: Partial<Omit<CreateQuoteInput, 'companyId'>> = {},
): Omit<CreateQuoteInput, 'companyId'> {
  return {
    customerId: 'customer-1',
    lines: [
      {
        label: 'Pose chauffe-eau',
        category: 'labor',
        qty: 2,
        unitPriceHT: 8_000,
        vatRate: 10,
      },
    ],
    ...overrides,
  };
}

describe('canonicalCreateQuotePayload', () => {
  it('normalise les valeurs optionnelles sans conserver la clé technique', () => {
    const implicit = canonicalCreateQuotePayload(input({ idempotencyKey: 'voice-quote-secret-1' }));
    const explicit = canonicalCreateQuotePayload(input({
      idempotencyKey: 'another-secret',
      context: { housingOlderThan2y: false, energyRenovation: false },
    }));

    expect(implicit).toEqual(explicit);
    expect(implicit).not.toHaveProperty('idempotencyKey');
  });

  it('conserve chaque différence qui change le devis', () => {
    expect(canonicalCreateQuotePayload(input({
      lines: [{ ...input().lines[0]!, unitPriceHT: 8_001 }],
    }))).not.toEqual(canonicalCreateQuotePayload(input()));
    expect(canonicalCreateQuotePayload(input({ context: { housingOlderThan2y: true } }))).not.toEqual(
      canonicalCreateQuotePayload(input()),
    );
  });
});

describe('CreateQuote — exception dépannage urgent (L221-10, al. 2 / L221-28, 8°)', () => {
  it('l’intention canonique porte le fait (replay idempotent fidèle) et le normalise à false', () => {
    expect(canonicalCreateQuotePayload(input())).toMatchObject({ urgentRepairRequested: false });
    expect(canonicalCreateQuotePayload(input({ urgentRepairRequested: true }))).not.toEqual(
      canonicalCreateQuotePayload(input()),
    );
  });

  it('client PARTICULIER : le fait est posé à la création, horodaté serveur', async () => {
    const env = makeEnv();
    const created = await new CreateQuote({
      quotes: env.quoteRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({
      companyId: env.company.id,
      customerId: 'cust-bernard', // b2c
      lines: [{ label: 'Dépannage fuite', category: 'labor', qty: 1, unitPriceHT: 12_000, vatRate: 20 }],
      urgentRepairRequested: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const quote = await env.quoteRepo.findById(created.value.quoteId);
    expect(quote?.urgentRepair).toEqual({ requestedAt: env.clock.now() });
  });

  it('client PROFESSIONNEL : refus honnête — l’exception ne protège que le consommateur', async () => {
    const env = makeEnv();
    const created = await new CreateQuote({
      quotes: env.quoteRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({
      companyId: env.company.id,
      customerId: 'cust-martin', // b2b
      lines: [{ label: 'Dépannage fuite', category: 'labor', qty: 1, unitPriceHT: 12_000, vatRate: 20 }],
      urgentRepairRequested: true,
    });
    expect(created.ok).toBe(false);
    if (created.ok || created.error.kind !== 'domain') throw new Error('erreur domaine attendue');
    expect(created.error.error).toMatchObject({
      code: 'VALIDATION',
      field: 'urgentRepairRequested',
    });
  });

  it('non sollicitée (défaut) : aucun fait tracé — fail-closed', async () => {
    const env = makeEnv();
    const created = await new CreateQuote({
      quotes: env.quoteRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({
      companyId: env.company.id,
      customerId: 'cust-bernard',
      lines: [{ label: 'Dépannage fuite', category: 'labor', qty: 1, unitPriceHT: 12_000, vatRate: 20 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await env.quoteRepo.findById(created.value.quoteId))?.urgentRepair).toBeNull();
  });
});

describe('CreateQuote — site/chantier de rattachement (PR-08)', () => {
  const chantierInput = (
    overrides: Partial<Omit<CreateQuoteInput, 'companyId'>> = {},
  ): Omit<CreateQuoteInput, 'companyId'> =>
    input({
      customerId: 'cust-bernard',
      lines: [{ label: 'Entretien fontaine', category: 'labor', qty: 1, unitPriceHT: 12_000, vatRate: 20 }],
      ...overrides,
    });
  const deps = (env: ReturnType<typeof makeEnv>, tenantChantiers: readonly string[]) => ({
    quotes: env.quoteRepo,
    companies: env.companyRepo,
    customers: env.customerRepo,
    ids: env.ids,
    clock: env.clock,
    chantierTargets: {
      exists: async (target: { companyId: string; linkedEntityId: string }) =>
        target.companyId === env.company.id && tenantChantiers.includes(target.linkedEntityId),
    },
  });

  it('rattache le devis au chantier PROUVÉ du tenant', async () => {
    const env = makeEnv();
    const created = await new CreateQuote(deps(env, ['chantier-durand'])).execute({
      companyId: env.company.id,
      ...chantierInput({ chantierId: 'chantier-durand' }),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await env.quoteRepo.findById(created.value.quoteId))?.chantierId).toBe('chantier-durand');
  });

  it('anti-IDOR : le chantier d’un AUTRE tenant est refusé (le port répond false)', async () => {
    const env = makeEnv();
    const created = await new CreateQuote(deps(env, [])).execute({
      companyId: env.company.id,
      ...chantierInput({ chantierId: 'chantier-autre-tenant' }),
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.kind).toBe('not_found');
  });

  it('fail-closed : chantierId fourni SANS port de vérification = refus, jamais un lien non vérifié', async () => {
    const env = makeEnv();
    const created = await new CreateQuote({
      quotes: env.quoteRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({
      companyId: env.company.id,
      ...chantierInput({ chantierId: 'chantier-durand' }),
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.kind).toBe('dependency');
    // Rien n'a été persisté : la vérification précède la sauvegarde.
    expect(await env.quoteRepo.listByCompany(env.company.id)).toHaveLength(0);
  });

  it('non-régression : sans chantierId, le devis naît hors site (null) et rien d’autre ne change', async () => {
    const env = makeEnv();
    const created = await new CreateQuote({
      quotes: env.quoteRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({ companyId: env.company.id, ...chantierInput() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const quote = await env.quoteRepo.findById(created.value.quoteId);
    expect(quote?.chantierId).toBeNull();
    expect(quote?.toSnapshot().chantierId).toBeNull();
  });

  it('l’intention canonique porte le site (un rejeu vers un autre site est un autre devis)', () => {
    expect(canonicalCreateQuotePayload(input())).toMatchObject({ chantierId: null });
    expect(canonicalCreateQuotePayload(input({ chantierId: 'chantier-durand' }))).not.toEqual(
      canonicalCreateQuotePayload(input()),
    );
  });
});
