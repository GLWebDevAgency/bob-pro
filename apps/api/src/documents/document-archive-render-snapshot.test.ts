import { describe, expect, it } from 'vitest';
import type { InvoicePdfData, QuotePdfData } from '@bob/core';
import {
  openDocumentArchiveRenderSnapshot,
  sealDocumentArchiveRenderSnapshot,
  type DocumentArchiveRenderSnapshot,
} from './document-archive-render-snapshot';

const invoiceData: InvoicePdfData = {
  number: 'F-2026-001',
  companyName: 'Fly Services',
  companyAddress: '1 rue de Paris, 75001 Paris',
  companyRcsOrRm: null,
  customerName: 'Camping Les Pins',
  customerAddress: '2 route de la Mer, 13000 Marseille',
  issuedAt: '2026-08-04',
  dueAt: '2026-09-03',
  documentCreatedAt: '2026-08-04T10:00:00.000Z',
  kind: 'final',
  lines: [{ label: 'Entretien', qty: 1, unitPriceHT: 10_000, vatRate: 20 }],
  totals: { ht: 10_000, vat: 2_000, ttc: 12_000, netToPay: 12_000 },
  mentions: [],
  billingPresentation: { accentColor: 'navy', rib: null, insurance: null },
};

function invoiceSnapshot(): Extract<
  DocumentArchiveRenderSnapshot,
  { reason: 'invoice-issued' | 'invoice-issued-pdf-only-b2c' }
> {
  return {
    schemaVersion: 1,
    rendererVersion: 1,
    companyId: 'company-1',
    pieceId: 'invoice-1',
    reason: 'invoice-issued',
    metadataCreatedAt: '2026-08-04T10:00:00.000Z',
    artifacts: [
      {
        kind: 'invoice_pdf',
        expectedContentProfile: 'facturx_pdfa3',
        documentId: 'document-pdf',
        versionId: 'version-pdf',
        filename: 'facture-F-2026-001.pdf',
        mimeType: 'application/pdf',
        linkedEntityType: 'invoice',
        documentDate: '2026-08-04',
        issuedAt: '2026-08-04',
      },
      {
        kind: 'facturx_xml',
        expectedContentProfile: 'facturx_xml',
        documentId: 'document-xml',
        versionId: 'version-xml',
        filename: 'factur-x-F-2026-001.xml',
        mimeType: 'application/xml',
        linkedEntityType: 'invoice',
        documentDate: '2026-08-04',
        issuedAt: '2026-08-04',
      },
    ],
    payload: {
      kind: 'invoice',
      data: invoiceData,
      facturXXml: '<rsm:CrossIndustryInvoice />',
    },
  };
}

function quoteSnapshot(data: QuotePdfData): Extract<
  DocumentArchiveRenderSnapshot,
  { reason: 'quote-signed' }
> {
  return {
    schemaVersion: 1,
    rendererVersion: 1,
    companyId: 'company-1',
    pieceId: 'quote-1',
    reason: 'quote-signed',
    metadataCreatedAt: '2026-08-04T10:00:00.000Z',
    artifacts: [{
      kind: 'signed_quote',
      expectedContentProfile: 'plain_pdf',
      documentId: 'document-quote',
      versionId: 'version-quote',
      filename: 'devis-signe-D-1.pdf',
      mimeType: 'application/pdf',
      linkedEntityType: 'quote',
      documentDate: '2026-08-04',
      issuedAt: '2026-07-31',
    }],
    payload: { kind: 'quote', data },
  };
}

