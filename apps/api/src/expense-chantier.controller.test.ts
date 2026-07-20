import { describe, expect, it, vi } from 'vitest';
import type { BackendService } from './backend.service';
import { DocumentsController, ExpensesController } from './api.controllers';

/**
 * Frontière HTTP de l'imputation chantier : PUT /expenses/:id/chantier (imputer / délier) et
 * passage du chantierId dans les créations (POST /expenses, PUT /documents/:id/expense).
 * Aucun champ non déclaré ne traverse ; null EXPLICITE = délier (jamais un défaut implicite).
 */
describe('ExpensesController — PUT :id/chantier', () => {
  function controller(assignExpenseChantier = vi.fn()) {
    return {
      value: new ExpensesController({ assignExpenseChantier } as unknown as BackendService),
      assignExpenseChantier,
    };
  }

  it('transmet l’imputation validée au backend (id canonique)', async () => {
    const assignExpenseChantier = vi.fn(async () => ({
      ok: true as const,
      value: { chantierId: 'chantier-durand', changed: true },
    }));
    const { value } = controller(assignExpenseChantier);

    await expect(
      value.assignChantier('exp-1', { chantierId: 'chantier-durand' }),
    ).resolves.toEqual({ chantierId: 'chantier-durand', changed: true });

    expect(assignExpenseChantier).toHaveBeenCalledWith({
      expenseId: 'exp-1',
      chantierId: 'chantier-durand',
    });
  });

  it('null EXPLICITE = délier — même route, même use case', async () => {
    const assignExpenseChantier = vi.fn(async () => ({
      ok: true as const,
      value: { chantierId: null, changed: true },
    }));
    const { value } = controller(assignExpenseChantier);

    await expect(value.assignChantier('exp-1', { chantierId: null })).resolves.toEqual({
      chantierId: null,
      changed: true,
    });
    expect(assignExpenseChantier).toHaveBeenCalledWith({ expenseId: 'exp-1', chantierId: null });
  });

  it.each([
    [{}, 'chantierId'], // clé absente ≠ null explicite : on ne délie jamais par omission
    [{ chantierId: '' }, 'chantierId'],
    [{ chantierId: '  chantier-durand ' }, 'chantierId'], // non canonique
    [{ chantierId: 42 }, 'chantierId'],
    [{ chantierId: 'chantier-durand', extra: true }, 'body'],
  ])('rejette un corps hors contrat : %j', async (body, field) => {
    const { value, assignExpenseChantier } = controller();
    await expect(value.assignChantier('exp-1', body)).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({
        error: expect.objectContaining({
          issues: expect.arrayContaining([expect.objectContaining({ field })]),
        }),
      }),
    });
    expect(assignExpenseChantier).not.toHaveBeenCalled();
  });
});

describe('POST /expenses — chantierId optionnel à la création', () => {
  it('transmet le chantierId déclaré au backend (le core prouve le tenant)', async () => {
    const recordExpense = vi.fn(async () => ({ ok: true as const, value: { id: 'exp-1' } }));
    const controller = new ExpensesController({ recordExpense } as unknown as BackendService);

    await controller.create({
      supplierName: 'Point P',
      documentDate: '2026-07-01',
      totalTtcCents: 12_000,
      category: 'materiel',
      chantierId: 'chantier-durand',
    });

    expect(recordExpense).toHaveBeenCalledWith(
      expect.objectContaining({ chantierId: 'chantier-durand' }),
    );
  });
});

describe('PUT /documents/:id/expense — destination chantier choisie au scan', () => {
  it('transmet expense.chantierId au workflow document (la dépense naîtra liée)', async () => {
    const recordDocumentExpense = vi.fn(async () => ({
      ok: true as const,
      value: { expenseId: 'exp-1', document: {} },
    }));
    const controller = new DocumentsController({
      recordDocumentExpense,
    } as unknown as BackendService);

    await controller.recordExpenseFromDocument('doc-1', {
      expectedRevision: 1,
      targetFolderId: 'folder-projects',
      expense: {
        supplierName: 'Point P',
        documentDate: '2026-07-01',
        totalTtcCents: 12_000,
        category: 'materiel',
        chantierId: 'chantier-durand',
      },
    });

    expect(recordDocumentExpense).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        expense: expect.objectContaining({ chantierId: 'chantier-durand' }),
      }),
    );
  });
});
