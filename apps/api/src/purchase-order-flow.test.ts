import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InvoicePdfData, OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { QuotesController, InvoicesController } from './api.controllers';
import { PdfRenderer } from './documents/pdf-renderer';
import { pdfVisibleText } from './documents/pdf-text.testing';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { RelanceService } from './jobs/relance.service';
import type { Metrics } from './observability/metrics';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { InMemoryPersistence } from './persistence/persistence.testing';

/**
 * B8 — bon de commande grands comptes (numéro d'engagement RATP/collectivités/majors du BTP) :
 * flow serveur complet. Le numéro est saisi UNE FOIS sur le devis, repris AUTOMATIQUEMENT sur la
 * facture dérivée (Invoice.fromSignedQuote via GenerateInvoiceFromQuote), figé à l'émission, et
 * la mention « Bon de commande n° … » figure sur le PDF émis (exigence de paiement + Chorus Pro).
 */

const OWNER: Principal = { userId: 'owner-po', companyId: MERCIER_PROPS.id };

afterEach(() => {
  vi.unstubAllEnvs();
});

function asOwner<T>(run: () => T): T {
  return requestContext.run({ correlationId: 'purchase-order-flow', principal: OWNER }, run);
}

function makeService() {
  const persistence = new InMemoryPersistence();
  const rendered: InvoicePdfData[] = [];
  const renderer: PdfRendererPort = {
    renderInvoice: vi.fn(async (data) => {
      rendered.push(structuredClone(data));
      return new TextEncoder().encode(`%PDF-1.7\narchive:${data.number}`);
    }),
    renderQuote: vi.fn(async (data) => new TextEncoder().encode(`%PDF-1.7\nquote:${data.number}`)),
  };
  const notificationDelivery = {
    enqueue: vi.fn(async (input: { notification: unknown }) => ({
      id: 'notification-job-po',
      status: 'pending',
      notification: input.notification,
    })),
    tryDeliver: vi.fn(async () => true),
  } as unknown as NotificationDeliveryService;
  const audit = vi.fn();
  const logger = {
    audit,
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
  } as unknown as AppLogger;
  const metrics = {
    aiRequests: { inc: vi.fn() },
    aiDuration: { observe: vi.fn() },
    aiGuardViolations: { inc: vi.fn() },
  } as unknown as Metrics;
  const storage = new InMemoryDocumentStorage();
  const service = new BackendService(
    persistence,
    {} as PaymentGatewayPort,
    renderer,
    {} as OcrPort,
    { setUserCompanyId: vi.fn(), deleteUser: vi.fn() },
    notificationDelivery,
    metrics,
    logger,
    undefined,
    storage,
  );
  return { persistence, rendered, renderer, service, storage, audit };
}

async function signedQuoteId(service: BackendService): Promise<string> {
  const quote = await service.createQuote({
    customerId: 'cust-martin',
    lines: [
      { label: 'Rénovation hall d’accueil', category: 'labor', qty: 1, unitPriceHT: 250_000, vatRate: 20 },
    ],
  });
  if (!quote.ok) throw new Error('createQuote failed');
  const sent = await service.sendQuote(quote.value.quoteId);
  if (!sent.ok) throw new Error('sendQuote failed');
  const signed = await service.signQuote({
    quoteId: quote.value.quoteId,
    signerName: 'Mme Responsable Achats',
  });
  if (!signed.ok) throw new Error('signQuote failed');
  return quote.value.quoteId;
}