describe('snapshot immuable du renderer d’archive', () => {
  it('canonise, scelle et relit exactement le snapshot et son plan d’artefacts', () => {
    const seal = sealDocumentArchiveRenderSnapshot(invoiceSnapshot());
    expect(seal.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(openDocumentArchiveRenderSnapshot(seal)).toEqual(invoiceSnapshot());
    expect(sealDocumentArchiveRenderSnapshot(invoiceSnapshot())).toEqual(seal);
  });

  it('refuse un digest altéré, une forme non canonique et une version inconnue', () => {
    const seal = sealDocumentArchiveRenderSnapshot(invoiceSnapshot());
    expect(() => openDocumentArchiveRenderSnapshot({ ...seal, sha256: '0'.repeat(64) }))
      .toThrow('SNAPSHOT_SEAL_INVALID');
    expect(() => openDocumentArchiveRenderSnapshot({ ...seal, json: ` ${seal.json}` }))
      .toThrow();
    expect(() => openDocumentArchiveRenderSnapshot({ ...seal, rendererVersion: 2 as 1 }))
      .toThrow('SNAPSHOT_SEAL_INVALID');
  });

  it('refuse une cardinalité ou une représentation qui diverge du motif', () => {
    const snapshot = invoiceSnapshot();
    expect(() => sealDocumentArchiveRenderSnapshot({
      ...snapshot,
      artifacts: snapshot.artifacts.filter((artifact) => artifact.kind !== 'facturx_xml'),
    })).toThrow('SNAPSHOT_INVALID');
    expect(() => sealDocumentArchiveRenderSnapshot({
      ...snapshot,
      artifacts: snapshot.artifacts.map((artifact) => artifact.kind === 'invoice_pdf'
        ? { ...artifact, expectedContentProfile: 'plain_pdf' as const }
        : artifact),
    })).toThrow('SNAPSHOT_INVALID');
  });

  it('refuse toute donnée PDF incomplète, inconnue ou hors borne avant le renderer', () => {
    const base = invoiceSnapshot();
    const withoutNumber = { ...base.payload.data } as Record<string, unknown>;
    delete withoutNumber.number;
    const cases: unknown[] = [
      withoutNumber,
      { ...base.payload.data, inventedLegalValue: 'hallucination' },
      {
        ...base.payload.data,
        lines: [{ ...base.payload.data.lines[0], unitPriceHT: Number.MAX_SAFE_INTEGER + 1 }],
      },
      {
        ...base.payload.data,
        lines: [{ ...base.payload.data.lines[0], qty: 1.2345 }],
      },
      {
        ...base.payload.data,
        totals: { ...base.payload.data.totals, vat: Number.NaN },
      },
      { ...base.payload.data, issuedAt: '2026-02-30' },
      {
        ...base.payload.data,
        billingPresentation: {
          ...base.payload.data.billingPresentation,
          hiddenAccount: 'FR76',
        },
      },
      {
        ...base.payload.data,
        purchaseOrder: { number: 'BC-1', receivedAt: '2026-08-04' },
      },
    ];

    for (const data of cases) {
      expect(() => sealDocumentArchiveRenderSnapshot({
        ...base,
        payload: { ...base.payload, data: data as InvoicePdfData },
      })).toThrow('DOCUMENT_ARCHIVE_SNAPSHOT_INVALID');
    }
  });

  it('préserve l’instant canonique de réception du bon de commande', () => {
    const base = invoiceSnapshot();
    const withPurchaseOrder = {
      ...base,
      payload: {
        ...base.payload,
        data: {
          ...base.payload.data,
          purchaseOrder: { number: 'BC-RATP-4712', receivedAt: '2026-07-10T00:00:00.000Z' },
        },
      },
    };
    const seal = sealDocumentArchiveRenderSnapshot(withPurchaseOrder);
    const opened = openDocumentArchiveRenderSnapshot(seal);
    expect(opened.payload.kind).toBe('invoice');
    if (opened.payload.kind !== 'invoice') throw new Error('snapshot facture attendu');
    expect(opened.payload.data.purchaseOrder).toEqual({
      number: 'BC-RATP-4712',
      receivedAt: '2026-07-10T00:00:00.000Z',
    });
  });

  it('ferme aussi le contrat complet du devis signé', () => {
    const quoteData: QuotePdfData = {
      number: 'D-1',
      companyName: 'Fly Services',
      companyAddress: 'Paris',
      companyRcsOrRm: null,
      customerName: 'Client',
      customerAddress: 'Lyon',
      validUntil: '2026-09-01',
      documentCreatedAt: '2026-08-04T10:00:00.000Z',
      lines: [],
      totals: { ht: 0, vat: 0, ttc: 0, netToPay: 0 },
      depositPct: null,
      signedBy: 'Mme Martin',
      mentions: [],
    };
    expect(() => sealDocumentArchiveRenderSnapshot(quoteSnapshot({
      ...quoteData,
      totals: { ...quoteData.totals, ttc: Number.POSITIVE_INFINITY },
    }))).toThrow('DOCUMENT_ARCHIVE_SNAPSHOT_INVALID');
    expect(() => sealDocumentArchiveRenderSnapshot(quoteSnapshot({
      ...quoteData,
      retractation: {
        noticeLines: ['Information'],
        formLines: ['Formulaire'],
        extra: true,
      } as QuotePdfData['retractation'],
    }))).toThrow('DOCUMENT_ARCHIVE_SNAPSHOT_INVALID');
  });

  it('refuse un binaire mutable non content-addressed', () => {
    const quoteData: QuotePdfData = {
      number: 'D-1',
      companyName: 'Fly Services',
      companyAddress: 'Paris',
      companyRcsOrRm: null,
      customerName: 'Client',
      customerAddress: 'Lyon',
      validUntil: '2026-09-01',
      documentCreatedAt: '2026-08-04T10:00:00.000Z',
      lines: [],
      totals: { ht: 0, vat: 0, ttc: 0, netToPay: 0 },
      depositPct: null,
      signedBy: 'Mme Martin',
      mentions: [],
      logoBytes: new Uint8Array([1, 2, 3]),
    };
    expect(() => sealDocumentArchiveRenderSnapshot(quoteSnapshot(quoteData)))
      .toThrow('BINARY_DEPENDENCY_UNSEALED');
  });
});
