import { createHash } from 'node:crypto';
import type { InvoicePdfRepresentation } from './pdfa3';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type ArchiveAuditSeverity = 'P0';

export interface ArchiveAuditIssue {
  severity: ArchiveAuditSeverity;
  code: string;
  storageKey?: string;
  companyId?: string;
  documentId?: string;
  detail: string;
}

export interface GeneratedLegalRepresentationRow {
  companyId: string;
  documentId: string;
  kind: 'invoice_pdf' | 'facturx_xml' | 'signed_quote';
  origin: string;
  status: string;
  storageKey: string;
  storageObjectId: string | null;
  storageObjectCreatedAt: string | Date | null;
  storageObjectUpdatedAt: string | Date | null;
  sha256: string;
  mimeType: string;
  byteSize: number;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  versionId: string | null;
  versionNumber: number | null;
  versionCount: number;
  versionStorageKey: string | null;
  versionSha256: string | null;
  versionMimeType: string | null;
  versionByteSize: number | null;
  versionReason: string | null;
  invoiceAudience: string | null;
  invoiceStatus: string | null;
  invoiceNumber: string | null;
  invoiceIssuedAt: string | Date | null;
  quoteStatus: string | null;
  quoteSignedAt: string | Date | null;
  attestationProfile: string | null;
  attestationDocumentSha256: string | null;
  attestationEmbeddedXmlSha256: string | null;
  attestationDetectorVersion: number | null;
}

export interface ArchiveStorageOrphan {
  storageKey: string;
  createdAt?: string | Date | null;
}

export interface ArchiveMissingStoredObject {
  storageKey: string;
  referencedBy: string[];
}

export interface LoadedArchiveObject {
  bytes: Uint8Array;
  contentType: string;
  byteSize: number;
  sha256: string;
}

export interface InvoicePdfAttestationInput {
  companyId: string;
  documentId: string;
  versionId: string;
  documentSha256: string;
  profile: 'plain_pdf' | 'facturx_pdfa3';
  embeddedXmlSha256: string | null;
  detectorVersion: 1;
}

export interface ArchivePreactivationRepository {
  readSnapshot(): Promise<{
    protocolVersion: number;
    databaseFingerprint: string;
    generatedLegalRepresentations: GeneratedLegalRepresentationRow[];
    storageOrphans: ArchiveStorageOrphan[];
    missingStoredObjects: ArchiveMissingStoredObject[];
  }>;
  attestInvoicePdfs(inputs: readonly InvoicePdfAttestationInput[]): Promise<boolean>;
}

export interface ArchivePreactivationStorage {
  load(companyId: string, storageKey: string): Promise<LoadedArchiveObject | null>;
}

export interface ArchivePreactivationAuditInput {
  repository: ArchivePreactivationRepository;
  storage: ArchivePreactivationStorage;
  inspectInvoicePdf(bytes: Uint8Array): Promise<InvoicePdfRepresentation>;
  validateProfessionalFacturX(input: {
    companyId: string;
    invoiceId: string;
    pdfBytes: Uint8Array;
    pdfSha256: string;
    xmlBytes: Uint8Array;
    xmlSha256: string;
  }): Promise<void>;
  applyAttestations: boolean;
  auditedAt: Date;
  releaseSha: string;
  storageBucket: string;
}

export interface ArchivePreactivationAuditReport {
  schemaVersion: 1;
  auditedAt: string;
  releaseSha: string;
  databaseFingerprint: string;
  /** SHA-256 des seules métadonnées SQL/Storage du snapshot initial, sans octets. */
  databaseSnapshotDigest: string;
  storageBucket: string;
  /**
   * SHA-256 canonique de l'inventaire audité. Il lie les lignes SQL, l'état des objets
   * effectivement relus et le profil détecté, indépendamment de l'ordre renvoyé par SQL.
   */
  inventoryDigest: string;
  protocolVersion: number;
  mode: 'audit' | 'apply-attestations' | 'protocol-v2-verified';
  validators: {
    representationDetector: 1;
    mustang: '2.24.0';
    fnfe: '1.4.0.02';
  };
  readyForActivation: boolean;
  counts: {
    generatedLegalDocuments: number;
    objectsRead: number;
    existingAttestations: number;
    appliedAttestations: number;
    externallyValidatedProfessionalInvoices: number;
    storageOrphans: number;
    missingStoredObjects: number;
    p0Issues: number;
  };
  issues: ArchiveAuditIssue[];
}