describe('B8 — flow serveur bon de commande (devis → facture → PDF émis)', () => {
  it('attache sur devis signé, reprend sur la facture dérivée et imprime la mention à l’émission', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, rendered, service, audit } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await signedQuoteId(service);

      // Attache (révision 1 → 2) : numéro assaini par le domaine, audit tracé.
      const attached = await service.attachQuotePurchaseOrder({
        quoteId,
        purchaseOrder: { number: 'BC-RATP-4712', receivedAt: '2026-07-10T00:00:00.000Z' },
        expectedRevision: 1,
      });
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      expect(attached.value).toMatchObject({ targetType: 'quote', targetId: quoteId, revision: 2 });
      expect(audit).toHaveBeenCalledWith('quote.purchase_order_attached', {
        quoteId,
        number: 'BC-RATP-4712',
        revision: 2,
      });

      // La vue devis expose bon de commande + révision (contrat clients).
      const quoteView = await service.getQuote(quoteId);
      expect(quoteView.ok && quoteView.value.purchaseOrder?.number).toBe('BC-RATP-4712');
      expect(quoteView.ok && quoteView.value.revision).toBe(2);

      // Reprise AUTOMATIQUE devis → facture (chemin d'émission serveur réel).
      const generated = await service.generateInvoice({ quoteId, mode: 'final' });
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;
      const invoiceView = await service.getInvoice(generated.value.invoiceId);
      expect(invoiceView.ok && invoiceView.value.purchaseOrder?.number).toBe('BC-RATP-4712');
      expect(invoiceView.ok && invoiceView.value.revision).toBe(1);

      // Devis déjà facturé : la mutation côté devis est refusée (la facture est la source).
      const redirected = await service.attachQuotePurchaseOrder({
        quoteId,
        purchaseOrder: { number: 'BC-AUTRE' },
        expectedRevision: 2,
      });
      expect(redirected.ok).toBe(false);
      if (redirected.ok) return;
      expect(redirected.error.kind).toBe('conflict');

      // Émission : le PDF (archivé immuable) porte le numéro d'engagement.
      const issued = await service.issueInvoice({ invoiceId: generated.value.invoiceId });
      expect(issued.ok).toBe(true);
      const emitted = rendered.find((data) => data.kind === 'final' || data.kind === 'invoice');
      expect(emitted).toBeDefined();
      expect(emitted?.purchaseOrder).toEqual({
        number: 'BC-RATP-4712',
        receivedAt: '2026-07-10T00:00:00.000Z',
      });

      // Après émission : la référence légale est figée (domaine + trigger SQL en prod).
      const frozen = await service.attachInvoicePurchaseOrder({
        invoiceId: generated.value.invoiceId,
        purchaseOrder: { number: 'BC-TROP-TARD' },
        expectedRevision: 1,
      });
      expect(frozen.ok).toBe(false);
    });
  });

  it('facture directe (brouillon) : attache/retrait explicites, révision optimiste, audit', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service, audit } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await signedQuoteId(service);
      const generated = await service.generateInvoice({ quoteId, mode: 'final' });
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;
      const invoiceId = generated.value.invoiceId;

      // Attache directement sur la facture BROUILLON (parcours facture directe).
      const attached = await service.attachInvoicePurchaseOrder({
        invoiceId,
        purchaseOrder: { number: 'BC-VILLE-2026-88' },
        expectedRevision: 1,
      });
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      expect(attached.value).toMatchObject({ targetType: 'invoice', targetId: invoiceId, revision: 2 });
      expect(audit).toHaveBeenCalledWith('invoice.purchase_order_attached', {
        invoiceId,
        number: 'BC-VILLE-2026-88',
        revision: 2,
      });

      // Révision périmée ⇒ conflit, l'état courant est conservé.
      const stale = await service.attachInvoicePurchaseOrder({
        invoiceId,
        purchaseOrder: { number: 'BC-PERDANT' },
        expectedRevision: 1,
      });
      expect(stale.ok).toBe(false);
      if (stale.ok) return;
      expect(stale.error.kind).toBe('conflict');

      // Retrait explicite (brouillon uniquement) — audit dédié.
      const detached = await service.detachInvoicePurchaseOrder({ invoiceId, expectedRevision: 2 });
      expect(detached.ok).toBe(true);
      if (!detached.ok) return;
      expect(detached.value.purchaseOrder).toBeNull();
      expect(audit).toHaveBeenCalledWith('invoice.purchase_order_detached', {
        invoiceId,
        revision: 3,
      });
    });
  });

  it('anti-IDOR : un documentId inconnu du tenant est refusé AVANT le domaine', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await signedQuoteId(service);
      const rejected = await service.attachQuotePurchaseOrder({
        quoteId,
        purchaseOrder: { number: 'BC-1', documentId: 'doc-d-un-autre-tenant' },
        expectedRevision: 1,
      });
      expect(rejected).toEqual({
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'documentId', message: 'Document de bon de commande introuvable.' }],
        },
      });

      // Un document RÉEL du tenant est accepté et archivé dans la référence.
      const intake = await service.createDocumentIntake({
        contentBase64: '/9j/2Q==',
        mimeType: 'image/jpeg',
        filename: 'bon-de-commande.jpg',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      });
      expect(intake.ok).toBe(true);
      if (!intake.ok) return;
      const attached = await service.attachQuotePurchaseOrder({
        quoteId,
        purchaseOrder: { number: 'BC-1', documentId: intake.value.id },
        expectedRevision: 1,
      });
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      expect(attached.value.purchaseOrder?.documentId).toBe(intake.value.id);
    });
  });

  it('tenant scoping strict : un devis inconnu du tenant courant reste invisible (not_found)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const rejected = await service.attachQuotePurchaseOrder({
        quoteId: 'quote-d-un-autre-tenant',
        purchaseOrder: { number: 'BC-1' },
        expectedRevision: 1,
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) return;
      expect(rejected.error.kind).toBe('not_found');
    });
  });
});

