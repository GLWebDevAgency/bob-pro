import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('frontière runtime Espace Cabinet', () => {
  it('interdit toute branche DEMO_MODE dans le service métier', () => {
    const source = readFileSync(resolve(__dirname, 'cabinet-api.service.ts'), 'utf8');
    expect(source).not.toContain('DEMO_MODE');
  });
});
