import { describe, expect, it } from 'vitest';
import * as productionCore from './index';

const TESTING_ONLY_EXPORTS = [
  'MERCIER_PROPS',
  'CUSTOMER_PROPS',
  'CASH_SNAPSHOT',
  'TODAY_FIXTURE',
  'seedCompany',
  'seedCustomers',
  'seedExpenses',
  'seedVaultDocuments',
  'DemoOcrAdapter',
] as const;

describe('@bob/core production entrypoint', () => {
  it('n’expose aucune fixture ni adapter de démonstration', () => {
    const exports = productionCore as Record<string, unknown>;
    const leaked = TESTING_ONLY_EXPORTS.filter((name) => Object.hasOwn(exports, name));

    expect(leaked).toEqual([]);
  });
});
