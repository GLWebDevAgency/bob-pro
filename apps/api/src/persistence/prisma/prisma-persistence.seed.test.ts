import { afterEach, describe, expect, it, vi } from 'vitest';
import { MERCIER_PROPS } from '@bob/core';
import { PrismaPersistence } from './prisma-persistence';
import type { PrismaService } from './prisma.service';

function harness() {
  const tx = {
    company: { upsert: vi.fn(async () => undefined) },
    customer: { upsert: vi.fn(async () => undefined) },
    documentFolder: { upsert: vi.fn(async () => undefined) },
  };
  const prisma = {
    withTenant: vi.fn(async (_companyId: string, fn: (transaction: typeof tx) => Promise<void>) =>
      fn(tx),
    ),
  } as unknown as PrismaService;
  return { persistence: new PrismaPersistence(prisma), prisma, tx };
}

describe('PrismaPersistence.seed — frontière fixtures/live', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['false', ''])('n’écrit aucune fixture quand DEMO_MODE=%j', async (demoMode) => {
    vi.stubEnv('DEMO_MODE', demoMode);
    vi.stubEnv('CABINET_INVITATION_TOKEN_ENCRYPTION_KEY', 'c'.repeat(32));
    const { persistence, prisma, tx } = harness();

    await persistence.seed();

    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(tx.company.upsert).not.toHaveBeenCalled();
    expect(tx.customer.upsert).not.toHaveBeenCalled();
  });

  it('seed Mercier uniquement sur opt-in DEMO_MODE=true', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const { persistence, prisma, tx } = harness();

    await persistence.seed();

    expect(prisma.withTenant).toHaveBeenCalledWith(MERCIER_PROPS.id, expect.any(Function));
    expect(tx.company.upsert).toHaveBeenCalledTimes(1);
    expect(tx.customer.upsert.mock.calls.length).toBeGreaterThan(0);
  });
});
