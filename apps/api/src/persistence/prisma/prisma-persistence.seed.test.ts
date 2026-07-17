import { describe, expect, it } from 'vitest';
import { PrismaPersistence } from './prisma-persistence';

describe('PrismaPersistence — frontière BDD-only', () => {
  it('n’expose aucun seed métier dans l’adapter de production', () => {
    expect('seed' in PrismaPersistence.prototype).toBe(false);
  });
});
