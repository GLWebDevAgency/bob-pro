import { describe, expect, it } from 'vitest';
import { canonicalRecordExpensePayload, type RecordExpenseInput } from './record-expense';

function input(overrides: Partial<Omit<RecordExpenseInput, 'companyId'>> = {}): Omit<RecordExpenseInput, 'companyId'> {
  return {
    supplierName: ' Cedeo ',
    supplierSiren: '552 100 554',
    documentDate: '2026-07-13',
    totalTtcCents: 12_000,
    category: 'fournitures',
    ...overrides,
  };
}

describe('canonicalRecordExpensePayload', () => {
  it('normalise les variantes sans effet comptable et exclut la clé technique', () => {
    const implicit = canonicalRecordExpensePayload(input({ idempotencyKey: 'secret-retry-key' }));
    const explicit = canonicalRecordExpensePayload(input({
      idempotencyKey: 'autre-cle',
      supplierName: 'Cedeo',
      supplierSiren: '552100554',
      totalHtCents: null,
      vatCents: null,
      vatRatePct: null,
      source: 'manual',
      supplierInvoiceNumber: '',
      dueAt: null,
    }));

    expect(implicit).toEqual(explicit);
    expect(implicit).not.toHaveProperty('idempotencyKey');
  });

  it('conserve toute différence qui change la dépense', () => {
    expect(canonicalRecordExpensePayload(input({ totalTtcCents: 12_001 }))).not.toEqual(
      canonicalRecordExpensePayload(input()),
    );
  });
});
