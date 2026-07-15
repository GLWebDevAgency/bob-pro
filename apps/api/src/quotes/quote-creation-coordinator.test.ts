import { describe, expect, it } from 'vitest';
import { seedCompany, type CreateQuoteInput, type IdGeneratorPort } from '@bob/core';
import { InMemoryPersistence } from '../persistence/persistence';
import { QuoteCreationCoordinator } from './quote-creation-coordinator';

const companyId = seedCompany().id;
const clock = {
  now: () => '2026-07-14T12:00:00.000Z',
  today: () => '2026-07-14',
};

function sequenceIds(): IdGeneratorPort {
  let sequence = 0;
  return { newId: () => `quote-idempotency-${++sequence}` };
}

function request(overrides: Partial<Omit<CreateQuoteInput, 'companyId'>> = {}): Omit<CreateQuoteInput, 'companyId'> {
  return {
    customerId: 'cust-martin',
    idempotencyKey: 'mobile-voice:quote:response-loss-1',
    lines: [
      { label: 'Pose chauffe-eau', category: 'labor', qty: 2, unit: 'h', unitPriceHT: 8_000, vatRate: 10 },
    ],
    context: { housingOlderThan2y: true },
    ...overrides,
  };
}

describe('QuoteCreationCoordinator', () => {
  it('converge en concurrence et après perte de réponse sur un seul devis et la réponse originale', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.seed();
    const coordinator = new QuoteCreationCoordinator({ persistence, ids: sequenceIds(), clock });
    const before = await persistence.quotes.listByCompany(companyId);

    const [first, concurrent] = await Promise.all([
      coordinator.execute({ companyId, quote: request() }),
      coordinator.execute({ companyId, quote: request() }),
    ]);
    expect(first.ok).toBe(true);
    expect(concurrent).toEqual(first);

    // Le commit a pu réussir alors que la première réponse a été perdue : le rejeu est la
    // seule source de vérité et doit restituer exactement l'output publié.
    const responseLossReplay = await coordinator.execute({ companyId, quote: request() });
    expect(responseLossReplay).toEqual(first);
    const after = await persistence.quotes.listByCompany(companyId);
    expect(after).toHaveLength(before.length + 1);
  });

  it('rejette la réutilisation de la clé pour un payload différent sans créer de devis', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.seed();
    const coordinator = new QuoteCreationCoordinator({ persistence, ids: sequenceIds(), clock });
    const first = await coordinator.execute({ companyId, quote: request() });
    expect(first.ok).toBe(true);
    const count = (await persistence.quotes.listByCompany(companyId)).length;

    const conflict = await coordinator.execute({
      companyId,
      quote: request({ lines: [{ ...request().lines[0]!, unitPriceHT: 8_001 }] }),
    });
    expect(conflict).toMatchObject({ ok: false, error: { kind: 'conflict', entity: 'quote_creation' } });
    expect(await persistence.quotes.listByCompany(companyId)).toHaveLength(count);
  });

  it.each(['', '   ', 'bad\nkey', 'x'.repeat(201)])('refuse une clé non canonique (%j)', async (idempotencyKey) => {
    const persistence = new InMemoryPersistence();
    await persistence.seed();
    const coordinator = new QuoteCreationCoordinator({ persistence, ids: sequenceIds(), clock });

    const result = await coordinator.execute({ companyId, quote: request({ idempotencyKey }) });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'idempotencyKey' }] },
    });
    expect(await persistence.quotes.listByCompany(companyId)).toHaveLength(0);
  });
});
