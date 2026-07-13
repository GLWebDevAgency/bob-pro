import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { DocumentsController, ExpensesController } from './api.controllers';
import type { BackendService } from './backend.service';

describe('ExpensesController runtime boundary', () => {
  it.each([null, [], 'expense'])('rejette un body non objet sans appeler le métier (%j)', async (body) => {
    const backend = { recordExpense: vi.fn() };
    const controller = new ExpensesController(backend as unknown as BackendService);

    let thrown: unknown;
    try {
      await controller.create(body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(422);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: { kind: 'validation', issues: [{ field: 'body' }] },
    });
    expect(backend.recordExpense).not.toHaveBeenCalled();
  });

  it.each([
    [{}, 'supplierName'],
    [{ supplierName: 42, documentDate: '2026-07-13', totalTtcCents: 1_000, category: 'repas' }, 'supplierName'],
    [{ supplierName: 'Cedeo', documentDate: '2026-07-13', totalTtcCents: '1000', category: 'repas' }, 'totalTtcCents'],
    [{ supplierName: 'Cedeo', documentDate: '2026-07-13', totalTtcCents: 1_000, category: 'invented' }, 'category'],
    [{ supplierName: 'Cedeo', documentDate: '2026-07-13', totalTtcCents: 1_000, category: 'repas', companyId: 'other-tenant' }, 'body'],
  ])('rejette un objet malformé/injecté sans appeler le métier (%j)', async (body, expectedField) => {
    const backend = { recordExpense: vi.fn() };
    const controller = new ExpensesController(backend as unknown as BackendService);

    let thrown: unknown;
    try {
      await controller.create(body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(422);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: { kind: 'validation', issues: expect.arrayContaining([expect.objectContaining({ field: expectedField })]) },
    });
    expect(backend.recordExpense).not.toHaveBeenCalled();
  });

  it('ne transmet au métier que le DTO financier explicitement autorisé', async () => {
    const backend = { recordExpense: vi.fn(async () => ({ ok: true as const, value: { id: 'expense-1' } })) };
    const controller = new ExpensesController(backend as unknown as BackendService);
    const body = {
      supplierName: ' Cedeo ',
      supplierSiren: null,
      documentDate: '2026-07-13',
      totalTtcCents: 12_000,
      totalHtCents: null,
      vatCents: 2_000,
      vatRatePct: 20,
      category: 'fournitures',
      source: 'ocr',
      supplierInvoiceNumber: '',
      dueAt: null,
      idempotencyKey: 'scan-expense-1',
    };

    await expect(controller.create(body)).resolves.toEqual({ id: 'expense-1' });
    expect(backend.recordExpense).toHaveBeenCalledWith(body);
  });
});

describe('DocumentsController document -> expense runtime boundary', () => {
  const validExpense = {
    supplierName: 'Cedeo',
    supplierSiren: null,
    documentDate: '2026-07-13',
    totalTtcCents: 12_000,
    totalHtCents: 10_000,
    vatCents: 2_000,
    vatRatePct: 20,
    category: 'fournitures',
    supplierInvoiceNumber: null,
    dueAt: null,
  };

  it.each([
    [{ expectedRevision: 0, targetFolderId: 'folder-1', expense: validExpense }, 'expectedRevision'],
    [{ expectedRevision: 1, targetFolderId: ' folder-1 ', expense: validExpense }, 'targetFolderId'],
    [{ expectedRevision: 1, targetFolderId: 'folder-1', expense: null }, 'expense'],
    [{ expectedRevision: 1, targetFolderId: 'folder-1', expense: { ...validExpense, companyId: 'other' } }, 'body'],
    [{ expectedRevision: 1, targetFolderId: 'folder-1', expense: { ...validExpense, idempotencyKey: 'forged' } }, 'body'],
    [{ expectedRevision: 1, targetFolderId: 'folder-1', expense: { ...validExpense, source: 'manual' } }, 'body'],
    [{ expectedRevision: 1, targetFolderId: 'folder-1', expense: validExpense, linkedEntityId: 'expense-1' }, 'body'],
  ])('rejette un contrat atomique malformé ou un champ sous autorité serveur (%j)', async (body, field) => {
    const backend = { recordDocumentExpense: vi.fn() };
    const controller = new DocumentsController(backend as unknown as BackendService);

    let thrown: unknown;
    try {
      await controller.recordExpenseFromDocument('document-1', body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(422);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: { kind: 'validation', issues: expect.arrayContaining([expect.objectContaining({ field })]) },
    });
    expect(backend.recordDocumentExpense).not.toHaveBeenCalled();
  });

  it('transmet uniquement la révision, le dossier et le brouillon financier autorisés', async () => {
    const backend = {
      recordDocumentExpense: vi.fn(async () => ({
        ok: true as const,
        value: { expenseId: 'expense-1', document: { id: 'document-1' } },
      })),
    };
    const controller = new DocumentsController(backend as unknown as BackendService);

    await expect(controller.recordExpenseFromDocument('document-1', {
      expectedRevision: 3,
      targetFolderId: 'folder-purchases',
      expense: validExpense,
    })).resolves.toEqual({ expenseId: 'expense-1', document: { id: 'document-1' } });
    expect(backend.recordDocumentExpense).toHaveBeenCalledWith({
      documentId: 'document-1',
      expectedRevision: 3,
      targetFolderId: 'folder-purchases',
      expense: validExpense,
    });
  });
});

