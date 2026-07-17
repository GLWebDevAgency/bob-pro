import { describe, expect, it, vi } from 'vitest';
import type { BackendService } from './backend.service';
import { ExpensesController } from './api.controllers';

function controller(recordExpensePayment = vi.fn()) {
  return {
    value: new ExpensesController({ recordExpensePayment } as unknown as BackendService),
    recordExpensePayment,
  };
}

describe('ExpensesController — preuve de règlement fournisseur', () => {
  it('transmet uniquement la date, le moyen et les références validés', async () => {
    const recordExpensePayment = vi.fn(async () => ({
      ok: true as const,
      value: {
        status: 'paid' as const,
        alreadyRecorded: false,
        paymentEntryId: 'expense:exp-1:paid',
      },
    }));
    const { value } = controller(recordExpensePayment);

    await expect(value.pay('exp-1', {
      paidOn: '2026-07-17',
      method: 'transfer',
      reference: 'VIR-42',
      proofDocumentId: 'doc-42',
    })).resolves.toMatchObject({ status: 'paid' });

    expect(recordExpensePayment).toHaveBeenCalledWith({
      expenseId: 'exp-1',
      paidOn: '2026-07-17',
      method: 'transfer',
      reference: 'VIR-42',
      proofDocumentId: 'doc-42',
    });
  });

  it.each([
    [{ method: 'card' }, 'paymentEvidence'],
    [{ paidOn: '2026-07-17' }, 'paymentEvidence'],
    [{ paidOn: '17/07/2026', method: 'cash' }, 'paymentEvidence'],
    [{ paidOn: '2026-07-17', method: 'cheque' }, 'paymentEvidence'],
    [{ paidOn: '2026-07-17', method: 'card', amount: 100 }, 'amount'],
  ])('rejette un corps incomplet ou hors contrat : %j', async (body, field) => {
    const { value, recordExpensePayment } = controller();
    await expect(value.pay('exp-1', body)).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({
        error: expect.objectContaining({
          issues: [expect.objectContaining({ field })],
        }),
      }),
    });
    expect(recordExpensePayment).not.toHaveBeenCalled();
  });
});