describe('B8 — contrôleurs (allowlist stricte + délégation exacte)', () => {
  function quotesController(overrides: Partial<BackendService> = {}) {
    return new QuotesController(overrides as BackendService);
  }
  function invoicesController(overrides: Partial<BackendService> = {}) {
    return new InvoicesController(overrides as BackendService, {} as RelanceService);
  }

  it('PUT /quotes/:id/purchase-order : corps plat exact, date de réception normalisée en ISO', async () => {
    const attachQuotePurchaseOrder = vi.fn(async () => ({
      ok: true as const,
      value: { targetType: 'quote', targetId: 'q-1', revision: 2, purchaseOrder: null },
    }));
    const controller = quotesController({ attachQuotePurchaseOrder } as never);
    await controller.attachPurchaseOrder('q-1', {
      number: 'BC-1',
      receivedAt: '2026-07-10T12:00:00+02:00',
      expectedRevision: 1,
    });
    expect(attachQuotePurchaseOrder).toHaveBeenCalledWith({
      quoteId: 'q-1',
      purchaseOrder: { number: 'BC-1', receivedAt: '2026-07-10T10:00:00.000Z', documentId: null },
      expectedRevision: 1,
    });
  });

  it('refuse un champ non autorisé et une révision invalide AVANT le domaine', async () => {
    const attachQuotePurchaseOrder = vi.fn();
    const controller = quotesController({ attachQuotePurchaseOrder } as never);
    await expect(
      controller.attachPurchaseOrder('q-1', { number: 'BC-1', companyId: 'autre', expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      controller.attachPurchaseOrder('q-1', { number: 'BC-1', expectedRevision: 0 }),
    ).rejects.toMatchObject({ status: 422 });
    expect(attachQuotePurchaseOrder).not.toHaveBeenCalled();
  });

  it('DELETE /invoices/:id/purchase-order : seule la révision optimiste voyage', async () => {
    const detachInvoicePurchaseOrder = vi.fn(async () => ({
      ok: true as const,
      value: { targetType: 'invoice', targetId: 'inv-1', revision: 3, purchaseOrder: null },
    }));
    const controller = invoicesController({ detachInvoicePurchaseOrder } as never);
    await controller.detachPurchaseOrder('inv-1', { expectedRevision: 2 });
    expect(detachInvoicePurchaseOrder).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      expectedRevision: 2,
    });
    const detachRejects = vi.fn();
    const strict = invoicesController({ detachInvoicePurchaseOrder: detachRejects } as never);
    await expect(
      strict.detachPurchaseOrder('inv-1', { expectedRevision: 2, extra: true }),
    ).rejects.toMatchObject({ status: 422 });
    expect(detachRejects).not.toHaveBeenCalled();
  });
});

describe('B8 — PdfRenderer : mention sobre dans la zone références', () => {
  const baseData: InvoicePdfData = {
    number: 'F-2026-0042',
    companyName: 'Mercier Plomberie',
    companyAddress: '12 rue des Artisans, 92310 Sèvres',
    companyRcsOrRm: null,
    customerName: 'RATP',
    customerAddress: '54 quai de la Rapée, 75012 Paris',
    issuedAt: '2026-07-19',
    dueAt: '2026-08-18',
    kind: 'final',
    lines: [{ label: 'Prestation', qty: 1, unitPriceHT: 100_000, vatRate: 20 }],
    totals: { ht: 100_000, vat: 20_000, ttc: 120_000, netToPay: 120_000 },
    mentions: ['Mention légale'],
    billingPresentation: { accentColor: 'navy', rib: null, insurance: null },
  };

  // Texte visible du PDF : helper d'extraction partagé (ToUnicode-aware) — ./documents/pdf-text.testing.

  it('imprime « Bon de commande n° … du … » quand la référence est présente', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseData,
      purchaseOrder: { number: 'BC-RATP-4712', receivedAt: '2026-07-10T00:00:00.000Z' },
    });
    const text = await pdfVisibleText(bytes);
    expect(text).toContain('Bon de commande n');
    expect(text).toContain('BC-RATP-4712');
    expect(text).toContain('du 2026-07-10');
  });

  it('n’imprime AUCUNE mention sans bon de commande (compat pièces existantes)', async () => {
    const bytes = await new PdfRenderer().renderInvoice({ ...baseData, purchaseOrder: null });
    expect(await pdfVisibleText(bytes)).not.toContain('Bon de commande');
  });
});