describe('DocumentsController polymorphic document links runtime boundary', () => {
  const validUpload = {
    contentBase64: '/9j/2Q==',
    mimeType: 'image/jpeg',
    filename: 'ticket.jpg',
    kind: 'expense_receipt',
  };

  it.each([
    [{ ...validUpload, companyId: 'other-tenant' }, 'body'],
    [{ ...validUpload, linkedEntityType: 'expense' }, 'linkedEntity'],
    [{ ...validUpload, linkedEntityType: null, linkedEntityId: 'expense-1' }, 'linkedEntity'],
    [{ ...validUpload, linkedEntityType: 'customer', linkedEntityId: 'customer-1' }, 'linkedEntityType'],
    [{ ...validUpload, linkedEntityType: 'expense', linkedEntityId: '  expense-1  ' }, 'linkedEntityId'],
  ])('rejette un upload avec rattachement malformé ou autorité tenant forgée (%j)', async (body, field) => {
    const backend = { uploadDocument: vi.fn() };
    const controller = new DocumentsController(backend as unknown as BackendService);

    let thrown: unknown;
    try {
      await controller.upload(body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(422);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: { kind: 'validation', issues: expect.arrayContaining([expect.objectContaining({ field })]) },
    });
    expect(backend.uploadDocument).not.toHaveBeenCalled();
  });

  it('transmet un upload explicite null/null ou type/id sans aucun champ surnuméraire', async () => {
    const backend = {
      uploadDocument: vi.fn(async () => ({ ok: true as const, value: { id: 'document-1' } })),
    };
    const controller = new DocumentsController(backend as unknown as BackendService);
    const body = {
      ...validUpload,
      linkedEntityType: 'expense',
      linkedEntityId: 'expense-1',
      documentDate: '2026-07-13',
      folderId: null,
      tags: ['achat'],
    };

    await expect(controller.upload(body)).resolves.toEqual({ id: 'document-1' });
    expect(backend.uploadDocument).toHaveBeenCalledWith(body);
  });

  it.each([
    [{ linkedEntityType: 'expense', linkedEntityId: 'expense-1', expectedRevision: 1, companyId: 'other' }, 'body'],
    [{ linkedEntityType: 'customer', linkedEntityId: 'customer-1', expectedRevision: 1 }, 'linkedEntityType'],
    [{ linkedEntityType: 'expense', linkedEntityId: '', expectedRevision: 1 }, 'linkedEntityId'],
    [{ linkedEntityType: 'expense', linkedEntityId: 'expense-1', expectedRevision: 0 }, 'expectedRevision'],
  ])('rejette une classification malformée/injectée (%j)', async (body, field) => {
    const backend = { classifyDocument: vi.fn() };
    const controller = new DocumentsController(backend as unknown as BackendService);

    let thrown: unknown;
    try {
      await controller.classify('document-1', body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(422);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: { kind: 'validation', issues: expect.arrayContaining([expect.objectContaining({ field })]) },
    });
    expect(backend.classifyDocument).not.toHaveBeenCalled();
  });

  it('ne transmet à classify que le document de route, la cible et la révision autorisées', async () => {
    const backend = {
      classifyDocument: vi.fn(async () => ({ ok: true as const, value: { id: 'document-1', revision: 2 } })),
    };
    const controller = new DocumentsController(backend as unknown as BackendService);
    const body = { linkedEntityType: 'quote', linkedEntityId: 'quote-1', expectedRevision: 1 };

    await expect(controller.classify('document-1', body)).resolves.toEqual({ id: 'document-1', revision: 2 });
    expect(backend.classifyDocument).toHaveBeenCalledWith({ documentId: 'document-1', ...body });
  });
});
