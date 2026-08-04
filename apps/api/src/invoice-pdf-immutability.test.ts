import { afterEach, describe, expect, it, vi } from 'vitest';
import { Document, IssueInvoice } from '@bob/core';
import type { InvoicePdfData, OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import { renderPdfFixture } from './documents/pdf-fixtures.testing';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { InMemoryPersistence } from './persistence/persistence.testing';

const OWNER: Principal = { userId: 'owner-pdf', companyId: MERCIER_PROPS.id };

afterEach(() => {
  vi.unstubAllEnvs();
});

function asOwner<T>(run: () => T): T {
  return requestContext.run({ correlationId: 'invoice-pdf-immutability', principal: OWNER }, run);
}

function makeService() {
  const persistence = new InMemoryPersistence();
  const rendered: InvoicePdfData[] = [];
  const renderer: PdfRendererPort = {
    renderInvoice: vi.fn(async (data, facturX) => {
      rendered.push(structuredClone(data));
      return renderPdfFixture(
        `archive:${data.number}:${data.billingPresentation.accentColor}`,
        facturX?.xml,
      );
    }),
    renderQuote: vi.fn(async (data) => renderPdfFixture(`quote:${data.number}`)),
  };
  const notificationDelivery = {
    enqueue: vi.fn(async (input: { notification: unknown }) => ({
      id: 'notification-job-pdf',
      status: 'pending',
      notification: input.notification,
    })),
    tryDeliver: vi.fn(async () => true),
  } as unknown as NotificationDeliveryService;
  const logger = {
    audit: vi.fn(),
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
  return { persistence, rendered, renderer, service, storage };
}

async function prepareFinalInvoice(service: BackendService): Promise<string> {
  const quote = await service.createQuote({
    customerId: 'cust-martin',
    lines: [
      {
        label: 'Prestation archivée',
        category: 'labor',
        qty: 1,
        unitPriceHT: 125_000,
        vatRate: 20,
      },
    ],
  });
  if (!quote.ok) throw new Error('createQuote failed');
  const sent = await service.sendQuote(quote.value.quoteId);
  if (!sent.ok) throw new Error('sendQuote failed');
  const signed = await service.signQuote({
    quoteId: quote.value.quoteId,
    signerName: 'Client archive',
  });
  if (!signed.ok) throw new Error('signQuote failed');
  const signedArchive = await service.runDocumentArchiveJobs({ limit: 50 });
  if (!signedArchive.ok || signedArchive.value.failed !== 0) {
    throw new Error('signed quote archive worker failed');
  }
  const generated = await service.generateInvoice({ quoteId: quote.value.quoteId, mode: 'final' });
  if (!generated.ok) throw new Error('generateInvoice failed');
  return generated.value.invoiceId;
}

async function issueInvoice(service: BackendService): Promise<string> {
  const invoiceId = await prepareFinalInvoice(service);
  const issued = await service.issueInvoice({ invoiceId });
  if (!issued.ok) throw new Error('issueInvoice failed');
  const archived = await service.runDocumentArchiveJobs({ limit: 50 });
  if (!archived.ok || archived.value.failed !== 0) throw new Error('archive worker failed');
  return invoiceId;
}

describe('facture PDF émise — original immuable', () => {
  it('refuse l’émission quand aucun délai réel n’est confirmé en BDD', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderer, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const settings = await service.getCompanyBillingSettings();
      expect(settings.ok).toBe(true);
      if (!settings.ok) return;
      const cleared = await service.updateCompanyBillingSettings({
        expectedRevision: settings.value.revision,
        patch: { defaultInvoicePaymentTermsDays: null },
      });
      expect(cleared.ok).toBe(true);

      const invoiceId = await prepareFinalInvoice(service);
      await expect(service.issueInvoice({ invoiceId })).resolves.toEqual({
        ok: false,
        error: {
          kind: 'validation',
          issues: [
            {
              field: 'paymentTerms',
              message: 'Choisissez vos conditions de paiement avant d’émettre cette facture.',
            },
          ],
        },
      });
      expect((await persistence.invoices.findById(invoiceId))?.number).toBeNull();
      expect(renderer.renderInvoice).not.toHaveBeenCalled();
    });
  });

  it('rejoue une facture déjà émise même si les conditions courantes ont ensuite été effacées', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderer, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const invoiceId = await prepareFinalInvoice(service);
      const first = await service.issueInvoice({ invoiceId });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      await service.runDocumentArchiveJobs({ limit: 50 });

      const settings = await service.getCompanyBillingSettings();
      expect(settings.ok).toBe(true);
      if (!settings.ok) return;
      const cleared = await service.updateCompanyBillingSettings({
        expectedRevision: settings.value.revision,
        patch: { defaultInvoicePaymentTermsDays: null },
      });
      expect(cleared.ok).toBe(true);

      const replay = await service.issueInvoice({ invoiceId });

      expect(replay).toEqual(first);
      expect(renderer.renderInvoice).toHaveBeenCalledTimes(1);
      const entries = await persistence.accountingEntries.listByCompany(MERCIER_PROPS.id);
      expect(entries.filter((entry) => entry.sourceId === invoiceId)).toHaveLength(1);
    });
  });

  it('prend le fence Company avant toute lecture des conditions de paiement', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const invoiceId = await prepareFinalInvoice(service);
      const events: string[] = [];
      const originalCompanyLock = persistence.companies.lockForShareById.bind(
        persistence.companies,
      );
      const originalSettingsRead = persistence.billingSettings.findByCompanyId.bind(
        persistence.billingSettings,
      );
      vi.spyOn(persistence.companies, 'lockForShareById').mockImplementation(async (companyId) => {
        events.push('company:share');
        return originalCompanyLock(companyId);
      });
      vi.spyOn(persistence.billingSettings, 'findByCompanyId').mockImplementation(
        async (companyId) => {
          events.push('billing-settings:read');
          return originalSettingsRead(companyId);
        },
      );

      const issued = await service.issueInvoice({ invoiceId });

      expect(issued.ok).toBe(true);
      expect(events.slice(0, 2)).toEqual(['company:share', 'billing-settings:read']);
    });
  });

  it('reste idempotent si une émission concurrente gagne pendant la lecture de réglages absents', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderer, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const invoiceId = await prepareFinalInvoice(service);
      vi.spyOn(persistence.billingSettings, 'findByCompanyId').mockImplementationOnce(async () => {
        const concurrent = await new IssueInvoice({
          invoices: persistence.invoices,
          companies: persistence.companies,
          customers: persistence.customers,
          quotes: persistence.quotes,
          counters: persistence.counters,
          uow: persistence,
          clock: {
            now: () => '2026-06-30T10:00:00.000Z',
            today: () => '2026-06-30',
          },
        }).execute({
          invoiceId,
          terms: { days: 30, endOfMonth: false, label: 'Paiement à 30 jours' },
        });
        expect(concurrent.ok).toBe(true);
        return null;
      });

      const replay = await service.issueInvoice({ invoiceId });

      expect(replay.ok).toBe(true);
      await service.runDocumentArchiveJobs({ limit: 50 });
      expect(renderer.renderInvoice).toHaveBeenCalledTimes(1);
      const entries = await persistence.accountingEntries.listByCompany(MERCIER_PROPS.id);
      expect(entries.filter((entry) => entry.sourceId === invoiceId)).toHaveLength(1);
    });
  });

  it('sert exactement les octets archivés malgré un réglage ultérieur et refuse toute archive ambiguë ou corrompue', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, rendered, renderer, service, storage } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const invoiceId = await issueInvoice(service);
      expect(renderer.renderInvoice).toHaveBeenCalledTimes(1);
      expect(rendered[0]?.billingPresentation).toEqual({
        accentColor: 'navy',
        rib: null,
        insurance: MERCIER_PROPS.decennale,
      });

      const documents = await persistence.documents.findByEntity(
        MERCIER_PROPS.id,
        'invoice',
        invoiceId,
      );
      const pdfDocument = documents.find((document) => document.kind === 'invoice_pdf');
      expect(pdfDocument).toBeDefined();
      if (pdfDocument === undefined) return;
      const original = await storage.get(MERCIER_PROPS.id, pdfDocument.storageKey);
      expect(original).not.toBeNull();
      if (original === null) return;

      const settings = await service.getCompanyBillingSettings();
      expect(settings.ok).toBe(true);
      if (!settings.ok) return;
      const changed = await service.updateCompanyBillingSettings({
        expectedRevision: settings.value.revision,
        patch: { pdfAccentColor: 'purple', showRibOnInvoices: true },
      });
      expect(changed.ok && changed.value.pdfAccentColor).toBe('purple');

      const downloaded = await service.invoicePdf(invoiceId);
      expect(downloaded.ok).toBe(true);
      if (!downloaded.ok) return;
      expect(downloaded.value).toEqual(original.bytes);
      expect(renderer.renderInvoice).toHaveBeenCalledTimes(1);

      // Métadonnée de taille corrompue : le SHA reste identique mais le GET échoue fermé.
      const originalProps = pdfDocument.toProps();
      persistence.documents.forceReplaceForTesting(
        Document.rehydrate({
          ...originalProps,
          byteSize: originalProps.byteSize + 1,
          versions: originalProps.versions.map((version) =>
            version.version === Math.max(...originalProps.versions.map((item) => item.version))
              ? { ...version, byteSize: version.byteSize + 1 }
              : version,
          ),
        }),
      );
      await expect(service.invoicePdf(invoiceId)).resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'invoice-archive' },
      });
      persistence.documents.forceReplaceForTesting(Document.rehydrate(originalProps));

      // Octets altérés à taille identique : le contrôle SHA refuse l'objet.
      const corruptedBytes = new Uint8Array(original.bytes);
      corruptedBytes[corruptedBytes.length - 1] = (corruptedBytes.at(-1) ?? 0) ^ 1;
      await storage.remove(MERCIER_PROPS.id, pdfDocument.storageKey);
      await storage.put({
        companyId: MERCIER_PROPS.id,
        key: pdfDocument.storageKey,
        bytes: corruptedBytes,
        contentType: 'application/pdf',
      });
      await expect(service.invoicePdf(invoiceId)).resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'invoice-archive' },
      });

      // Objet absent : aucune régénération opportuniste avec les nouveaux réglages.
      await storage.remove(MERCIER_PROPS.id, pdfDocument.storageKey);
      await expect(service.invoicePdf(invoiceId)).resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'invoice-archive' },
      });
      await storage.put({
        companyId: MERCIER_PROPS.id,
        key: pdfDocument.storageKey,
        bytes: original.bytes,
        contentType: 'application/pdf',
      });

      // Deux originaux actifs liés à la même facture : le GET refuse l'ambiguïté, quel que soit
      // l'ordre de retour du repository.
      const duplicate = await service.uploadDocument({
        contentBase64: Buffer.from(original.bytes).toString('base64'),
        mimeType: 'application/pdf',
        filename: 'copie-facture.pdf',
        kind: 'invoice_pdf',
        linkedEntityType: 'invoice',
        linkedEntityId: invoiceId,
      });
      expect(duplicate.ok).toBe(true);
      await expect(service.invoicePdf(invoiceId)).resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'invoice-archive' },
      });
      expect(renderer.renderInvoice).toHaveBeenCalledTimes(1);
    });
  });

  it('rollback émission, numéro et comptabilité si l’outbox d’archive ne peut pas être écrite', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderer, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const invoiceId = await prepareFinalInvoice(service);
      vi.spyOn(persistence.documentArchiveJobs, 'enqueue').mockRejectedValueOnce(
        new Error('postgres unavailable'),
      );

      const failed = await service.issueInvoice({ invoiceId });
      expect(failed).toEqual({
        ok: false,
        error: {
          kind: 'dependency',
          port: 'document-archive-outbox',
          cause: 'postgres unavailable',
        },
      });
      const rolledBack = await persistence.invoices.findById(invoiceId);
      expect(rolledBack?.number).toBeNull();
      expect(rolledBack?.issuedAt).toBeNull();
      expect(await persistence.accountingEntries.listByCompany(MERCIER_PROPS.id)).toHaveLength(0);
      expect(
        await persistence.documentArchiveJobs.listDue(
          MERCIER_PROPS.id,
          '9999-12-31T23:59:59.999Z',
          10,
        ),
      ).toHaveLength(0);
      expect(renderer.renderInvoice).not.toHaveBeenCalled();

      const retry = await service.issueInvoice({ invoiceId });
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      await service.runDocumentArchiveJobs({ limit: 50 });
      expect(retry.value.number).toMatch(/^F-\d{4}-0001$/u);
      expect(renderer.renderInvoice).toHaveBeenCalledTimes(1);
      const persisted = await persistence.invoices.findById(invoiceId);
      expect(persisted?.number).toBe(retry.value.number);
      expect(await persistence.accountingEntries.listByCompany(MERCIER_PROPS.id)).toHaveLength(1);
    });
  });
});
