import { describe, expect, it, vi } from 'vitest';
import type { AppError, DocumentView } from '@bob/core';
import type { RecordDocumentExpenseClientInput, RecordDocumentExpenseClientOutput } from './client';
import { reconcileDocumentExpenseCommand } from './document-expense-reconciliation';

const command: RecordDocumentExpenseClientInput = {
  documentId: 'document-1',
  expectedRevision: 4,
  targetFolderId: 'folder-achats',
  expense: {
    supplierName: 'Cedeo',
    documentDate: '2026-07-13',
    totalTtcCents: 12_000,
    category: 'fournitures',
  },
};

const currentDocument = {
  id: 'document-1',
  revision: 5,
  folderId: 'folder-concurrent',
} as DocumentView;

const committed = {
  expenseId: 'expense-1',
  document: { ...currentDocument, folderId: 'folder-achats', revision: 6 },
} as RecordDocumentExpenseClientOutput;

const dependency: AppError = { kind: 'dependency', port: 'api', cause: 'The operation was aborted.' };
const conflict: AppError = { kind: 'conflict', entity: 'document', reason: 'Révision obsolète.' };

describe('reconcileDocumentExpenseCommand', () => {
  it('prouve une réponse 2xx perdue en rejouant strictement la commande originale', async () => {
    const recordDocumentExpense = vi.fn(async (_input: RecordDocumentExpenseClientInput) => ({
      ok: true as const,
      value: committed,
    }));
    const getDocument = vi.fn();

    const result = await reconcileDocumentExpenseCommand(
      { recordDocumentExpense, getDocument },
      command,
      dependency,
    );

    expect(result).toEqual({ kind: 'verified', value: committed });
    expect(recordDocumentExpense).toHaveBeenCalledOnce();
    expect(recordDocumentExpense).toHaveBeenCalledWith(command);
    expect(recordDocumentExpense.mock.calls[0]?.[0].expectedRevision).toBe(4);
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('ne remplace jamais la révision après un conflit du replay et rend le diff à confirmer', async () => {
    const recordDocumentExpense = vi.fn(async (_input: RecordDocumentExpenseClientInput) => ({
      ok: false as const,
      error: conflict,
    }));
    const getDocument = vi.fn(async () => ({ ok: true as const, value: currentDocument }));

    const result = await reconcileDocumentExpenseCommand(
      { recordDocumentExpense, getDocument },
      command,
      dependency,
    );

    expect(result).toEqual({
      kind: 'stale',
      command,
      current: currentDocument,
      readError: null,
    });
    expect(recordDocumentExpense).toHaveBeenCalledWith(command);
    expect(recordDocumentExpense.mock.calls[0]?.[0].expectedRevision).toBe(4);
    expect(getDocument).toHaveBeenCalledWith('document-1');
  });

  it('ne rejoue pas une commande dont le serveur a déjà répondu conflit', async () => {
    const recordDocumentExpense = vi.fn();
    const getDocument = vi.fn(async () => ({ ok: true as const, value: currentDocument }));

    const result = await reconcileDocumentExpenseCommand(
      { recordDocumentExpense, getDocument },
      command,
      conflict,
    );

    expect(result.kind).toBe('stale');
    expect(recordDocumentExpense).not.toHaveBeenCalled();
    expect(getDocument).toHaveBeenCalledWith('document-1');
  });

  it('reste incertain après deux erreurs réseau et conserve la commande exacte pour un retry explicite', async () => {
    const recordDocumentExpense = vi.fn(async (_input: RecordDocumentExpenseClientInput) => ({
      ok: false as const,
      error: dependency,
    }));
    const getDocument = vi.fn();

    const result = await reconcileDocumentExpenseCommand(
      { recordDocumentExpense, getDocument },
      command,
      dependency,
    );

    expect(result).toEqual({ kind: 'unresolved', command, error: dependency });
    expect(recordDocumentExpense).toHaveBeenCalledWith(command);
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('ne rejoue jamais une erreur serveur définitive', async () => {
    const validation: AppError = {
      kind: 'validation',
      issues: [{ field: 'expense', message: 'Données invalides.' }],
    };
    const recordDocumentExpense = vi.fn();
    const getDocument = vi.fn();

    await expect(reconcileDocumentExpenseCommand(
      { recordDocumentExpense, getDocument },
      command,
      validation,
    )).resolves.toEqual({ kind: 'rejected', command, error: validation });
    expect(recordDocumentExpense).not.toHaveBeenCalled();
    expect(getDocument).not.toHaveBeenCalled();
  });
});
