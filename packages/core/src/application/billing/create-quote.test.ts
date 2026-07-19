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
