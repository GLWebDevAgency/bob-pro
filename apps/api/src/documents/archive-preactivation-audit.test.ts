import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  auditDocumentArchivePreactivation,
  type ArchivePreactivationRepository,
  type GeneratedLegalRepresentationRow,
  type InvoicePdfAttestationInput,
  type LoadedArchiveObject,
} from './archive-preactivation-audit';
import type { InvoicePdfRepresentation } from './pdfa3';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stored(bytes: Uint8Array, contentType: string): LoadedArchiveObject {
  return {
    bytes,
    contentType,
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function row(input: {
  documentId: string;
  kind: 'invoice_pdf' | 'facturx_xml' | 'signed_quote';
  object: LoadedArchiveObject;
  audience?: 'consumer' | 'professional';
  entityId?: string;
  reason?: string;
  attestation?: Partial<InvoicePdfAttestationInput>;
}): GeneratedLegalRepresentationRow {
  const entityId = input.entityId ?? 'invoice-1';
  const isQuote = input.kind === 'signed_quote';
  const versionId = `${input.documentId}-v1`;
  const extension = input.kind === 'facturx_xml' ? 'xml' : 'pdf';
  const storageKey = `companies/company-1/documents/${input.documentId}/v1/${input.object.sha256}.${extension}`;
  return {
    companyId: 'company-1',
    documentId: input.documentId,
    kind: input.kind,
    origin: 'generated',
    status: 'active',
    storageKey,
    storageObjectId: `${input.documentId}-storage-object`,
    storageObjectCreatedAt: '2026-07-21T08:59:58.000Z',
    storageObjectUpdatedAt: '2026-07-21T08:59:59.000Z',
    sha256: input.object.sha256,
    mimeType: input.object.contentType,
    byteSize: input.object.byteSize,
    linkedEntityType: isQuote ? 'quote' : 'invoice',
    linkedEntityId: entityId,
    versionId,
    versionNumber: 1,
    versionCount: 1,
    versionStorageKey: storageKey,
    versionSha256: input.object.sha256,
    versionMimeType: input.object.contentType,
    versionByteSize: input.object.byteSize,
    versionReason:
      input.reason ??
      (isQuote
        ? 'quote-signed'
        : input.audience === 'consumer'
          ? 'invoice-issued-pdf-only-b2c'
          : 'invoice-issued'),
    invoiceAudience: isQuote ? null : (input.audience ?? 'professional'),
    invoiceStatus: isQuote ? null : 'issued',
    invoiceNumber: isQuote ? null : 'F-2026-001',
    invoiceIssuedAt: isQuote ? null : '2026-07-21T10:00:00.000Z',
    quoteStatus: isQuote ? 'signed' : null,
    quoteSignedAt: isQuote ? '2026-07-21T09:00:00.000Z' : null,
    attestationProfile: input.attestation?.profile ?? null,
    attestationDocumentSha256: input.attestation?.documentSha256 ?? null,
    attestationEmbeddedXmlSha256: input.attestation?.embeddedXmlSha256 ?? null,
    attestationDetectorVersion: input.attestation?.detectorVersion ?? null,
  };
}

function harness(input: {
  rows: GeneratedLegalRepresentationRow[];
  objects: Map<string, LoadedArchiveObject>;
  inspections: Map<string, InvoicePdfRepresentation>;
  apply?: boolean;
  protocolVersion?: number;
  orphans?: Array<{ storageKey: string; createdAt?: string | Date | null }>;
  missing?: Array<{ storageKey: string; referencedBy: string[] }>;
  load?: (companyId: string, storageKey: string) => Promise<LoadedArchiveObject | null>;
}) {
  const attestations: InvoicePdfAttestationInput[] = [];
  let persistedRows = input.rows.map((row) => ({ ...row }));
  const repository: ArchivePreactivationRepository = {
    readSnapshot: vi.fn(async () => ({
      protocolVersion: input.protocolVersion ?? 1,
      databaseFingerprint: 'b'.repeat(64),
      generatedLegalRepresentations: persistedRows.map((row) => ({ ...row })),
      storageOrphans: input.orphans ?? [],
      missingStoredObjects: input.missing ?? [],
    })),
    attestInvoicePdfs: vi.fn(async (batch: readonly InvoicePdfAttestationInput[]) => {
      attestations.push(...batch);
      const byDocumentId = new Map<string, InvoicePdfAttestationInput>(
        batch.map((attestation) => [attestation.documentId, attestation]),
      );
      persistedRows = persistedRows.map((row) => {
        const attestation = byDocumentId.get(row.documentId);
        return attestation === undefined
          ? row
          : {
              ...row,
              attestationProfile: attestation.profile,
              attestationDocumentSha256: attestation.documentSha256,
              attestationEmbeddedXmlSha256: attestation.embeddedXmlSha256,
              attestationDetectorVersion: attestation.detectorVersion,
            };
      });
      return true;
    }),
  };
  const validateProfessionalFacturX = vi.fn(async () => undefined);
  return {
    attestations,
    repository,
    validateProfessionalFacturX,
    run: () =>
      auditDocumentArchivePreactivation({
        repository,
        storage: {
          load: vi.fn(
            input.load ?? (async (_companyId, storageKey) => input.objects.get(storageKey) ?? null),
          ),
        },
        inspectInvoicePdf: vi.fn(async (bytes): Promise<InvoicePdfRepresentation> => {
          const inspection = input.inspections.get(sha256(bytes));
          if (inspection === undefined) return { ok: false, reason: 'unknown_or_ambiguous' };
          return inspection;
        }),
        validateProfessionalFacturX,
        applyAttestations: input.apply ?? false,
        auditedAt: new Date('2026-07-21T12:00:00.000Z'),
        releaseSha: 'a'.repeat(40),
        storageBucket: 'bob-documents',
      }),
  };
}

function plainPdf(object: LoadedArchiveObject): InvoicePdfRepresentation {
  return {
    ok: true,
    profile: 'plain_pdf',
    detectorVersion: 1,
    documentSha256: object.sha256,
    embeddedXmlSha256: null,
  };
}

function hybridPdf(
  object: LoadedArchiveObject,
  embeddedXmlSha256: string,
): InvoicePdfRepresentation {
  return {
    ok: true,
    profile: 'facturx_pdfa3',
    detectorVersion: 1,
    documentSha256: object.sha256,
    embeddedXmlSha256,
  };
}

describe('auditDocumentArchivePreactivation', () => {
  it('certifie un inventaire vide sans démarrer de validateur professionnel', async () => {
    const audit = harness({
      rows: [],
      objects: new Map(),
      inspections: new Map(),
      apply: true,
    });

    const report = await audit.run();

    expect(report.readyForActivation).toBe(true);
    expect(report.counts.generatedLegalDocuments).toBe(0);
    expect(report.counts.externallyValidatedProfessionalInvoices).toBe(0);
    expect(report.counts.p0Issues).toBe(0);
    expect(audit.validateProfessionalFacturX).not.toHaveBeenCalled();
    expect(audit.attestations).toEqual([]);
  });

  it('reste strictement en lecture seule par défaut et signale l’attestation B2C manquante', async () => {
    const pdf = stored(new TextEncoder().encode('plain-pdf'), 'application/pdf');
    const document = row({
      documentId: 'pdf-b2c',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'consumer',
    });
    const audit = harness({
      rows: [document],
      objects: new Map([[document.storageKey, pdf]]),
      inspections: new Map([[pdf.sha256, plainPdf(pdf)]]),
    });

    const report = await audit.run();

    expect(report.readyForActivation).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(['INVOICE_PDF_ATTESTATION_MISSING']);
    expect(audit.attestations).toEqual([]);
    expect(audit.validateProfessionalFacturX).not.toHaveBeenCalled();
  });

  it('atteste un PDF B2C simple par la capacité dédiée après un scan complet sans écart', async () => {
    const pdf = stored(new TextEncoder().encode('plain-pdf'), 'application/pdf');
    const document = row({
      documentId: 'pdf-b2c',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'consumer',
    });
    const audit = harness({
      rows: [document],
      objects: new Map([[document.storageKey, pdf]]),
      inspections: new Map([[pdf.sha256, plainPdf(pdf)]]),
      apply: true,
    });

    const report = await audit.run();

    expect(report.readyForActivation).toBe(true);
    expect(report.counts.appliedAttestations).toBe(1);
    expect(audit.attestations).toEqual([
      {
        companyId: 'company-1',
        documentId: 'pdf-b2c',
        versionId: 'pdf-b2c-v1',
        documentSha256: pdf.sha256,
        profile: 'plain_pdf',
        embeddedXmlSha256: null,
        detectorVersion: 1,
      },
    ]);
    expect(audit.validateProfessionalFacturX).not.toHaveBeenCalled();
  });

  it('refuse une représentation hybride et tout XML séparé pour une facture B2C', async () => {
    const xml = stored(new TextEncoder().encode('<xml/>'), 'application/xml');
    const pdf = stored(new TextEncoder().encode('hybrid-pdf'), 'application/pdf');
    const pdfRow = row({
      documentId: 'pdf-b2c',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'consumer',
    });
    const xmlRow = row({
      documentId: 'xml-b2c',
      kind: 'facturx_xml',
      object: xml,
      audience: 'consumer',
    });
    const audit = harness({
      rows: [pdfRow, xmlRow],
      objects: new Map([
        [pdfRow.storageKey, pdf],
        [xmlRow.storageKey, xml],
      ]),
      inspections: new Map([[pdf.sha256, hybridPdf(pdf, xml.sha256)]]),
      apply: true,
    });

    const report = await audit.run();

    expect(report.readyForActivation).toBe(false);
    expect(report.issues.map(({ code }) => code)).toContain('B2C_PDF_PROFILE_INVALID');
    expect(report.issues.map(({ code }) => code)).toContain('B2C_FACTURX_XML_FORBIDDEN');
    expect(audit.attestations).toEqual([]);
  });

  it('valide extérieurement puis atteste une paire professionnelle aux SHA identiques', async () => {
    const xml = stored(new TextEncoder().encode('<xml/>'), 'application/xml');
    const pdf = stored(new TextEncoder().encode('hybrid-pdf'), 'application/pdf');
    const pdfRow = row({
      documentId: 'pdf-pro',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'professional',
    });
    const xmlRow = row({
      documentId: 'xml-pro',
      kind: 'facturx_xml',
      object: xml,
      audience: 'professional',
    });
    const audit = harness({
      rows: [pdfRow, xmlRow],
      objects: new Map([
        [pdfRow.storageKey, pdf],
        [xmlRow.storageKey, xml],
      ]),
      inspections: new Map([[pdf.sha256, hybridPdf(pdf, xml.sha256)]]),
      apply: true,
    });

    const report = await audit.run();

    expect(report.readyForActivation).toBe(true);
    expect(report.counts.externallyValidatedProfessionalInvoices).toBe(1);
    expect(audit.validateProfessionalFacturX).toHaveBeenCalledOnce();
    expect(audit.attestations[0]).toMatchObject({
      profile: 'facturx_pdfa3',
      embeddedXmlSha256: xml.sha256,
    });
  });

  it('bloque le lot entier sur un SHA XML divergent, sans aucune écriture partielle', async () => {
    const xml = stored(new TextEncoder().encode('<xml/>'), 'application/xml');
    const pdf = stored(new TextEncoder().encode('hybrid-pdf'), 'application/pdf');
    const pdfRow = row({
      documentId: 'pdf-pro',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'professional',
    });
    const xmlRow = row({
      documentId: 'xml-pro',
      kind: 'facturx_xml',
      object: xml,
      audience: 'professional',
    });
    const audit = harness({
      rows: [pdfRow, xmlRow],
      objects: new Map([
        [pdfRow.storageKey, pdf],
        [xmlRow.storageKey, xml],
      ]),
      inspections: new Map([[pdf.sha256, hybridPdf(pdf, 'f'.repeat(64))]]),
      apply: true,
    });

    const report = await audit.run();

    expect(report.readyForActivation).toBe(false);
    expect(report.issues.map(({ code }) => code)).toContain('FACTURX_EMBEDDED_XML_MISMATCH');
    expect(audit.validateProfessionalFacturX).not.toHaveBeenCalled();
    expect(audit.attestations).toEqual([]);
  });

  it('bloque l’attestation si les validateurs externes indépendants refusent la paire', async () => {
    const xml = stored(new TextEncoder().encode('<xml/>'), 'application/xml');
    const pdf = stored(new TextEncoder().encode('hybrid-pdf'), 'application/pdf');
    const pdfRow = row({
      documentId: 'pdf-pro',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'professional',
    });
    const xmlRow = row({
      documentId: 'xml-pro',
      kind: 'facturx_xml',
      object: xml,
      audience: 'professional',
    });
    const audit = harness({
      rows: [pdfRow, xmlRow],
      objects: new Map([
        [pdfRow.storageKey, pdf],
        [xmlRow.storageKey, xml],
      ]),
      inspections: new Map([[pdf.sha256, hybridPdf(pdf, xml.sha256)]]),
      apply: true,
    });
    audit.validateProfessionalFacturX.mockRejectedValueOnce(new Error('invalid'));

    const report = await audit.run();

    expect(report.readyForActivation).toBe(false);
    expect(
      report.issues.filter(({ code }) => code === 'FACTURX_EXTERNAL_CONFORMANCE_UNVERIFIED'),
    ).toHaveLength(2);
    expect(audit.attestations).toEqual([]);
  });

  it('refuse toute attestation si un orphelin Storage existe ailleurs dans le snapshot', async () => {
    const pdf = stored(new TextEncoder().encode('plain-pdf'), 'application/pdf');
    const document = row({
      documentId: 'pdf-b2c',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'consumer',
    });
    const audit = harness({
      rows: [document],
      objects: new Map([[document.storageKey, pdf]]),
      inspections: new Map([[pdf.sha256, plainPdf(pdf)]]),
      apply: true,
      orphans: [{ storageKey: 'companies/company-1/documents/orphan.pdf' }],
    });

    const report = await audit.run();

    expect(report.issues.map(({ code }) => code)).toEqual([
      'INVOICE_PDF_ATTESTATION_BATCH_BLOCKED',
      'STORAGE_OBJECT_WITHOUT_SQL_REFERENCE',
    ]);
    expect(audit.attestations).toEqual([]);
  });

  it('accepte uniquement une attestation préexistante exactement identique', async () => {
    const pdf = stored(new TextEncoder().encode('plain-pdf'), 'application/pdf');
    const exact = row({
      documentId: 'pdf-b2c',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'consumer',
      attestation: {
        profile: 'plain_pdf',
        documentSha256: pdf.sha256,
        embeddedXmlSha256: null,
        detectorVersion: 1,
      },
    });
    const exactAudit = harness({
      rows: [exact],
      objects: new Map([[exact.storageKey, pdf]]),
      inspections: new Map([[pdf.sha256, plainPdf(pdf)]]),
    });
    const exactReport = await exactAudit.run();
    expect(exactReport.readyForActivation).toBe(true);
    expect(exactReport.counts.existingAttestations).toBe(1);

    const conflicting = { ...exact, attestationDocumentSha256: 'f'.repeat(64) };
    const conflictAudit = harness({
      rows: [conflicting],
      objects: new Map([[conflicting.storageKey, pdf]]),
      inspections: new Map([[pdf.sha256, plainPdf(pdf)]]),
    });
    const conflictReport = await conflictAudit.run();
    expect(conflictReport.issues.map(({ code }) => code)).toEqual([
      'INVOICE_PDF_ATTESTATION_CONFLICT',
    ]);
  });

  it('interdit toute écriture historique après l’activation du protocole V2', async () => {
    const pdf = stored(new TextEncoder().encode('plain-pdf'), 'application/pdf');
    const document = row({
      documentId: 'pdf-b2c',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'consumer',
    });
    const audit = harness({
      rows: [document],
      objects: new Map([[document.storageKey, pdf]]),
      inspections: new Map([[pdf.sha256, plainPdf(pdf)]]),
      apply: true,
      protocolVersion: 2,
    });

    const report = await audit.run();

    expect(report.issues.map(({ code }) => code)).toEqual(['ARCHIVE_ATTESTATION_WRITE_OUTSIDE_V1']);
    expect(audit.attestations).toEqual([]);
  });

  it('rend le mode apply idempotent en V2 quand toutes les attestations existent déjà', async () => {
    const pdf = stored(new TextEncoder().encode('plain-pdf'), 'application/pdf');
    const document = row({
      documentId: 'pdf-b2c',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'consumer',
      attestation: {
        profile: 'plain_pdf',
        documentSha256: pdf.sha256,
        embeddedXmlSha256: null,
        detectorVersion: 1,
      },
    });
    const audit = harness({
      rows: [document],
      objects: new Map([[document.storageKey, pdf]]),
      inspections: new Map([[pdf.sha256, plainPdf(pdf)]]),
      apply: true,
      protocolVersion: 2,
    });

    const report = await audit.run();

    expect(report.readyForActivation).toBe(true);
    expect(report.counts.existingAttestations).toBe(1);
    expect(report.counts.appliedAttestations).toBe(0);
    expect(audit.attestations).toEqual([]);
  });

  it('calcule un digest canonique indépendant de l’ordre SQL et des inventaires', async () => {
    const b2cPdf = stored(new TextEncoder().encode('plain-b2c'), 'application/pdf');
    const proXml = stored(
      new TextEncoder().encode('<rsm:CrossIndustryInvoice/>'),
      'application/xml',
    );
    const proPdf = stored(new TextEncoder().encode('hybrid-pro'), 'application/pdf');
    const b2cRow = row({
      documentId: 'pdf-b2c',
      kind: 'invoice_pdf',
      object: b2cPdf,
      audience: 'consumer',
      entityId: 'invoice-b2c',
    });
    const proPdfRow = row({
      documentId: 'pdf-pro',
      kind: 'invoice_pdf',
      object: proPdf,
      audience: 'professional',
      entityId: 'invoice-pro',
    });
    const proXmlRow = row({
      documentId: 'xml-pro',
      kind: 'facturx_xml',
      object: proXml,
      audience: 'professional',
      entityId: 'invoice-pro',
    });
    const objects = new Map([
      [b2cRow.storageKey, b2cPdf],
      [proPdfRow.storageKey, proPdf],
      [proXmlRow.storageKey, proXml],
    ]);
    const inspections = new Map([
      [b2cPdf.sha256, plainPdf(b2cPdf)],
      [proPdf.sha256, hybridPdf(proPdf, proXml.sha256)],
    ]);
    const first = harness({
      rows: [proXmlRow, b2cRow, proPdfRow],
      objects,
      inspections,
      apply: true,
      orphans: [
        {
          storageKey: 'companies/company-1/documents/orphan-z',
          createdAt: '2026-07-21T11:00:00.000Z',
        },
        {
          storageKey: 'companies/company-1/documents/orphan-a',
          createdAt: new Date('2026-07-21T10:00:00.000Z'),
        },
      ],
      missing: [
        { storageKey: 'missing-z', referencedBy: ['version:z', 'document:z'] },
        { storageKey: 'missing-a', referencedBy: ['version:a', 'document:a'] },
      ],
    });
    const second = harness({
      rows: [proPdfRow, b2cRow, proXmlRow],
      objects,
      inspections,
      apply: true,
      orphans: [
        {
          storageKey: 'companies/company-1/documents/orphan-a',
          createdAt: '2026-07-21T10:00:00.000Z',
        },
        {
          storageKey: 'companies/company-1/documents/orphan-z',
          createdAt: new Date('2026-07-21T11:00:00.000Z'),
        },
      ],
      missing: [
        { storageKey: 'missing-a', referencedBy: ['document:a', 'version:a'] },
        { storageKey: 'missing-z', referencedBy: ['document:z', 'version:z'] },
      ],
    });

    const [firstReport, secondReport] = await Promise.all([first.run(), second.run()]);

    expect(firstReport.inventoryDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(secondReport.inventoryDigest).toBe(firstReport.inventoryDigest);
    expect(secondReport.databaseSnapshotDigest).toBe(firstReport.databaseSnapshotDigest);
  });

  it('lie le snapshot de stabilité aux métadonnées de chaque objet Storage référencé', async () => {
    const pdf = stored(new TextEncoder().encode('storage-metadata-pdf'), 'application/pdf');
    const original = row({
      documentId: 'pdf-storage-metadata',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'consumer',
    });
    const replaced = {
      ...original,
      storageObjectUpdatedAt: '2026-07-21T11:59:59.000Z',
    };
    const inspections = new Map([[pdf.sha256, plainPdf(pdf)]]);
    const objects = new Map([[original.storageKey, pdf]]);

    const [before, after] = await Promise.all([
      harness({ rows: [original], objects, inspections }).run(),
      harness({ rows: [replaced], objects, inspections }).run(),
    ]);

    expect(after.databaseSnapshotDigest).not.toBe(before.databaseSnapshotDigest);
  });

  it('refuse le cutover si l’inventaire SQL/Storage change pendant la lecture des octets', async () => {
    const pdf = stored(new TextEncoder().encode('race-detected-pdf'), 'application/pdf');
    const document = row({
      documentId: 'pdf-race',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'consumer',
      attestation: {
        profile: 'plain_pdf',
        documentSha256: pdf.sha256,
        embeddedXmlSha256: null,
        detectorVersion: 1,
      },
    });
    const audit = harness({
      rows: [document],
      objects: new Map([[document.storageKey, pdf]]),
      inspections: new Map([[pdf.sha256, plainPdf(pdf)]]),
    });
    vi.mocked(audit.repository.readSnapshot)
      .mockResolvedValueOnce({
        protocolVersion: 1,
        databaseFingerprint: 'b'.repeat(64),
        generatedLegalRepresentations: [document],
        storageOrphans: [],
        missingStoredObjects: [],
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        databaseFingerprint: 'b'.repeat(64),
        generatedLegalRepresentations: [document],
        storageOrphans: [
          {
            storageKey: 'companies/company-1/documents/orphan-created-during-scan',
            createdAt: '2026-07-21T12:00:01.000Z',
          },
        ],
        missingStoredObjects: [],
      });

    const report = await audit.run();

    expect(report.readyForActivation).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'ARCHIVE_PREACTIVATION_SCAN_RACE_DETECTED' }),
      ]),
    );
  });

  it('lie le digest au profil réellement détecté, pas seulement aux métadonnées SQL', async () => {
    const pdf = stored(new TextEncoder().encode('same-pdf-bytes'), 'application/pdf');
    const document = row({
      documentId: 'pdf-b2c',
      kind: 'invoice_pdf',
      object: pdf,
      audience: 'consumer',
    });
    const plainAudit = harness({
      rows: [document],
      objects: new Map([[document.storageKey, pdf]]),
      inspections: new Map([[pdf.sha256, plainPdf(pdf)]]),
    });
    const hybridAudit = harness({
      rows: [document],
      objects: new Map([[document.storageKey, pdf]]),
      inspections: new Map([[pdf.sha256, hybridPdf(pdf, 'f'.repeat(64))]]),
    });

    const [plainReport, hybridReport] = await Promise.all([plainAudit.run(), hybridAudit.run()]);

    expect(hybridReport.inventoryDigest).not.toBe(plainReport.inventoryDigest);
  });

  it('valide entièrement une facture avant de charger les octets de la suivante', async () => {
    const xml1 = stored(new TextEncoder().encode('<invoice id="1"/>'), 'application/xml');
    const pdf1 = stored(new TextEncoder().encode('hybrid-pdf-1'), 'application/pdf');
    const xml2 = stored(new TextEncoder().encode('<invoice id="2"/>'), 'application/xml');
    const pdf2 = stored(new TextEncoder().encode('hybrid-pdf-2'), 'application/pdf');
    const pdfRow1 = row({
      documentId: 'pdf-1',
      kind: 'invoice_pdf',
      object: pdf1,
      audience: 'professional',
      entityId: 'invoice-1',
    });
    const xmlRow1 = row({
      documentId: 'xml-1',
      kind: 'facturx_xml',
      object: xml1,
      audience: 'professional',
      entityId: 'invoice-1',
    });
    const pdfRow2 = row({
      documentId: 'pdf-2',
      kind: 'invoice_pdf',
      object: pdf2,
      audience: 'professional',
      entityId: 'invoice-2',
    });
    const xmlRow2 = row({
      documentId: 'xml-2',
      kind: 'facturx_xml',
      object: xml2,
      audience: 'professional',
      entityId: 'invoice-2',
    });
    const secondGroupKeys = new Set([pdfRow2.storageKey, xmlRow2.storageKey]);
    let secondGroupStarted = false;
    const loadOrder: string[] = [];
    const guardFirstGroupBytes = (object: LoadedArchiveObject): LoadedArchiveObject => ({
      get bytes() {
        if (secondGroupStarted) {
          throw new Error('les octets du premier groupe ont survécu jusqu’au chargement du second');
        }
        return object.bytes;
      },
      contentType: object.contentType,
      byteSize: object.byteSize,
      sha256: object.sha256,
    });
    const objects = new Map<string, LoadedArchiveObject>([
      [pdfRow1.storageKey, guardFirstGroupBytes(pdf1)],
      [xmlRow1.storageKey, guardFirstGroupBytes(xml1)],
      [pdfRow2.storageKey, pdf2],
      [xmlRow2.storageKey, xml2],
    ]);
    const audit = harness({
      // Ordre volontairement mélangé : le regroupement canonique doit primer sur le tableau SQL.
      rows: [xmlRow2, pdfRow1, pdfRow2, xmlRow1],
      objects,
      inspections: new Map([
        [pdf1.sha256, hybridPdf(pdf1, xml1.sha256)],
        [pdf2.sha256, hybridPdf(pdf2, xml2.sha256)],
      ]),
      apply: true,
      load: async (_companyId, storageKey) => {
        if (secondGroupKeys.has(storageKey)) secondGroupStarted = true;
        loadOrder.push(storageKey);
        return objects.get(storageKey) ?? null;
      },
    });

    const report = await audit.run();

    expect(report.readyForActivation).toBe(true);
    expect(report.counts.externallyValidatedProfessionalInvoices).toBe(2);
    const firstSecondGroupIndex = loadOrder.findIndex((storageKey) =>
      secondGroupKeys.has(storageKey),
    );
    expect(firstSecondGroupIndex).toBe(2);
    expect(loadOrder.slice(0, firstSecondGroupIndex)).toEqual(
      expect.arrayContaining([pdfRow1.storageKey, xmlRow1.storageKey]),
    );
  });
});
