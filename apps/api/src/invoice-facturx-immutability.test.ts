import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Document } from '@bob/core';
import type { InvoicePdfData, OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { documentSha256 } from './documents/storage';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import { renderPdfFixture } from './documents/pdf-fixtures.testing';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { InMemoryPersistence } from './persistence/persistence.testing';

const OWNER: Principal = { userId: 'owner-facturx', companyId: MERCIER_PROPS.id };

function asOwner<T>(run: () => T): T {
  return requestContext.run({ correlationId: 'invoice-facturx-immutability', principal: OWNER }, run);
}

class ProofCorruptingStorage extends InMemoryDocumentStorage {
  private targetMimeType: string | null = null;
  private targetReads = 0;

  arm(targetMimeType: 'application/pdf' | 'application/xml'): void {
    this.targetMimeType = targetMimeType;
    this.targetReads = 0;
  }

  override async get(companyId: string, key: string) {
    const stored = await super.get(companyId, key);
    if (stored === null || stored.contentType !== this.targetMimeType) return stored;
    this.targetReads += 1;
    if (this.targetReads !== 2) return stored;
    const bytes = new Uint8Array(stored.bytes);
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
    return {
      ...stored,
      bytes,
      sha256: documentSha256(bytes),
    };
  }
}

function makeService() {
  const persistence = new InMemoryPersistence();
  const rendered: InvoicePdfData[] = [];
  const renderer: PdfRendererPort = {
    renderInvoice: vi.fn(async (data, facturX) => {
      rendered.push(structuredClone(data));
      return renderPdfFixture(`archive:${data.number}`, facturX?.xml);
    }),
    renderQuote: vi.fn(async (data) => renderPdfFixture(`quote:${data.number}`)),
  };
  const notificationDelivery = {
    enqueue: vi.fn(async (input: { notification: unknown }) => ({
      id: 'notification-job-facturx',
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
  const storage = new ProofCorruptingStorage();
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
  return { audit, persistence, renderer, service, storage };
}

async function prepareInvoice(service: BackendService): Promise<string> {
  const quote = await service.createQuote({
    customerId: 'cust-martin',
    lines: [
      {
        label: 'Prestation XML archivée',
        category: 'labor',
        qty: 1,
        unitPriceHT: 125_000,
        vatRate: 20,
      },
    ],
  });
  if (!quote.ok) throw new Error('createQuote failed');
  if (!(await service.sendQuote(quote.value.quoteId)).ok) throw new Error('sendQuote failed');
  if (!(await service.signQuote({ quoteId: quote.value.quoteId, signerName: 'Client archive' })).ok)
    throw new Error('signQuote failed');
  const signedArchive = await service.runDocumentArchiveJobs({ limit: 50 });
  if (!signedArchive.ok || signedArchive.value.failed !== 0) {
    throw new Error('signed quote archive worker failed');
  }
  const generated = await service.generateInvoice({ quoteId: quote.value.quoteId, mode: 'final' });
  if (!generated.ok) throw new Error('generateInvoice failed');
  return generated.value.invoiceId;
}

async function issueInvoice(service: BackendService): Promise<string> {
  const invoiceId = await prepareInvoice(service);
  if (!(await service.issueInvoice({ invoiceId })).ok)
    throw new Error('issueInvoice failed');
  const archived = await service.runDocumentArchiveJobs({ limit: 50 });
  if (!archived.ok || archived.value.failed !== 0) throw new Error('archive worker failed');
  return invoiceId;
}

async function archivedXml(
  persistence: InMemoryPersistence,
  storage: InMemoryDocumentStorage,
  invoiceId: string,
) {
  const documents = await persistence.documents.findByEntity(MERCIER_PROPS.id, 'invoice', invoiceId);
  const xmlDocument = documents.find((document) => document.kind === 'facturx_xml');
  if (xmlDocument === undefined) throw new Error('facturx archive missing');
  const stored = await storage.get(MERCIER_PROPS.id, xmlDocument.storageKey);
  if (stored === null) throw new Error('facturx object missing');
  return { document: xmlDocument, bytes: stored.bytes, xml: new TextDecoder().decode(stored.bytes) };
}

describe('Factur-X émis — XML original immuable', () => {
  beforeEach(() => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sert exactement le XML archivé après édition du client, sans reconstruction', async () => {
    const { persistence, renderer, service, storage } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const invoiceId = await issueInvoice(service);
      const original = await archivedXml(persistence, storage, invoiceId);
      expect(original.xml).toContain('<ram:Name>SARL Martin Rénovation</ram:Name>');
      expect(original.xml).toContain('<ram:ID schemeID="0002">821503646</ram:ID>');
      expect(original.xml).toContain('<ram:URIID schemeID="0225">732829320</ram:URIID>');
      expect(original.xml).toContain('<ram:URIID schemeID="0225">821503646</ram:URIID>');

      const current = await persistence.customers.findById('cust-martin');
      if (current === null) throw new Error('customer missing');
      const { id: _id, companyId: _companyId, ...editable } = current.toProps();
      const changed = await service.updateCustomer('cust-martin', {
        ...editable,
        name: 'SARL Martin Nouvelle Identité',
        address: { line1: '99 rue Modifiée', zip: '92140', city: 'Clamart' },
      });
      expect(changed.ok).toBe(true);

      const downloaded = await service.invoiceFacturXXml(invoiceId);
      expect(downloaded.ok).toBe(true);
      if (!downloaded.ok) return;
      expect(new TextEncoder().encode(downloaded.value)).toEqual(original.bytes);
      expect(downloaded.value).not.toContain('Nouvelle Identité');
      expect(renderer.renderInvoice).toHaveBeenCalledTimes(1);
    });
  });

  it('B2C : archive uniquement le PDF, sans XML ni enveloppe Factur-X', async () => {
    const { persistence, renderer, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const composed = await service.composeStandaloneInvoice({
        customerId: 'cust-durand',
        urgentOnSiteRepair: true,
        lines: [{
          label: 'Dépannage urgent',
          category: 'labor',
          qty: 1,
          unitPriceHT: 25_000,
          vatRate: 20,
        }],
      });
      if (!composed.ok) throw new Error(`compose failed: ${JSON.stringify(composed.error)}`);

      const issued = await service.issueInvoice({ invoiceId: composed.value.invoiceId });
      expect(issued.ok).toBe(true);
      await service.runDocumentArchiveJobs({ limit: 50 });
      const documents = await persistence.documents.findByEntity(
        MERCIER_PROPS.id,
        'invoice',
        composed.value.invoiceId,
      );
      expect(documents.map((document) => document.kind)).toEqual(['invoice_pdf']);
      const job = await persistence.documentArchiveJobs.findByPiece(
        MERCIER_PROPS.id,
        composed.value.invoiceId,
        'invoice-issued-pdf-only-b2c',
      );
      expect(job).toMatchObject({
        status: 'done',
        reason: 'invoice-issued-pdf-only-b2c',
      });
      expect(job?.integrityProof?.artifacts.map((artifact) => artifact.kind)).toEqual([
        'invoice_pdf',
      ]);
      expect(vi.mocked(renderer.renderInvoice).mock.calls.at(-1)?.[1]).toBeUndefined();
      const xml = await service.invoiceFacturXXml(composed.value.invoiceId);
      expect(xml.ok).toBe(false);
      if (!xml.ok) expect(xml.error.kind).toBe('forbidden');
    });
  });

  it.each([
    ['invoice_pdf', 'application/pdf'],
    ['facturx_xml', 'application/xml'],
  ] as const)(
    'ne termine jamais le job si les octets %s divergent pendant la preuve',
    async (kind, mimeType) => {
      const { audit, persistence, service, storage } = makeService();
      await persistence.seed();

      await asOwner(async () => {
        const invoiceId = await prepareInvoice(service);
        const markDone = vi.spyOn(persistence.documentArchiveJobs, 'markDone');
        storage.arm(mimeType);

        const issued = await service.issueInvoice({ invoiceId });
        expect(issued.ok).toBe(true);
        await service.runDocumentArchiveJobs({ limit: 50 });
        const documents = await persistence.documents.findByEntity(
          MERCIER_PROPS.id,
          'invoice',
          invoiceId,
        );
        expect(documents.filter((document) => document.status === 'active')
          .map((document) => document.kind).sort()).toEqual(['facturx_xml', 'invoice_pdf']);
        expect(markDone).not.toHaveBeenCalled();

        const job = await persistence.documentArchiveJobs.findByPiece(
          MERCIER_PROPS.id,
          invoiceId,
          'invoice-issued',
        );
        expect(job).toMatchObject({
          status: 'failed',
          attempts: 1,
          leaseToken: null,
          integrityProof: null,
          integrityProofSha256: null,
          completedAt: null,
        });
        expect(job?.lastError).toContain(`Octets ${kind} non vérifiables`);
        expect(await persistence.documentArchiveJobs.countIncomplete(
          MERCIER_PROPS.id,
          'invoice-issued',
        )).toBe(1);
        expect(audit.mock.calls.some(
          ([event, payload]) =>
            event === 'document.archive_job.done'
            && (payload as { reason?: string }).reason === 'invoice-issued',
        )).toBe(false);
      });
    },
  );

  it('échoue fermé si l’archive est absente ou si ses métadonnées d’intégrité divergent', async () => {
    const { persistence, service, storage } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const invoiceId = await issueInvoice(service);
      const original = await archivedXml(persistence, storage, invoiceId);
      const props = original.document.toProps();

      persistence.documents.forceReplaceForTesting(
        Document.rehydrate({
          ...props,
          byteSize: props.byteSize + 1,
          versions: props.versions.map((version) =>
            version.version === Math.max(...props.versions.map((item) => item.version))
              ? { ...version, byteSize: version.byteSize + 1 }
              : version,
          ),
        }),
      );
      await expect(service.invoiceFacturXXml(invoiceId)).resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'facturx-archive' },
      });
    });
  });

  it('échoue fermé quand plusieurs XML actifs prétendent être l’original', async () => {
    const { persistence, service, storage } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const invoiceId = await issueInvoice(service);
      const original = await archivedXml(persistence, storage, invoiceId);
      const props = original.document.toProps();
      persistence.documents.forceReplaceForTesting(
        Document.rehydrate({
          ...props,
          id: 'facturx-duplicate',
          versions: props.versions.map((version) => ({
            ...version,
            id: `${version.id}-duplicate`,
            documentId: 'facturx-duplicate',
          })),
        }),
      );

      await expect(service.invoiceFacturXXml(invoiceId)).resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'facturx-archive' },
      });
    });
  });
});
