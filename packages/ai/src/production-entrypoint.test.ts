import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as productionAi from './index';

describe('@bob/ai production entrypoint', () => {
  it('n’expose aucun fournisseur de démonstration ni mémoire en processus', () => {
    const exports = productionAi as Record<string, unknown>;

    expect(exports['DemoLlmAdapter']).toBeUndefined();
    expect(exports['DemoSttAdapter']).toBeUndefined();
    expect(exports['DemoTtsAdapter']).toBeUndefined();
    expect(exports['InMemoryCompanyMemory']).toBeUndefined();
    expect(exports['InMemoryJournalStore']).toBeUndefined();
    expect(exports['OCR_GOLDEN_CASES']).toBeUndefined();
    expect(exports['runOcrEval']).toBeUndefined();
  });

  it('isole physiquement la mémoire en processus dans le module testing', () => {
    const runtime = readFileSync(resolve(__dirname, './memory/company-memory.ts'), 'utf8');
    const testing = readFileSync(resolve(__dirname, './memory/company-memory.testing.ts'), 'utf8');

    expect(runtime).not.toContain('class InMemoryCompanyMemory');
    expect(testing).toContain('class InMemoryCompanyMemory');
  });
});
