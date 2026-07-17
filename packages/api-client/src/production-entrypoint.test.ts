import { describe, expect, it } from 'vitest';
import * as productionClient from './index';

describe('@bob/api-client production entrypoint', () => {
  it('n’expose aucun client local ni adaptateur en mémoire', () => {
    const exports = productionClient as Record<string, unknown>;

    expect(exports['LocalBobClient']).toBeUndefined();
    expect(exports['FixtureClock']).toBeUndefined();
    expect(Object.keys(exports).some((name) => name.startsWith('InMemory'))).toBe(false);
  });
});
