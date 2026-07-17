import { describe, expect, it } from 'vitest';
import { BankBalanceSnapshot, type BankBalanceSnapshotProps } from './bank-balance-snapshot';

const validProps = (): BankBalanceSnapshotProps => ({
  id: 'balance-1',
  companyId: 'company-1',
  amountCents: -12_345,
  currency: 'EUR',
  source: 'bank_connector',
  reconciliationStatus: 'partially_reconciled',
  observedAt: '2026-07-17T08:00:00.000Z',
  recordedAt: '2026-07-17T08:00:01.000Z',
});

describe('BankBalanceSnapshot', () => {
  it.each([-Number.MAX_SAFE_INTEGER, -1, 0, 1, Number.MAX_SAFE_INTEGER])(
    'accepte le montant signé sûr %s sans le transformer',
    (amountCents) => {
      const result = BankBalanceSnapshot.record({ ...validProps(), amountCents });

      expect(result.ok && result.value.toProps().amountCents).toBe(amountCents);
    },
  );

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuse le montant non sûr %s',
    (amountCents) => {
      const result = BankBalanceSnapshot.record({ ...validProps(), amountCents });

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION', field: 'amountCents' },
      });
    },
  );

  it.each([
    ['id', { id: '' }],
    ['companyId', { companyId: ' company-1' }],
    ['currency', { currency: 'USD' }],
    ['source', { source: 'estimated' }],
    ['reconciliationStatus', { reconciliationStatus: 'assumed' }],
    ['observedAt', { observedAt: '17/07/2026 08:00' }],
    ['recordedAt', { recordedAt: '2026-07-17T08:00:01Z' }],
  ] as const)('refuse %s invalide', (field, patch) => {
    const result = BankBalanceSnapshot.record({
      ...validProps(),
      ...patch,
    } as unknown as BankBalanceSnapshotProps);

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION', field } });
  });

  it('refuse une observation postérieure à son enregistrement', () => {
    const result = BankBalanceSnapshot.record({
      ...validProps(),
      observedAt: '2026-07-17T08:00:02.000Z',
      recordedAt: '2026-07-17T08:00:01.000Z',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'observedAt' },
    });
  });
});
