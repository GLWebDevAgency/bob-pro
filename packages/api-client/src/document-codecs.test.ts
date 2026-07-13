import { describe, expect, it } from 'vitest';
import { makeDocumentAnalysis, type DocumentView } from '@bob/core';
import {
  decodeDocumentAnalysis,
  decodeDocumentAnalysisForDocument,
  decodeDocumentExpenseCreationForContext,
  decodeDocumentDownloadUrl,
  decodeDocumentFolderDeletionPlan,
  decodeDocumentFolderDeletionPlanForFolder,
  decodeDocumentFolderPage,
  decodeDocumentFolderPageForContext,
  decodeDocumentFolderViewForContext,
  decodeDocumentMoveForContext,
  decodeDocumentView,
  decodeDocumentViewForContext,
  decodeDocumentViews,
  decodeDocumentViewsForCompany,
} from './document-codecs';

const SHA = 'a'.repeat(64);

function documentView(overrides: Partial<DocumentView> = {}): DocumentView {
  return {
    id: 'document-1',
    companyId: 'company-1',
    kind: 'expense_receipt',
    origin: 'ocr',
    status: 'active',
    filename: 'ticket.jpg',
    mimeType: 'image/jpeg',
    byteSize: 123,
    sha256: SHA,
    storageKey: `companies/company-1/documents/document-1/v1/${SHA}.jpg`,
    folderId: null,
    revision: 1,
    version: 1,
    linkedEntityType: null,
    linkedEntityId: null,
    documentDate: '2026-07-13',
    issuedAt: null,
    createdAt: '2026-07-13T12:00:00.000Z',
    createdBy: 'user-1',
    retentionUntil: '2036-07-13',
    tags: ['ticket'],
    ...overrides,
  };
}

function folder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'folder-1',
    companyId: 'company-1',
    parentId: null,
    name: 'Achats',
    normalizedName: 'achats',
    systemKey: 'purchases',
    status: 'active',
    revision: 1,
    createdAt: '2026-07-13T12:00:00.000Z',
    updatedAt: '2026-07-13T12:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