interface EvaluatedRepresentation {
  row: GeneratedLegalRepresentationRow;
  object: LoadedArchiveObject | null;
  pdf: InvoicePdfRepresentation | null;
}

type InventoryDigestValue = string | number | boolean | null;

interface RepresentationGroup {
  scope: 'invoice' | 'quote';
  rows: GeneratedLegalRepresentationRow[];
}

function normalizeContentType(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

function normalizedSha(value: string | null): string | null {
  return value === null ? null : value.trim().toLowerCase();
}

function validTenantStorageKey(companyId: string, storageKey: string): boolean {
  const root = `companies/${companyId}/documents/`;
  return (
    storageKey.startsWith(root) &&
    !storageKey.startsWith('/') &&
    !storageKey.includes('..') &&
    !storageKey.includes('//')
  );
}

function exactAttestation(
  row: GeneratedLegalRepresentationRow,
  expected: InvoicePdfAttestationInput,
): boolean {
  return (
    row.attestationProfile === expected.profile &&
    normalizedSha(row.attestationDocumentSha256) === expected.documentSha256 &&
    normalizedSha(row.attestationEmbeddedXmlSha256) === expected.embeddedXmlSha256 &&
    row.attestationDetectorVersion === expected.detectorVersion
  );
}

function hasPartialAttestation(row: GeneratedLegalRepresentationRow): boolean {
  return (
    row.attestationProfile !== null ||
    row.attestationDocumentSha256 !== null ||
    row.attestationEmbeddedXmlSha256 !== null ||
    row.attestationDetectorVersion !== null
  );
}

function entityKey(row: GeneratedLegalRepresentationRow): string {
  return `${row.companyId}\u0000${row.linkedEntityId ?? ''}`;
}

function canonicalInstant(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function canonicalRowRecord(row: GeneratedLegalRepresentationRow): readonly InventoryDigestValue[] {
  return [
    'sql-generated-legal-representation',
    row.companyId,
    row.documentId,
    row.kind,
    row.origin,
    row.status,
    row.storageKey,
    row.storageObjectId,
    canonicalInstant(row.storageObjectCreatedAt),
    canonicalInstant(row.storageObjectUpdatedAt),
    row.sha256,
    row.mimeType,
    row.byteSize,
    row.linkedEntityType,
    row.linkedEntityId,
    row.versionId,
    row.versionNumber,
    row.versionCount,
    row.versionStorageKey,
    row.versionSha256,
    row.versionMimeType,
    row.versionByteSize,
    row.versionReason,
    row.invoiceAudience,
    row.invoiceStatus,
    row.invoiceNumber,
    canonicalInstant(row.invoiceIssuedAt),
    row.quoteStatus,
    canonicalInstant(row.quoteSignedAt),
    row.attestationProfile,
    row.attestationDocumentSha256,
    row.attestationEmbeddedXmlSha256,
    row.attestationDetectorVersion,
  ];
}

function compareRows(
  left: GeneratedLegalRepresentationRow,
  right: GeneratedLegalRepresentationRow,
): number {
  const leftKey = JSON.stringify(canonicalRowRecord(left));
  const rightKey = JSON.stringify(canonicalRowRecord(right));
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function representationGroups(
  rows: readonly GeneratedLegalRepresentationRow[],
): RepresentationGroup[] {
  const groups = new Map<string, RepresentationGroup>();
  for (const row of rows) {
    const scope = row.linkedEntityType === 'quote' ? 'quote' : 'invoice';
    const key = `${scope}\u0000${entityKey(row)}`;
    const group = groups.get(key) ?? { scope, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, group]) => ({
      scope: group.scope,
      rows: [...group.rows].sort(compareRows),
    }));
}

function updateInventoryDigest(
  digest: ReturnType<typeof createHash>,
  record: readonly InventoryDigestValue[],
): void {
  // JSON échappe les retours ligne : un enregistrement par ligne reste donc non ambigu,
  // tout en permettant un calcul incrémental qui ne retient jamais les octets du corpus.
  digest.update(JSON.stringify(record));
  digest.update('\n');
}

export function buildArchiveDatabaseSnapshotDigest(input: {
  protocolVersion: number;
  generatedLegalRepresentations: readonly GeneratedLegalRepresentationRow[];
  storageOrphans: readonly ArchiveStorageOrphan[];
  missingStoredObjects: readonly ArchiveMissingStoredObject[];
}): string {
  const digest = createHash('sha256');
  updateInventoryDigest(digest, ['archive-database-snapshot', 1]);
  updateInventoryDigest(digest, ['protocol-version', input.protocolVersion]);
  for (const row of [...input.generatedLegalRepresentations].sort(compareRows)) {
    updateInventoryDigest(digest, canonicalRowRecord(row));
  }
  for (const orphan of [...input.storageOrphans].sort((left, right) => {
    const leftKey = `${left.storageKey}\u0000${canonicalInstant(left.createdAt) ?? ''}`;
    const rightKey = `${right.storageKey}\u0000${canonicalInstant(right.createdAt) ?? ''}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  })) {
    updateInventoryDigest(digest, [
      'storage-object-without-sql-reference',
      orphan.storageKey,
      canonicalInstant(orphan.createdAt),
    ]);
  }
  for (const missing of [...input.missingStoredObjects].sort((left, right) => {
    const leftKey = `${left.storageKey}\u0000${[...left.referencedBy].sort().join('\u0000')}`;
    const rightKey = `${right.storageKey}\u0000${[...right.referencedBy].sort().join('\u0000')}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  })) {
    updateInventoryDigest(digest, [
      'sql-reference-without-storage-object',
      missing.storageKey,
      ...[...missing.referencedBy].sort(),
    ]);
  }
  return digest.digest('hex');
}

function compareIssues(left: ArchiveAuditIssue, right: ArchiveAuditIssue): number {
  const leftKey = [
    left.companyId ?? '',
    left.documentId ?? '',
    left.storageKey ?? '',
    left.code,
    left.detail,
  ].join('\u0000');
  const rightKey = [
    right.companyId ?? '',
    right.documentId ?? '',
    right.storageKey ?? '',
    right.code,
    right.detail,
  ].join('\u0000');
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * Audit bloquant avant activation Archive V2.
 *
 * Les métadonnées SQL ne servent jamais à déduire le profil d'un PDF : le profil et le SHA de
 * l'XML embarqué viennent exclusivement du parseur appliqué aux octets relus depuis le stockage.
 * La seule écriture possible est l'attestation immuable et tenant-scopée fournie par le port.
 */
export async function auditDocumentArchivePreactivation(
  input: ArchivePreactivationAuditInput,
): Promise<ArchivePreactivationAuditReport> {
  const snapshot = await input.repository.readSnapshot();
  const {
    protocolVersion,
    databaseFingerprint,
    generatedLegalRepresentations: rows,
    storageOrphans,
    missingStoredObjects,
  } = snapshot;
  const initialDatabaseSnapshotDigest = buildArchiveDatabaseSnapshotDigest({
    protocolVersion,
    generatedLegalRepresentations: rows,
    storageOrphans,
    missingStoredObjects,
  });
  const issues: ArchiveAuditIssue[] = [];
  const invalidDocuments = new Set<string>();
  let objectsRead = 0;
  let existingAttestations = 0;
  let appliedAttestations = 0;
  let externallyValidatedProfessionalInvoices = 0;
  const pendingAttestations: Array<{
    row: GeneratedLegalRepresentationRow;
    input: InvoicePdfAttestationInput;
  }> = [];

  const addDocumentIssue = (
    row: GeneratedLegalRepresentationRow,
    code: string,
    detail: string,
  ): void => {
    invalidDocuments.add(row.documentId);
    issues.push({
      severity: 'P0',
      code,
      companyId: row.companyId,
      documentId: row.documentId,
      storageKey: row.storageKey,
      detail,
    });
  };

  if (protocolVersion !== 1 && protocolVersion !== 2) {
    issues.push({
      severity: 'P0',
      code: 'ARCHIVE_PROTOCOL_STATE_INVALID',
      detail: `Version de protocole inattendue : ${protocolVersion}.`,
    });
  }

  for (const orphan of storageOrphans) {
    issues.push({
      severity: 'P0',
      code: 'STORAGE_OBJECT_WITHOUT_SQL_REFERENCE',
      storageKey: orphan.storageKey,
      detail:
        'Objet sans référence SQL : revue/quarantaine auditée obligatoire, jamais de suppression automatique.',
    });
  }
  for (const missing of missingStoredObjects) {
    issues.push({
      severity: 'P0',
      code: 'SQL_REFERENCE_WITHOUT_STORAGE_OBJECT',
      storageKey: missing.storageKey,
      detail: `Objet absent pour ${missing.referencedBy.join(', ') || 'une référence SQL inconnue'}.`,
    });
  }

  const inventoryHash = createHash('sha256');
  updateInventoryDigest(inventoryHash, ['archive-preactivation-inventory', 1]);
  updateInventoryDigest(inventoryHash, ['protocol-version', protocolVersion]);
  for (const orphan of [...storageOrphans].sort((left, right) => {
    const leftKey = `${left.storageKey}\u0000${canonicalInstant(left.createdAt) ?? ''}`;
    const rightKey = `${right.storageKey}\u0000${canonicalInstant(right.createdAt) ?? ''}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  })) {
    updateInventoryDigest(inventoryHash, [
      'storage-object-without-sql-reference',
      orphan.storageKey,
      canonicalInstant(orphan.createdAt),
    ]);
  }
  for (const missing of [...missingStoredObjects].sort((left, right) => {
    const leftKey = `${left.storageKey}\u0000${[...left.referencedBy].sort().join('\u0000')}`;
    const rightKey = `${right.storageKey}\u0000${[...right.referencedBy].sort().join('\u0000')}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  })) {
    updateInventoryDigest(inventoryHash, [
      'sql-reference-without-storage-object',
      missing.storageKey,
      ...[...missing.referencedBy].sort(),
    ]);
  }

  // Les groupes portent uniquement les métadonnées déjà présentes dans le snapshot. Les octets
  // sont chargés, inspectés et validés groupe par groupe. Seule la paire PDF/XML d'une facture
  // professionnelle à cardinalité exacte peut rester vivante jusqu'au validateur externe ; tous
  // les autres octets sont relâchés après leur ligne. Le Set ne retient que les clés déjà comptées.
  const successfullyReadStorageKeys = new Set<string>();
  for (const representationGroup of representationGroups(rows)) {
    const group: EvaluatedRepresentation[] = [];
    const invoicePdfRows = representationGroup.rows.filter(({ kind }) => kind === 'invoice_pdf');
    const facturxXmlRows = representationGroup.rows.filter(({ kind }) => kind === 'facturx_xml');
    const representativeRow = invoicePdfRows[0] ?? facturxXmlRows[0];
    const retainProfessionalPairBytes =
      representationGroup.scope === 'invoice' &&
      representativeRow?.invoiceAudience === 'professional' &&
      invoicePdfRows.length === 1 &&
      facturxXmlRows.length === 1;

    for (const row of representationGroup.rows) {
      updateInventoryDigest(inventoryHash, canonicalRowRecord(row));
      const expectedMimeType = row.kind === 'facturx_xml' ? 'application/xml' : 'application/pdf';
      const reject = (code: string, detail: string): void => {
        addDocumentIssue(row, code, detail);
      };

      if (row.origin !== 'generated' || row.status !== 'active') {
        reject(
          'GENERATED_LEGAL_DOCUMENT_STATE_INVALID',
          'La représentation légale doit être generated et active.',
        );
      }
      if (!validTenantStorageKey(row.companyId, row.storageKey)) {
        reject(
          'GENERATED_LEGAL_STORAGE_KEY_INVALID',
          'La clé de stockage sort du périmètre documents du tenant.',
        );
      }
      const expectedExtension = row.kind === 'facturx_xml' ? 'xml' : 'pdf';
      const expectedStorageKey = `companies/${row.companyId}/documents/${row.documentId}/v1/${row.sha256.trim()}.${expectedExtension}`;
      if (row.storageKey !== expectedStorageKey) {
        reject(
          'GENERATED_LEGAL_STORAGE_KEY_NOT_CONTENT_ADDRESSED',
          'La clé ne correspond pas au tenant, document, numéro de version et SHA immuables.',
        );
      }
      if (!SHA256_PATTERN.test(row.sha256.trim())) {
        reject('GENERATED_LEGAL_SHA256_INVALID', 'Le SHA-256 SQL n’est pas canonique.');
      }
      if (normalizeContentType(row.mimeType) !== expectedMimeType) {
        reject('GENERATED_LEGAL_MIME_INVALID', `MIME attendu : ${expectedMimeType}.`);
      }
      if (!Number.isSafeInteger(row.byteSize) || row.byteSize <= 0) {
        reject(
          'GENERATED_LEGAL_SIZE_INVALID',
          'La taille SQL doit être un entier strictement positif.',
        );
      }
      if (
        row.versionCount !== 1 ||
        row.versionId === null ||
        row.versionNumber !== 1 ||
        row.versionStorageKey !== row.storageKey ||
        normalizedSha(row.versionSha256) !== normalizedSha(row.sha256) ||
        normalizeContentType(row.versionMimeType ?? '') !== normalizeContentType(row.mimeType) ||
        row.versionByteSize !== row.byteSize
      ) {
        reject(
          'GENERATED_LEGAL_VERSION_INVALID',
          'La version 1 unique ne reproduit pas exactement l’original SQL.',
        );
      }

      if (row.kind === 'signed_quote') {
        if (
          row.linkedEntityType !== 'quote' ||
          row.linkedEntityId === null ||
          row.versionReason !== 'quote-signed' ||
          row.quoteStatus !== 'signed' ||
          row.quoteSignedAt === null
        ) {
          reject(
            'SIGNED_QUOTE_SCOPE_INVALID',
            'Le PDF signé ne correspond pas à un devis réellement signé.',
          );
        }
      } else if (
        row.linkedEntityType !== 'invoice' ||
        row.linkedEntityId === null ||
        row.invoiceStatus === null ||
        row.invoiceStatus === 'draft' ||
        row.invoiceNumber === null ||
        row.invoiceIssuedAt === null ||
        (row.invoiceAudience !== 'consumer' && row.invoiceAudience !== 'professional')
      ) {
        reject(
          'INVOICE_ARCHIVE_SCOPE_INVALID',
          'La représentation ne correspond pas à une facture émise au périmètre figé.',
        );
      }
      if (
        row.kind === 'facturx_xml' &&
        (row.invoiceAudience !== 'professional' || row.versionReason !== 'invoice-issued')
      ) {
        reject(
          'FACTURX_XML_SCOPE_INVALID',
          'Un XML Factur-X séparé exige une facture professionnelle et le motif invoice-issued.',
        );
      }

      let object: LoadedArchiveObject | null;
      try {
        object = await input.storage.load(row.companyId, row.storageKey);
      } catch (error) {
        object = null;
        reject(
          'STORAGE_OBJECT_READ_FAILED',
          error instanceof Error ? error.message : 'Lecture du stockage impossible.',
        );
      }
      if (object !== null && !successfullyReadStorageKeys.has(row.storageKey)) {
        successfullyReadStorageKeys.add(row.storageKey);
        objectsRead += 1;
      }
      if (object === null) {
        reject(
          'GENERATED_LEGAL_OBJECT_MISSING',
          'Les octets originaux sont absents ou illisibles.',
        );
        updateInventoryDigest(inventoryHash, [
          'storage-object',
          row.companyId,
          row.storageKey,
          'unavailable',
        ]);
      } else {
        if (
          object.byteSize !== row.byteSize ||
          normalizedSha(object.sha256) !== normalizedSha(row.sha256) ||
          normalizeContentType(object.contentType) !== normalizeContentType(row.mimeType)
        ) {
          reject(
            'GENERATED_LEGAL_OBJECT_MISMATCH',
            'Les octets relus ne correspondent pas à la taille, au SHA et au MIME SQL.',
          );
        }
        const computedSha256 = createHash('sha256').update(object.bytes).digest('hex');
        if (computedSha256 !== normalizedSha(object.sha256)) {
          reject(
            'STORAGE_ADAPTER_DIGEST_MISMATCH',
            'Le SHA annoncé par l’adaptateur ne correspond pas aux octets reçus.',
          );
        }
        updateInventoryDigest(inventoryHash, [
          'storage-object',
          row.companyId,
          row.storageKey,
          'loaded',
          object.contentType,
          object.byteSize,
          object.sha256,
          computedSha256,
        ]);
      }

      let pdf: InvoicePdfRepresentation | null = null;
      if (object !== null && row.kind !== 'facturx_xml') {
        pdf = await input.inspectInvoicePdf(object.bytes);
        if (!pdf.ok) {
          reject(
            'PDF_REPRESENTATION_UNKNOWN_OR_AMBIGUOUS',
            'Le conteneur PDF ne peut pas être classé de manière sûre.',
          );
        } else if (pdf.documentSha256 !== normalizedSha(row.sha256)) {
          reject(
            'PDF_INSPECTOR_DIGEST_MISMATCH',
            'Le parseur PDF et le stockage ne voient pas les mêmes octets.',
          );
        }
        if (row.kind === 'signed_quote' && pdf.ok && pdf.profile !== 'plain_pdf') {
          reject(
            'SIGNED_QUOTE_PDF_PROFILE_INVALID',
            'Un devis signé ne doit pas embarquer un XML Factur-X.',
          );
        }
      }
      if (row.kind === 'facturx_xml') {
        updateInventoryDigest(inventoryHash, [
          'representation-profile',
          row.companyId,
          row.documentId,
          'not-applicable',
        ]);
      } else if (pdf === null) {
        updateInventoryDigest(inventoryHash, [
          'representation-profile',
          row.companyId,
          row.documentId,
          'unavailable',
        ]);
      } else if (!pdf.ok) {
        updateInventoryDigest(inventoryHash, [
          'representation-profile',
          row.companyId,
          row.documentId,
          'rejected',
          pdf.reason,
        ]);
      } else {
        updateInventoryDigest(inventoryHash, [
          'representation-profile',
          row.companyId,
          row.documentId,
          'accepted',
          pdf.profile,
          pdf.detectorVersion,
          pdf.documentSha256,
          pdf.embeddedXmlSha256,
        ]);
      }

      group.push({
        row,
        object: retainProfessionalPairBytes ? object : null,
        pdf,
      });
    }

    if (representationGroup.scope === 'quote') {
      const signedPdfs = group.filter(({ row }) => row.kind === 'signed_quote');
      if (signedPdfs.length !== 1) {
        for (const evaluation of signedPdfs) {
          addDocumentIssue(
            evaluation.row,
            'SIGNED_QUOTE_REPRESENTATION_CARDINALITY_INVALID',
            'Un devis signé doit avoir exactement un PDF généré.',
          );
        }
      }
      continue;
    }

    const pdfs = group.filter(({ row }) => row.kind === 'invoice_pdf');
    const xmls = group.filter(({ row }) => row.kind === 'facturx_xml');
    const representative = pdfs[0] ?? xmls[0];
    if (representative === undefined) continue;
    const audience = representative.row.invoiceAudience;
    if (pdfs.length !== 1) {
      for (const evaluation of group) {
        addDocumentIssue(
          evaluation.row,
          'INVOICE_PDF_CARDINALITY_INVALID',
          'Une facture émise doit avoir exactement un PDF généré.',
        );
      }
      continue;
    }
    const pdfEvaluation = pdfs[0];
    if (pdfEvaluation === undefined) continue;
    const expectedReason =
      audience === 'consumer' ? 'invoice-issued-pdf-only-b2c' : 'invoice-issued';
    if (pdfEvaluation.row.versionReason !== expectedReason) {
      addDocumentIssue(
        pdfEvaluation.row,
        'INVOICE_PDF_REASON_INVALID',
        `Motif de version attendu : ${expectedReason}.`,
      );
    }

    if (audience === 'consumer') {
      if (xmls.length !== 0) {
        addDocumentIssue(
          pdfEvaluation.row,
          'B2C_FACTURX_XML_FORBIDDEN',
          'Une facture consommateur ne doit avoir aucun XML Factur-X séparé.',
        );
        for (const xml of xmls) {
          addDocumentIssue(
            xml.row,
            'B2C_FACTURX_XML_FORBIDDEN',
            'Une facture consommateur ne doit avoir aucun XML Factur-X généré.',
          );
        }
      }
      if (pdfEvaluation.pdf?.ok && pdfEvaluation.pdf.profile !== 'plain_pdf') {
        addDocumentIssue(
          pdfEvaluation.row,
          'B2C_PDF_PROFILE_INVALID',
          'Le PDF B2C doit être un PDF simple sans XML embarqué.',
        );
      }
    } else if (audience === 'professional') {
      if (xmls.length !== 1) {
        for (const evaluation of group) {
          addDocumentIssue(
            evaluation.row,
            'PROFESSIONAL_FACTURX_XML_CARDINALITY_INVALID',
            'Une facture professionnelle doit avoir exactement un XML Factur-X séparé.',
          );
        }
      }
      if (pdfEvaluation.pdf?.ok && pdfEvaluation.pdf.profile !== 'facturx_pdfa3') {
        addDocumentIssue(
          pdfEvaluation.row,
          'PROFESSIONAL_PDF_PROFILE_INVALID',
          'Le PDF professionnel doit être un PDF/A-3 Factur-X.',
        );
      }
      const xml = xmls[0];
      if (
        xml !== undefined &&
        pdfEvaluation.pdf?.ok &&
        pdfEvaluation.pdf.profile === 'facturx_pdfa3' &&
        normalizedSha(xml.object?.sha256 ?? null) !== pdfEvaluation.pdf.embeddedXmlSha256
      ) {
        addDocumentIssue(
          pdfEvaluation.row,
          'FACTURX_EMBEDDED_XML_MISMATCH',
          'Le SHA de l’XML embarqué diffère du SHA de l’XML séparé relu.',
        );
        addDocumentIssue(
          xml.row,
          'FACTURX_EMBEDDED_XML_MISMATCH',
          'Le SHA de l’XML séparé diffère du SHA embarqué dans le PDF.',
        );
      }
      if (
        xml !== undefined &&
        pdfEvaluation.object !== null &&
        xml.object !== null &&
        pdfEvaluation.pdf?.ok &&
        pdfEvaluation.pdf.profile === 'facturx_pdfa3' &&
        !invalidDocuments.has(pdfEvaluation.row.documentId) &&
        !invalidDocuments.has(xml.row.documentId)
      ) {
        try {
          await input.validateProfessionalFacturX({
            companyId: pdfEvaluation.row.companyId,
            invoiceId: pdfEvaluation.row.linkedEntityId as string,
            pdfBytes: pdfEvaluation.object.bytes,
            pdfSha256: pdfEvaluation.object.sha256,
            xmlBytes: xml.object.bytes,
            xmlSha256: xml.object.sha256,
          });
          externallyValidatedProfessionalInvoices += 1;
        } catch {
          addDocumentIssue(
            pdfEvaluation.row,
            'FACTURX_EXTERNAL_CONFORMANCE_UNVERIFIED',
            'La paire historique n’a pas passé Mustang PDF/A-3b/XML et FNFE EN16931/BR-FR.',
          );
          addDocumentIssue(
            xml.row,
            'FACTURX_EXTERNAL_CONFORMANCE_UNVERIFIED',
            'La paire historique n’a pas passé Mustang PDF/A-3b/XML et FNFE EN16931/BR-FR.',
          );
        }
      }
    }

    if (!pdfEvaluation.pdf?.ok || invalidDocuments.has(pdfEvaluation.row.documentId)) continue;
    const expectedAttestation: InvoicePdfAttestationInput = {
      companyId: pdfEvaluation.row.companyId,
      documentId: pdfEvaluation.row.documentId,
      versionId: pdfEvaluation.row.versionId as string,
      documentSha256: pdfEvaluation.pdf.documentSha256,
      profile: pdfEvaluation.pdf.profile,
      embeddedXmlSha256: pdfEvaluation.pdf.embeddedXmlSha256,
      detectorVersion: pdfEvaluation.pdf.detectorVersion,
    };
    if (hasPartialAttestation(pdfEvaluation.row)) {
      if (exactAttestation(pdfEvaluation.row, expectedAttestation)) {
        existingAttestations += 1;
      } else {
        addDocumentIssue(
          pdfEvaluation.row,
          'INVOICE_PDF_ATTESTATION_CONFLICT',
          'L’attestation immuable existante ne correspond pas aux octets relus.',
        );
      }
      continue;
    }
    if (!input.applyAttestations) {
      addDocumentIssue(
        pdfEvaluation.row,
        'INVOICE_PDF_ATTESTATION_MISSING',
        'Attestation absente ; relancer explicitement en mode apply après revue du rapport.',
      );
      continue;
    }
    pendingAttestations.push({ row: pdfEvaluation.row, input: expectedAttestation });
  }

  const inventoryDigest = inventoryHash.digest('hex');

  if (input.applyAttestations && protocolVersion !== 1 && pendingAttestations.length > 0) {
    issues.push({
      severity: 'P0',
      code: 'ARCHIVE_ATTESTATION_WRITE_OUTSIDE_V1',
      detail:
        'Une attestation historique manque après l’activation V2 ; aucune écriture tardive n’est autorisée.',
    });
  } else if (input.applyAttestations && protocolVersion === 1 && pendingAttestations.length > 0) {
    if (issues.length > 0) {
      issues.push({
        severity: 'P0',
        code: 'INVOICE_PDF_ATTESTATION_BATCH_BLOCKED',
        detail:
          'Aucune attestation n’a été écrite car le scan complet contient au moins un écart bloquant.',
      });
    } else {
      try {
        if (
          await input.repository.attestInvoicePdfs(
            pendingAttestations.map(({ input: attestation }) => attestation),
          )
        ) {
          appliedAttestations = pendingAttestations.length;
        } else {
          issues.push({
            severity: 'P0',
            code: 'INVOICE_PDF_ATTESTATION_BATCH_REJECTED',
            detail:
              'La transaction tenant-scopée a refusé le lot ; aucune attestation n’a été écrite.',
          });
        }
      } catch (error) {
        issues.push({
          severity: 'P0',
          code: 'INVOICE_PDF_ATTESTATION_BATCH_FAILED',
          detail:
            error instanceof Error
              ? error.message
              : 'Écriture atomique des attestations impossible.',
        });
      }
    }
  }

  // Le scan des octets peut durer plusieurs minutes. Un second inventaire complet ferme la
  // fenêtre TOCTOU SQL↔Storage : seules les attestations exactes écrites par CE lot sont admises
  // entre les deux snapshots. Un nouvel objet orphelin, une disparition, un changement de ligne,
  // de protocole ou d'identité de base rend le rapport non activable.
  let databaseSnapshotDigest = initialDatabaseSnapshotDigest;
  try {
    const postScanSnapshot = await input.repository.readSnapshot();
    const appliedByDocumentId = new Map(
      (appliedAttestations > 0 ? pendingAttestations : []).map(({ input: attestation }) => [
        attestation.documentId,
        attestation,
      ]),
    );
    const expectedPostScanRows = rows.map((row) => {
      const attestation = appliedByDocumentId.get(row.documentId);
      if (attestation === undefined) return row;
      return {
        ...row,
        attestationProfile: attestation.profile,
        attestationDocumentSha256: attestation.documentSha256,
        attestationEmbeddedXmlSha256: attestation.embeddedXmlSha256,
        attestationDetectorVersion: attestation.detectorVersion,
      };
    });
    const expectedPostScanDigest = buildArchiveDatabaseSnapshotDigest({
      protocolVersion,
      generatedLegalRepresentations: expectedPostScanRows,
      storageOrphans,
      missingStoredObjects,
    });
    databaseSnapshotDigest = buildArchiveDatabaseSnapshotDigest({
      protocolVersion: postScanSnapshot.protocolVersion,
      generatedLegalRepresentations: postScanSnapshot.generatedLegalRepresentations,
      storageOrphans: postScanSnapshot.storageOrphans,
      missingStoredObjects: postScanSnapshot.missingStoredObjects,
    });
    if (
      postScanSnapshot.databaseFingerprint !== databaseFingerprint ||
      databaseSnapshotDigest !== expectedPostScanDigest
    ) {
      issues.push({
        severity: 'P0',
        code: 'ARCHIVE_PREACTIVATION_SCAN_RACE_DETECTED',
        detail:
          'L’inventaire SQL/Storage a changé pendant le scan ; aucune preuve de cutover ne peut être émise.',
      });
    }
  } catch {
    issues.push({
      severity: 'P0',
      code: 'ARCHIVE_PREACTIVATION_SCAN_RACE_DETECTED',
      detail:
        'Le second inventaire SQL/Storage requis après le scan est indisponible ; aucune preuve de cutover ne peut être émise.',
    });
  }

  issues.sort(compareIssues);
  return {
    schemaVersion: 1,
    auditedAt: input.auditedAt.toISOString(),
    releaseSha: input.releaseSha,
    databaseFingerprint,
    databaseSnapshotDigest,
    storageBucket: input.storageBucket,
    inventoryDigest,
    protocolVersion,
    mode: input.applyAttestations ? 'apply-attestations' : 'audit',
    validators: {
      representationDetector: 1,
      mustang: '2.24.0',
      fnfe: '1.4.0.02',
    },
    readyForActivation: issues.length === 0,
    counts: {
      generatedLegalDocuments: rows.length,
      objectsRead,
      existingAttestations,
      appliedAttestations,
      externallyValidatedProfessionalInvoices,
      storageOrphans: storageOrphans.length,
      missingStoredObjects: missingStoredObjects.length,
      p0Issues: issues.length,
    },
    issues,
  };
}
