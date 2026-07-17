import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('frontière runtime Espace Cabinet', () => {
  it('interdit toute branche DEMO_MODE dans le service métier', () => {
    const source = readFileSync(new URL('./cabinet-api.service.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('DEMO_MODE');
  });
});