describe('document HTTP codecs', () => {
  it('accepte une vue canonique, la clone et refuse les incohérences tenant/rattachement', () => {
    const input = documentView();
    const decoded = decodeDocumentView(input);
    expect(decoded).toEqual(input);
    expect(decoded).not.toBe(input);
    expect(decoded?.tags).not.toBe(input.tags);

    expect(decodeDocumentView({ ...input, storageKey: `companies/other/documents/document-1/v1/${SHA}.jpg` })).toBeNull();
    expect(decodeDocumentView({ ...input, linkedEntityType: 'expense', linkedEntityId: null })).toBeNull();
    expect(decodeDocumentView({ ...input, revision: Number.NaN })).toBeNull();
    expect(decodeDocumentViews([input, {}])).toBeNull();
  });

  it('lie les documents décodés au tenant et à la ressource demandés', () => {
    const input = documentView();
    expect(decodeDocumentViewForContext(input, {
      companyId: 'company-1',
      documentId: 'document-1',
    })).toEqual(input);
    expect(decodeDocumentViewForContext(input, {
      companyId: 'company-2',
      documentId: 'document-1',
    })).toBeNull();
    expect(decodeDocumentViewForContext(input, {
      companyId: 'company-1',
      documentId: 'document-2',
    })).toBeNull();
    expect(decodeDocumentViewForContext(input, {
      companyId: 'company-1',
      documentId: 'document-1',
      allowedRevisions: [2],
    })).toBeNull();

    const otherTenant = documentView({
      id: 'document-2',
      companyId: 'company-2',
      storageKey: `companies/company-2/documents/document-2/v1/${SHA}.jpg`,
    });
    expect(decodeDocumentViewsForCompany([input], 'company-1')).toEqual([input]);
    expect(decodeDocumentViewsForCompany([input, otherTenant], 'company-1')).toBeNull();
  });

  it('lie la création de dépense au document, au dossier et au tenant demandés', () => {
    const linked = documentView({
      folderId: 'folder-1',
      revision: 3,
      linkedEntityType: 'expense',
      linkedEntityId: 'expense-1',
    });
    const context = {
      companyId: 'company-1',
      documentId: 'document-1',
      targetFolderId: 'folder-1',
      expectedRevision: 1,
    } as const;
    expect(decodeDocumentExpenseCreationForContext({ expenseId: 'expense-1', document: linked }, context))
      .toEqual({ expenseId: 'expense-1', document: linked });
    expect(decodeDocumentExpenseCreationForContext({ expenseId: 'expense-2', document: linked }, context))
      .toBeNull();
    expect(decodeDocumentExpenseCreationForContext({
      expenseId: 'expense-1',
      document: { ...linked, folderId: 'folder-2' },
    }, context)).toBeNull();
    expect(decodeDocumentExpenseCreationForContext({
      expenseId: 'expense-1',
      document: { ...linked, revision: 4 },
    }, context)).toBeNull();
  });

  it('refuse une URL non HTTPS ou un TTL absent/hors bornes', () => {
    const valid = {
      url: 'https://storage.example.test/signed/document-1',
      expiresInSeconds: 300,
      filename: 'ticket.jpg',
      mimeType: 'image/jpeg',
      byteSize: 123,
      sha256: SHA,
    };
    expect(decodeDocumentDownloadUrl(valid)).toEqual(valid);
    expect(decodeDocumentDownloadUrl({ ...valid, url: 'javascript:alert(1)' })).toBeNull();
    expect(decodeDocumentDownloadUrl({ ...valid, expiresInSeconds: undefined })).toBeNull();
    expect(decodeDocumentDownloadUrl({ ...valid, expiresInSeconds: 1 })).toBeNull();
  });

  it('valide les pages de dossiers et les invariants du plan de suppression', () => {
    expect(decodeDocumentFolderPage({ items: [folder()], nextCursor: null }))
      .toEqual({ items: [folder()], nextCursor: null });
    expect(decodeDocumentFolderPage({ items: [{ ...folder(), normalizedName: 'mensonge' }], nextCursor: null }))
      .toBeNull();

    const plan = {
      planId: 'plan-1',
      expiresAt: '2026-07-13T12:05:00.000Z',
      folder: { id: 'folder-1', parentId: null, name: 'Archives', systemKey: null },
      directChildCount: 1,
      descendantFolderCount: 2,
      directDocumentCount: 1,
      documentCount: 3,
      canDeleteEmpty: false,
    };
    expect(decodeDocumentFolderDeletionPlan(plan)).toEqual(plan);
    expect(decodeDocumentFolderDeletionPlan({ ...plan, directChildCount: 3 })).toBeNull();
    expect(decodeDocumentFolderDeletionPlan({ ...plan, canDeleteEmpty: true })).toBeNull();
  });

  it('lie dossiers, pages, plans et mouvements à la requête d’origine', () => {
    expect(decodeDocumentFolderViewForContext(folder(), {
      companyId: 'company-1',
      folderId: 'folder-1',
      parentId: null,
    })).toEqual(folder());
    expect(decodeDocumentFolderViewForContext(folder(), {
      companyId: 'company-2',
      folderId: 'folder-1',
    })).toBeNull();

    expect(decodeDocumentFolderPageForContext({ items: [folder()], nextCursor: null }, {
      companyId: 'company-1',
      parentId: null,
    })).toEqual({ items: [folder()], nextCursor: null });
    expect(decodeDocumentFolderPageForContext({
      items: [folder({ parentId: 'folder-parent' })],
      nextCursor: null,
    }, {
      companyId: 'company-1',
      parentId: null,
    })).toBeNull();

    const plan = {
      planId: 'plan-1',
      expiresAt: '2026-07-13T12:05:00.000Z',
      folder: { id: 'folder-1', parentId: null, name: 'Archives', systemKey: null },
      directChildCount: 0,
      descendantFolderCount: 0,
      directDocumentCount: 0,
      documentCount: 0,
      canDeleteEmpty: true,
    };
    expect(decodeDocumentFolderDeletionPlanForFolder(plan, 'folder-1')).toEqual(plan);
    expect(decodeDocumentFolderDeletionPlanForFolder(plan, 'folder-2')).toBeNull();

    const moved = { documentId: 'document-1', folderId: 'folder-1', revision: 4 };
    expect(decodeDocumentMoveForContext(moved, {
      documentId: 'document-1',
      folderId: 'folder-1',
      expectedRevision: 3,
    })).toEqual(moved);
    expect(decodeDocumentMoveForContext({ ...moved, documentId: 'document-2' }, {
      documentId: 'document-1',
      folderId: 'folder-1',
      expectedRevision: 3,
    })).toBeNull();
  });

  it("réapplique le value object métier à l'analyse et refuse un champ dérivé falsifié", () => {
    const analysis = makeDocumentAnalysis(
      {
        type: 'supplier_invoice',
        typeConfidence: 0.98,
        summary: 'Facture fournisseur Cedeo de 120 euros.',
        facts: [
          {
            key: 'supplier_name',
            valueType: 'text',
            value: 'Cedeo',
            confidence: 0.99,
            provenance: { source: 'document_text', evidence: [], derivedFrom: [], rule: null },
          },
        ],
        suggestedTags: ['cedeo'],
        suggestedFilename: 'facture-cedeo',
        warnings: [],
      },
      {
        documentId: 'document-1',
        documentVersion: 1,
        sourceSha256: SHA,
        originalFilename: 'facture-cedeo.pdf',
        analyzerVersion: 'test-v1',
        analyzedAt: '2026-07-13T12:00:00.000Z',
      },
    );
    expect(analysis.ok).toBe(true);
    if (!analysis.ok) return;
    expect(decodeDocumentAnalysis(analysis.value)).toEqual(analysis.value);
    expect(decodeDocumentAnalysisForDocument(analysis.value, 'document-1')).toEqual(analysis.value);
    expect(decodeDocumentAnalysisForDocument(analysis.value, 'document-2')).toBeNull();
    expect(decodeDocumentAnalysis({ ...analysis.value, requiresHumanReview: !analysis.value.requiresHumanReview }))
      .toBeNull();
  });
});
