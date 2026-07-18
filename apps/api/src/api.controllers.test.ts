import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import {
  DocumentsController,
  ExpensesController,
  HealthController,
  PublicSignatureController,
  QuotesController,
} from './api.controllers';
import type { BackendService } from './backend.service';

describe('HealthController readiness contract', () => {
  it('publie la source IP Railway certifiée sans exposer l’adresse cliente', async () => {
    const railwayId = '01999999-9999-4999-8999-999999999999';
    for (const key of [
      'RAILWAY_PROJECT_ID',
      'RAILWAY_ENVIRONMENT_ID',
      'RAILWAY_SERVICE_ID',
      'RAILWAY_DEPLOYMENT_ID',
      'RAILWAY_REPLICA_ID',
    ]) {
      vi.stubEnv(key, railwayId);
    }
    const backend = {
      readiness: vi.fn(async () => ({ ok: true as const, value: { customers: 4 } })),
    };
    const controller = new HealthController(backend as unknown as BackendService);

    try {
      const response = await controller.ready({
        rawHeaders: ['X-Real-IP', '198.51.100.42'],
        socket: { remoteAddress: '10.0.0.4' },
      });

      expect(response).toMatchObject({
        ready: true,
        customers: 4,
        network: { clientIpSource: 'railway-x-real-ip' },
      });
      expect(response).not.toHaveProperty('network.clientIp');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('QuotesController runtime boundary', () => {
  const validBody = {
    customerId: 'customer-1',
    lines: [
      {
        label: 'Pose chauffe-eau',
        category: 'labor',
        qty: 2,
        unit: 'h',
        unitPriceHT: 8_000,
        vatRate: 10,
      },
    ],
    idempotencyKey: 'mobile-voice:quote:opaque-1',
    context: { housingOlderThan2y: true },
  };

  it.each([null, [], 'quote'])('rejette un body non objet sans appeler le métier (%j)', async (body) => {
    const backend = { createQuote: vi.fn() };
    const controller = new QuotesController(backend as unknown as BackendService);

    await expect(controller.create(body)).rejects.toBeInstanceOf(HttpException);
    expect(backend.createQuote).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...validBody, companyId: 'other-tenant' }, 'body'],
    [{ ...validBody, idempotencyKey: 'bad\nkey' }, 'idempotencyKey'],
    [{ ...validBody, customerId: ' customer-1 ' }, 'customerId'],
    [{ ...validBody, lines: [{ ...validBody.lines[0], qty: 1.2345 }] }, 'lines.0.qty'],
    [{ ...validBody, lines: [{ ...validBody.lines[0], vatRate: 17 }] }, 'lines.0.vatRate'],
    [{ ...validBody, context: { housingOlderThan2y: true, secret: true } }, 'context'],
  ])('rejette un devis malformé ou injecté (%j)', async (body, field) => {
    const backend = { createQuote: vi.fn() };
    const controller = new QuotesController(backend as unknown as BackendService);

    let thrown: unknown;
    try {
      await controller.create(body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(422);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: { kind: 'validation', issues: expect.arrayContaining([expect.objectContaining({ field })]) },
    });
    expect(backend.createQuote).not.toHaveBeenCalled();
  });

  it('reconstruit le DTO autorisé et conserve la clé opaque de rejeu', async () => {
    const value = {
      quoteId: 'quote-1',
      totals: { ht: 16_000, vat: 1_600, ttc: 17_600, netToPay: 17_600, vatByRate: { 10: 1_600 } },
    };
    const backend = { createQuote: vi.fn(async () => ({ ok: true as const, value })) };
    const controller = new QuotesController(backend as unknown as BackendService);

    await expect(controller.create(validBody)).resolves.toEqual(value);
    expect(backend.createQuote).toHaveBeenCalledWith(validBody);
  });

  it.each([
    [undefined, 'body'],
    [{}, 'mode'],
    [{ mode: 'partial' }, 'mode'],
    [{ mode: 'final', companyId: 'other-tenant' }, 'body'],
  ])('rejette une génération de facture ambiguë ou injectée (%j)', async (body, field) => {
    const backend = { generateInvoice: vi.fn() };
    const controller = new QuotesController(backend as unknown as BackendService);

    let thrown: unknown;
    try {
      await controller.invoice('quote-1', body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(422);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: { kind: 'validation', issues: expect.arrayContaining([expect.objectContaining({ field })]) },
    });
    expect(backend.generateInvoice).not.toHaveBeenCalled();
  });

  it('transmet un mode de facture explicite et uniquement ce mode', async () => {
    const backend = {
      generateInvoice: vi.fn(async () => ({ ok: true as const, value: { invoiceId: 'invoice-1' } })),
    };
    const controller = new QuotesController(backend as unknown as BackendService);

    await expect(controller.invoice('quote-1', { mode: 'deposit' })).resolves.toEqual({ invoiceId: 'invoice-1' });
    expect(backend.generateInvoice).toHaveBeenCalledWith({ quoteId: 'quote-1', mode: 'deposit' });
  });

  it.each([
    [null, 'body'],
    [{}, 'signerName'],
    [{ signerName: 'A' }, 'signerName'],
    [{ signerName: 'Mme\nDurand' }, 'signerName'],
    [{ signerName: 'Mme Durand', accepted: true }, 'body'],
    [{ signerName: 'Mme Durand', companyId: 'other-tenant' }, 'body'],
    // R4 : le tracé doit être un dataURL image plausible — jamais un blob arbitraire.
    [{ signerName: 'Mme Durand', proofDataUrl: 42 }, 'proofDataUrl'],
    [{ signerName: 'Mme Durand', proofDataUrl: 'javascript:alert(1)' }, 'proofDataUrl'],
    [{ signerName: 'Mme Durand', proofDataUrl: `data:image/svg+xml;utf8,${'x'.repeat(513_000)}` }, 'proofDataUrl'],
    [{ signerName: 'Mme Durand', proofDataUrl: 'data:image/svg+xml;utf8,\u0000' }, 'proofDataUrl'],
  ])('rejette une signature malformée ou un champ de preuve forgé (%j)', async (body, field) => {
    const backend = { signQuote: vi.fn() };
    const controller = new QuotesController(backend as unknown as BackendService);

    let thrown: unknown;
    try {
      await controller.sign('quote-1', body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(422);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: { kind: 'validation', issues: expect.arrayContaining([expect.objectContaining({ field })]) },
    });
    expect(backend.signQuote).not.toHaveBeenCalled();
  });

  it('normalise le nom du signataire et ne transmet aucun autre champ', async () => {
    const backend = { signQuote: vi.fn(async () => ({ ok: true as const, value: { status: 'signed' } })) };
    const controller = new QuotesController(backend as unknown as BackendService);

    await expect(controller.sign('quote-1', { signerName: '  Mme   Durand  ' })).resolves.toEqual({ status: 'signed' });
    expect(backend.signQuote).toHaveBeenCalledWith({ quoteId: 'quote-1', signerName: 'Mme Durand' });
  });

  it('R4 : transmet le tracé du pad (dataURL) tel quel — le hachage de preuve appartient au backend', async () => {
    const backend = { signQuote: vi.fn(async () => ({ ok: true as const, value: { status: 'signed' } })) };
    const controller = new QuotesController(backend as unknown as BackendService);
    const proofDataUrl = 'data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E';

    await expect(controller.sign('quote-1', { signerName: 'Mme Durand', proofDataUrl })).resolves.toEqual({ status: 'signed' });
    expect(backend.signQuote).toHaveBeenCalledWith({ quoteId: 'quote-1', signerName: 'Mme Durand', proofDataUrl });
  });

  it('P0 R4 : POST :id/signature-link délègue à la commande SANS sortant (jamais sendQuote)', async () => {
    const backend = {
      createQuoteSignatureLink: vi.fn(async () => ({
        ok: true as const,
        value: { signatureUrl: 'https://demo.bobpro.fr/sign/pst_1', expiresAt: '2026-08-14T00:00:00.000Z' },
      })),
      sendQuote: vi.fn(),
    };
    const controller = new QuotesController(backend as unknown as BackendService);

    await expect(controller.createSignatureLink('quote-1')).resolves.toEqual({
      signatureUrl: 'https://demo.bobpro.fr/sign/pst_1',
      expiresAt: '2026-08-14T00:00:00.000Z',
    });
    expect(backend.createQuoteSignatureLink).toHaveBeenCalledWith('quote-1');
    expect(backend.sendQuote).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'body'],
    [{}, 'body'],
    [{ id: 'forged-line' }, 'body'],
    [{ category: 'supply' }, 'body'],
    [{ unit: 'jour' }, 'body'],
    [{ label: null }, 'label'],
    [{ label: '  ' }, 'label'],
    [{ qty: 0 }, 'qty'],
    [{ qty: 1.2345 }, 'qty'],
    [{ unitPriceHT: -1 }, 'unitPriceHT'],
    [{ vatRate: 17 }, 'vatRate'],
  ])('rejette un patch de ligne malformé ou hors autorité (%j)', async (body, field) => {
    const backend = { updateQuoteLine: vi.fn() };
    const controller = new QuotesController(backend as unknown as BackendService);

    let thrown: unknown;
    try {
      await controller.updateLine('quote-1', 'line-1', body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(422);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: { kind: 'validation', issues: expect.arrayContaining([expect.objectContaining({ field })]) },
    });
    expect(backend.updateQuoteLine).not.toHaveBeenCalled();
  });

  it('reconstruit un patch de ligne allowlisté et normalisé', async () => {
    const backend = {
      updateQuoteLine: vi.fn(async () => ({ ok: true as const, value: { status: 'draft' } })),
    };
    const controller = new QuotesController(backend as unknown as BackendService);

    await expect(controller.updateLine('quote-1', 'line-1', {
      label: '  Pose chauffe-eau  ',
      qty: 2.5,
      unitPriceHT: 45_000,
      vatRate: 10,
    })).resolves.toEqual({ status: 'draft' });
    expect(backend.updateQuoteLine).toHaveBeenCalledWith({
      quoteId: 'quote-1',
      lineId: 'line-1',
      patch: { label: 'Pose chauffe-eau', qty: 2.5, unitPriceHT: 45_000, vatRate: 10 },
    });
  });
});

describe('PublicSignatureController runtime boundary', () => {
  it.each([
    [null, 'body'],
    [[], 'body'],
    [{}, 'signerName'],
    [{ signerName: 'A' }, 'signerName'],
    [{ signerName: 'Mme\u202e Durand' }, 'signerName'],
    [{ signerName: 'Mme Durand', accepted: true }, 'body'],
    [{ signerName: 'Mme Durand', companyId: 'other-tenant' }, 'body'],
  ])('rejette un body public malformé ou une preuve forgée (%j)', async (body, field) => {
    const backend = { publicSignQuote: vi.fn() };
    const controller = new PublicSignatureController(backend as unknown as BackendService);

    let thrown: unknown;
    try {
      await controller.sign('opaque-token', body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(422);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: { kind: 'validation', issues: expect.arrayContaining([expect.objectContaining({ field })]) },
    });
    expect(backend.publicSignQuote).not.toHaveBeenCalled();
  });

  it('normalise la seule donnée autorisée avant la signature publique', async () => {
    const backend = {
      publicSignQuote: vi.fn(async () => ({ ok: true as const, value: { status: 'signed' } })),
    };
    const controller = new PublicSignatureController(backend as unknown as BackendService);

    await expect(controller.sign('opaque-token', { signerName: '  Mme   Durand  ' })).resolves.toEqual({ status: 'signed' });
    expect(backend.publicSignQuote).toHaveBeenCalledWith('opaque-token', 'Mme Durand', undefined);
  });

  it('R4 : la voie publique transmet aussi un tracé optionnel (dataURL) — hash côté backend', async () => {
    const backend = {
      publicSignQuote: vi.fn(async () => ({ ok: true as const, value: { status: 'signed' } })),
    };
    const controller = new PublicSignatureController(backend as unknown as BackendService);
    const proofDataUrl = 'data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E';

    await expect(controller.sign('opaque-token', { signerName: 'Mme Durand', proofDataUrl })).resolves.toEqual({ status: 'signed' });
    expect(backend.publicSignQuote).toHaveBeenCalledWith('opaque-token', 'Mme Durand', proofDataUrl);
  });
});

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
    // La PREUVE du règlement est l'original archivé, sous autorité serveur : la désigner est un contrat forgé.
    [{ expectedRevision: 1, targetFolderId: 'folder-1', expense: { ...validExpense, payment: { paidOn: '2026-07-13', method: 'card', proofDocumentId: 'doc-x' } } }, 'payment'],
    [{ expectedRevision: 1, targetFolderId: 'folder-1', expense: { ...validExpense, payment: { paidOn: '2026-07-13', method: 'cheque' } } }, 'payment.method'],
    [{ expectedRevision: 1, targetFolderId: 'folder-1', expense: { ...validExpense, payment: { paidOn: '13/07/2026', method: 'card' } } }, 'payment.paidOn'],
    [{ expectedRevision: 1, targetFolderId: 'folder-1', expense: { ...validExpense, payment: 'paid' } }, 'payment'],
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

  it('accepte un règlement déclaré (ticket déjà payé) limité à date + moyen', async () => {
    const backend = {
      recordDocumentExpense: vi.fn(async () => ({
        ok: true as const,
        value: { expenseId: 'expense-1', document: { id: 'document-1' } },
      })),
    };
    const controller = new DocumentsController(backend as unknown as BackendService);

    await controller.recordExpenseFromDocument('document-1', {
      expectedRevision: 3,
      targetFolderId: 'folder-purchases',
      expense: { ...validExpense, payment: { paidOn: '2026-07-13', method: 'card' } },
    });
    expect(backend.recordDocumentExpense).toHaveBeenCalledWith({
      documentId: 'document-1',
      expectedRevision: 3,
      targetFolderId: 'folder-purchases',
      expense: { ...validExpense, payment: { paidOn: '2026-07-13', method: 'card' } },
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

describe('DocumentsController B9 — GET /documents/search & /documents/suggest', () => {
  it('q/from/to/customerId/status/cursor absents -> query vide + scope "all", aucun champ optionnel forgé', async () => {
    const backend = { searchSalesDocuments: vi.fn(async () => ({ ok: true as const, value: { hits: [], totalCount: 0, nextCursor: null } })) };
    const controller = new DocumentsController(backend as unknown as BackendService);

    await controller.search();

    expect(backend.searchSalesDocuments).toHaveBeenCalledWith({ query: '', scope: 'all' });
  });

  it('type=quote/invoice est transmis tel quel ; toute autre valeur (y compris absente/forgée) retombe sur "all"', async () => {
    const backend = { searchSalesDocuments: vi.fn(async () => ({ ok: true as const, value: { hits: [], totalCount: 0, nextCursor: null } })) };
    const controller = new DocumentsController(backend as unknown as BackendService);

    await controller.search(undefined, 'quote');
    expect(backend.searchSalesDocuments).toHaveBeenLastCalledWith({ query: '', scope: 'quote' });
    await controller.search(undefined, 'invoice');
    expect(backend.searchSalesDocuments).toHaveBeenLastCalledWith({ query: '', scope: 'invoice' });
    await controller.search(undefined, 'not-a-real-scope');
    expect(backend.searchSalesDocuments).toHaveBeenLastCalledWith({ query: '', scope: 'all' });
  });

  it('transmet q/from/to/customerId/status/cursor fournis et convertit limit en nombre', async () => {
    const backend = { searchSalesDocuments: vi.fn(async () => ({ ok: true as const, value: { hits: [], totalCount: 0, nextCursor: null } })) };
    const controller = new DocumentsController(backend as unknown as BackendService);

    await controller.search('sevres', 'all', '2026-06-01', '2026-06-30', 'cust-1', 'signed', '20', '10');

    expect(backend.searchSalesDocuments).toHaveBeenCalledWith({
      query: 'sevres',
      scope: 'all',
      from: '2026-06-01',
      to: '2026-06-30',
      customerId: 'cust-1',
      status: 'signed',
      cursor: '20',
      limit: 10,
    });
  });

  it('déballe le Result via unwrap (succès comme échec de validation)', async () => {
    const backend = {
      searchSalesDocuments: vi.fn(async () => ({
        ok: false as const,
        error: { kind: 'validation' as const, issues: [{ field: 'to', message: 'invalide' }] },
      })),
    };
    const controller = new DocumentsController(backend as unknown as BackendService);

    let thrown: unknown;
    try {
      await controller.search(undefined, 'all', '2026-08-01', '2026-07-01');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(422);
  });

  it('suggest : q absent -> query vide, transmis tel quel sinon', async () => {
    const backend = { suggestSalesDocuments: vi.fn(async () => ({ ok: true as const, value: { suggestions: [] } })) };
    const controller = new DocumentsController(backend as unknown as BackendService);

    await controller.suggest();
    expect(backend.suggestSalesDocuments).toHaveBeenCalledWith({ query: '' });
    await controller.suggest('mart');
    expect(backend.suggestSalesDocuments).toHaveBeenCalledWith({ query: 'mart' });
  });
});
