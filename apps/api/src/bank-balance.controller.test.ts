import { describe, expect, it, vi } from 'vitest';
import type { BackendService } from './backend.service';
import { BankBalanceController } from './api.controllers';

function controller(overrides: Partial<BackendService> = {}) {
  return new BankBalanceController(overrides as BackendService);
}

describe('BankBalanceController — preuve bancaire explicite', () => {
  it('refuse tout champ hors contrat avant la couche application', async () => {
    const recordManualBankBalance = vi.fn();
    const value = controller({ recordManualBankBalance } as never);

    await expect(
      value.recordManual({
        amountCents: 128_450,
        observedAt: '2026-07-17T10:00:00.000Z',
        companyId: 'company-other',
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(recordManualBankBalance).not.toHaveBeenCalled();
  });

  it.each([
    [{ amountCents: 12.5, observedAt: '2026-07-17T10:00:00.000Z' }, 'amountCents'],
    [
      { amountCents: Number.MAX_SAFE_INTEGER + 1, observedAt: '2026-07-17T10:00:00.000Z' },
      'amountCents',
    ],
    [{ amountCents: 1_000, observedAt: '17/07/2026' }, 'observedAt'],
    [{ amountCents: 1_000, observedAt: '2026-07-17T10:00:00Z' }, 'observedAt'],
  ])('refuse une observation non canonique (%s)', async (body, expectedField) => {
    const recordManualBankBalance = vi.fn();
    const value = controller({ recordManualBankBalance } as never);

    await expect(value.recordManual(body)).rejects.toMatchObject({
      status: 422,
      response: {
        error: {
          issues: [expect.objectContaining({ field: expectedField })],
        },
      },
    });
    expect(recordManualBankBalance).not.toHaveBeenCalled();
  });

  it('transmet exclusivement le montant et l instant confirmés par le propriétaire', async () => {
    const snapshot = {
      id: 'balance-1',
      companyId: 'company-owner',
      amountCents: -12_345,
      currency: 'EUR' as const,
      source: 'manual_confirmed' as const,
      reconciliationStatus: 'unreconciled' as const,
      observedAt: '2026-07-17T10:00:00.000Z',
      recordedAt: '2026-07-17T10:00:01.000Z',
      freshness: {
        status: 'fresh' as const,
        ageSeconds: 1,
        maximumAgeSeconds: 86_400,
        policyVersion: 'bank-balance-freshness/1',
      },
    };
    const recordManualBankBalance = vi.fn(async () => ({ ok: true as const, value: snapshot }));
    const value = controller({ recordManualBankBalance } as never);

    await expect(
      value.recordManual({
        amountCents: -12_345,
        observedAt: '2026-07-17T10:00:00.000Z',
      }),
    ).resolves.toEqual(snapshot);
    expect(recordManualBankBalance).toHaveBeenCalledWith({
      amountCents: -12_345,
      observedAt: '2026-07-17T10:00:00.000Z',
    });
  });

  it('ne remplace pas l absence de preuve bancaire par zéro', async () => {
    const latestQualifiedBankBalance = vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'not_found' as const, entity: 'bank_balance_snapshot', id: 'company-owner' },
    }));
    const value = controller({ latestQualifiedBankBalance } as never);

    await expect(value.latest()).rejects.toMatchObject({ status: 404 });
  });
});
