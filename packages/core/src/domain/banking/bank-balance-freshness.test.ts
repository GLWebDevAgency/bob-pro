import { describe, expect, it } from 'vitest';
import { BankBalanceSnapshot, type BankBalanceSource } from './bank-balance-snapshot';
import {
  assessBankBalanceFreshness,
  BANK_BALANCE_FRESHNESS_POLICY_V1,
  type BankBalanceFreshnessPolicy,
} from './bank-balance-freshness';

function snapshot(source: BankBalanceSource = 'bank_connector') {
  const result = BankBalanceSnapshot.record({
    id: 'balance-1',
    companyId: 'company-1',
    amountCents: 12_345,
    currency: 'EUR',
    source,
    reconciliationStatus: 'unreconciled',
    observedAt: '2026-07-17T08:00:00.000Z',
    recordedAt: '2026-07-17T08:00:01.000Z',
  });
  if (!result.ok) throw new Error('Donnée de test invalide.');
  return result.value;
}

describe('bank balance freshness', () => {
  it('qualifie la borne maximale comme fraîche et expose la version appliquée', () => {
    const result = assessBankBalanceFreshness(
      snapshot('bank_connector'),
      '2026-07-17T14:00:00.000Z',
      BANK_BALANCE_FRESHNESS_POLICY_V1,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        status: 'fresh',
        ageSeconds: 21_600,
        maximumAgeSeconds: 21_600,
        evaluatedAt: '2026-07-17T14:00:00.000Z',
        policyVersion: 'bank-balance-freshness/1',
      },
    });
  });

  it('qualifie comme périmée la première seconde au-delà du seuil', () => {
    const result = assessBankBalanceFreshness(
      snapshot('manual_confirmed'),
      '2026-07-18T08:00:01.000Z',
      BANK_BALANCE_FRESHNESS_POLICY_V1,
    );

    expect(result.ok && result.value).toMatchObject({
      status: 'stale',
      ageSeconds: 86_401,
      maximumAgeSeconds: 86_400,
    });
  });

  it('refuse une politique non versionnée ou un seuil non positif', () => {
    const invalidVersion: BankBalanceFreshnessPolicy = {
      version: '',
      maximumAgeSecondsBySource: BANK_BALANCE_FRESHNESS_POLICY_V1.maximumAgeSecondsBySource,
    };
    const invalidThreshold: BankBalanceFreshnessPolicy = {
      version: 'test/1',
      maximumAgeSecondsBySource: {
        ...BANK_BALANCE_FRESHNESS_POLICY_V1.maximumAgeSecondsBySource,
        bank_statement: 0,
      },
    };

    expect(
      assessBankBalanceFreshness(snapshot(), '2026-07-17T09:00:00.000Z', invalidVersion),
    ).toMatchObject({
      ok: false,
      error: { field: 'freshnessPolicy.version' },
    });
    expect(
      assessBankBalanceFreshness(
        snapshot('bank_statement'),
        '2026-07-17T09:00:00.000Z',
        invalidThreshold,
      ),
    ).toMatchObject({
      ok: false,
      error: { field: 'freshnessPolicy.maximumAgeSecondsBySource.bank_statement' },
    });
  });

  it('refuse une évaluation non canonique ou antérieure à l’observation', () => {
    expect(
      assessBankBalanceFreshness(
        snapshot(),
        '2026-07-17T09:00:00Z',
        BANK_BALANCE_FRESHNESS_POLICY_V1,
      ),
    ).toMatchObject({
      ok: false,
      error: { field: 'evaluatedAt' },
    });
    expect(
      assessBankBalanceFreshness(
        snapshot(),
        '2026-07-17T07:59:59.999Z',
        BANK_BALANCE_FRESHNESS_POLICY_V1,
      ),
    ).toMatchObject({
      ok: false,
      error: { field: 'evaluatedAt' },
    });
  });
});
