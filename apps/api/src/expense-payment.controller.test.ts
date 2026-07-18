import { describe, expect, it, vi } from 'vitest';
import type { BackendService } from './backend.service';
import { ExpensesController } from './api.controllers';

function controller(recordExpensePayment = vi.fn(), regularizeExpensePayment = vi.fn()) {
  return {
    value: new ExpensesController({
      recordExpensePayment,
      regularizeExpensePayment,
    } as unknown as BackendService),
    recordExpensePayment,
    regularizeExpensePayment,
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

describe('ExpensesController — régularisation d’une ligne historique payée sans preuve', () => {
  it('transmet la preuve validée au use case de régularisation, jamais au règlement', async () => {
    const regularizeExpensePayment = vi.fn(async () => ({
      ok: true as const,
      value: {
        status: 'paid' as const,
        alreadyRegularized: false,
        paymentEntryId: 'expense:exp-legacy:paid',
      },
    }));
    const { value, recordExpensePayment } = controller(vi.fn(), regularizeExpensePayment);

    await expect(value.regularizePayment('exp-legacy', {
      paidOn: '2026-07-10',
      method: 'cash',
      reference: 'TICKET-9',
    })).resolves.toMatchObject({ status: 'paid', alreadyRegularized: false });

    expect(regularizeExpensePayment).toHaveBeenCalledWith({
      expenseId: 'exp-legacy',
      paidOn: '2026-07-10',
      method: 'cash',
      reference: 'TICKET-9',
    });
    expect(recordExpensePayment).not.toHaveBeenCalled();
  });

  it('applique le même contrat de corps strict que :id/pay', async () => {
    const { value, regularizeExpensePayment } = controller();
    await expect(value.regularizePayment('exp-legacy', {
      paidOn: '2026-07-10',
      method: 'cash',
      amount: 100,
    })).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({
        error: expect.objectContaining({
          issues: [expect.objectContaining({ field: 'amount' })],
        }),
      }),
    });
    expect(regularizeExpensePayment).not.toHaveBeenCalled();
  });
});
