import { createHash } from 'node:crypto';
import type { DateOnly, InvoicePdfData, QuotePdfData } from '@bob/core';

export const DOCUMENT_ARCHIVE_REASONS = [
  'invoice-issued',
  'invoice-issued-pdf-only-b2c',
  'quote-signed',
] as const;
export type DocumentArchiveReason = (typeof DOCUMENT_ARCHIVE_REASONS)[number];
export const DOCUMENT_ARCHIVE_INVOICE_REASONS = [
  'invoice-issued',
  'invoice-issued-pdf-only-b2c',
] as const satisfies readonly DocumentArchiveReason[];

export const DOCUMENT_ARCHIVE_ARTIFACT_KINDS = [
  'invoice_pdf',
  'facturx_xml',
  'signed_quote',
] as const;
export type DocumentArchiveArtifactKind = (typeof DOCUMENT_ARCHIVE_ARTIFACT_KINDS)[number];

export const DOCUMENT_ARCHIVE_CONTENT_PROFILES = [
  'plain_pdf',
  'facturx_pdfa3',
  'facturx_xml',
] as const;
export type DocumentArchiveContentProfile = (typeof DOCUMENT_ARCHIVE_CONTENT_PROFILES)[number];

export type DocumentArchiveArtifactPlan = {
  kind: DocumentArchiveArtifactKind;
  expectedContentProfile: DocumentArchiveContentProfile;
  documentId: string;
  versionId: string;
  filename: string;
  mimeType: 'application/pdf' | 'application/xml';
  linkedEntityType: 'invoice' | 'quote';
  documentDate: DateOnly | null;
  issuedAt: DateOnly | null;
};

export const DOCUMENT_ARCHIVE_RENDER_SNAPSHOT_VERSION = 1 as const;
export const DOCUMENT_ARCHIVE_RENDERER_VERSION = 1 as const;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_VALUE_DEPTH = 24;
const SHA256 = /^[a-f0-9]{64}$/u;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

export type DocumentArchiveRenderSnapshot =
  | {
      schemaVersion: 1;
      rendererVersion: 1;
      companyId: string;
      pieceId: string;
      reason: 'invoice-issued' | 'invoice-issued-pdf-only-b2c';
      metadataCreatedAt: string;
      artifacts: DocumentArchiveArtifactPlan[];
      payload: {
        kind: 'invoice';
        data: InvoicePdfData;
        facturXXml: string | null;
      };
    }
  | {
      schemaVersion: 1;
      rendererVersion: 1;
      companyId: string;
      pieceId: string;
      reason: 'quote-signed';
      metadataCreatedAt: string;
      artifacts: [DocumentArchiveArtifactPlan];
      payload: {
        kind: 'quote';
        data: QuotePdfData;
      };
    };

export interface DocumentArchiveRenderSnapshotSeal {
  readonly snapshotSchemaVersion: 1;
  readonly rendererVersion: 1;
  readonly json: string;
  readonly sha256: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_VALUE_DEPTH) throw new Error('DOCUMENT_ARCHIVE_SNAPSHOT_DEPTH_INVALID');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new Error('DOCUMENT_ARCHIVE_SNAPSHOT_NUMBER_INVALID');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(',')}]`;
  }
  if (typeof value !== 'object') throw new Error('DOCUMENT_ARCHIVE_SNAPSHOT_JSON_INVALID');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`
  )).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200;
}

function validInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validInstantOrNull(value: unknown): value is string | null {
  return value === null || validInstant(value);
}

function validDateOnlyOrNull(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validArtifactPlan(value: unknown): value is DocumentArchiveArtifactPlan {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      'kind', 'expectedContentProfile', 'documentId', 'versionId', 'filename', 'mimeType',
      'linkedEntityType', 'documentDate', 'issuedAt',
    ])
    || (value.kind !== 'invoice_pdf' && value.kind !== 'facturx_xml' && value.kind !== 'signed_quote')
    || (
      value.expectedContentProfile !== 'plain_pdf'
      && value.expectedContentProfile !== 'facturx_pdfa3'
      && value.expectedContentProfile !== 'facturx_xml'
    )
    || !validIdentity(value.documentId)
    || !validIdentity(value.versionId)
    || typeof value.filename !== 'string'
    || value.filename.trim() === ''
    || value.filename.length > 255
    || (value.mimeType !== 'application/pdf' && value.mimeType !== 'application/xml')
    || (value.linkedEntityType !== 'invoice' && value.linkedEntityType !== 'quote')
    || !validDateOnlyOrNull(value.documentDate)
    || !validDateOnlyOrNull(value.issuedAt)
  ) return false;
  return value.kind === 'facturx_xml'
    ? value.expectedContentProfile === 'facturx_xml'
      && value.mimeType === 'application/xml'
      && value.linkedEntityType === 'invoice'
    : value.mimeType === 'application/pdf'
      && value.expectedContentProfile !== 'facturx_xml'
      && value.linkedEntityType === (value.kind === 'signed_quote' ? 'quote' : 'invoice');
}

function validShape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function validText(value: unknown, maxLength = 262_144): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function validTextOrNull(value: unknown, maxLength = 262_144): value is string | null {
  return value === null || validText(value, maxLength);
}

function validMoney(value: unknown): value is number {
  return Number.isSafeInteger(value) && !Object.is(value, -0) && (value as number) >= 0;
}

function validFiniteNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isSafeInteger(value * 1_000)
    && !Object.is(value, -0);
}

function validPercentage(value: unknown): value is number {
  return validFiniteNumber(value) && value >= 0 && value <= 100;
}

function validDiscount(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'percent') {
    return exactKeys(value, ['type', 'value'])
      && validPercentage(value.value)
      && value.value > 0
      && Number.isSafeInteger(value.value * 100);
  }
  return value.type === 'amount'
    && exactKeys(value, ['type', 'cents'])
    && validMoney(value.cents)
    && value.cents > 0;
}

function validPdfLine(value: unknown): boolean {
  if (!validShape(
    value,
    ['label', 'qty', 'unitPriceHT', 'vatRate'],
    ['unit', 'discount', 'lineTotalCents'],
  )) return false;
  return validText(value.label, 10_000)
    && value.label.trim() !== ''
    && validFiniteNumber(value.qty)
    && value.qty > 0
    && validMoney(value.unitPriceHT)
    && validPercentage(value.vatRate)
    && (
      !Object.prototype.hasOwnProperty.call(value, 'unit')
      || validTextOrNull(value.unit, 200)
    )
    && (
      !Object.prototype.hasOwnProperty.call(value, 'discount')
      || value.discount === null
      || validDiscount(value.discount)
    )
    && (
      !Object.prototype.hasOwnProperty.call(value, 'lineTotalCents')
      || validMoney(value.lineTotalCents)
    );
}

function validVatByRate(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => (
    validShape(entry, ['rate', 'base', 'tax'])
    && validPercentage(entry.rate)
    && validMoney(entry.base)
    && validMoney(entry.tax)
  ));
}

function validTotals(value: unknown, invoice: boolean): boolean {
  if (!validShape(
    value,
    ['ht', 'vat', 'ttc', 'netToPay'],
    invoice
      ? [
          'grossHt', 'discountCents', 'retenueGarantieCents', 'vatByRate',
          'depositDeductionCents', 'situationDeductionCents',
        ]
      : ['grossHt', 'discountCents', 'vatByRate'],
  )) return false;
  if (![value.ht, value.vat, value.ttc, value.netToPay].every(validMoney)) return false;
  for (const key of [
    'grossHt', 'discountCents', 'retenueGarantieCents',
    'depositDeductionCents', 'situationDeductionCents',
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, key) && !validMoney(value[key])) return false;
  }
  return !Object.prototype.hasOwnProperty.call(value, 'vatByRate') || validVatByRate(value.vatByRate);
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => validText(entry));
}

function validBillingPresentation(value: unknown): boolean {
  if (!validShape(value, ['accentColor', 'rib', 'insurance'])) return false;
  if (
    value.accentColor !== 'navy'
    && value.accentColor !== 'green'
    && value.accentColor !== 'purple'
    && value.accentColor !== 'orange'
  ) return false;
  if (
    value.rib !== null
    && (!validShape(value.rib, ['iban', 'bic'])
      || !validIdentity(value.rib.iban)
      || !validTextOrNull(value.rib.bic, 100))
  ) return false;
  return value.insurance === null || (
    validShape(value.insurance, ['insurer', 'policyNo', 'coverage', 'expiresAt'])
    && validIdentity(value.insurance.insurer)
    && validIdentity(value.insurance.policyNo)
    && validText(value.insurance.coverage, 20_000)
    && validDateOnlyOrNull(value.insurance.expiresAt)
    && value.insurance.expiresAt !== null
  );
}

function validLogoBytes(value: unknown): boolean {
  return value === null || value instanceof Uint8Array;
}

function validInvoicePdfData(value: unknown): value is InvoicePdfData {
  if (!validShape(
    value,
    [
      'number', 'companyName', 'companyAddress', 'companyRcsOrRm', 'customerName',
      'customerAddress', 'issuedAt', 'dueAt', 'documentCreatedAt', 'kind', 'lines',
      'totals', 'mentions', 'billingPresentation',
    ],
    [
      'situation', 'retenueGarantiePct', 'settlementSemanticsVersion', 'purchaseOrder',
      'creditNoteSource', 'servicePeriod', 'deliveryAddress', 'logoBytes',
    ],
  )) return false;
  if (
    !validIdentity(value.number)
    || !validIdentity(value.companyName)
    || !validText(value.companyAddress, 20_000)
    || !validTextOrNull(value.companyRcsOrRm, 2_000)
    || !validIdentity(value.customerName)
    || !validText(value.customerAddress, 20_000)
    || !validDateOnlyOrNull(value.issuedAt)
    || !validDateOnlyOrNull(value.dueAt)
    || !validInstant(value.documentCreatedAt)
    || !validIdentity(value.kind)
    || !Array.isArray(value.lines)
    || !value.lines.every(validPdfLine)
    || !validTotals(value.totals, true)
    || !validStringArray(value.mentions)
    || !validBillingPresentation(value.billingPresentation)
  ) return false;

  if (Object.prototype.hasOwnProperty.call(value, 'situation') && value.situation !== null) {
    if (
      !validShape(value.situation, ['order', 'advancementPct'])
      || typeof value.situation.order !== 'number'
      || !Number.isSafeInteger(value.situation.order)
      || value.situation.order <= 0
      || (value.situation.advancementPct !== null && !validPercentage(value.situation.advancementPct))
    ) return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'retenueGarantiePct')
    && value.retenueGarantiePct !== null
    && !validPercentage(value.retenueGarantiePct)
  ) return false;
  if (
    Object.prototype.hasOwnProperty.call(value, 'settlementSemanticsVersion')
    && value.settlementSemanticsVersion !== 1
    && value.settlementSemanticsVersion !== 2
  ) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'purchaseOrder') && value.purchaseOrder !== null) {
    if (
      !validShape(value.purchaseOrder, ['number', 'receivedAt'])
      || !validIdentity(value.purchaseOrder.number)
      || !validInstantOrNull(value.purchaseOrder.receivedAt)
    ) return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'creditNoteSource') && value.creditNoteSource !== null) {
    if (
      !validShape(value.creditNoteSource, ['invoiceId', 'kind', 'number', 'issuedAt'])
      || !validIdentity(value.creditNoteSource.invoiceId)
      || !validIdentity(value.creditNoteSource.kind)
      || !validIdentity(value.creditNoteSource.number)
      || !validDateOnlyOrNull(value.creditNoteSource.issuedAt)
      || value.creditNoteSource.issuedAt === null
    ) return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'servicePeriod') && value.servicePeriod !== null) {
    if (
      !validShape(value.servicePeriod, ['start', 'end'])
      || !validDateOnlyOrNull(value.servicePeriod.start)
      || value.servicePeriod.start === null
      || !validDateOnlyOrNull(value.servicePeriod.end)
    ) return false;
  }
  return (
    !Object.prototype.hasOwnProperty.call(value, 'deliveryAddress')
    || validTextOrNull(value.deliveryAddress, 20_000)
  ) && (
    !Object.prototype.hasOwnProperty.call(value, 'logoBytes')
    || validLogoBytes(value.logoBytes)
  );
}

function validQuotePdfData(value: unknown): value is QuotePdfData {
  if (!validShape(
    value,
    [
      'number', 'companyName', 'companyAddress', 'companyRcsOrRm', 'customerName',
      'customerAddress', 'validUntil', 'documentCreatedAt', 'lines', 'totals',
      'depositPct', 'signedBy', 'mentions',
    ],
    ['retractation', 'accentColor', 'signedAt', 'signatureSvg', 'logoBytes'],
  )) return false;
  if (
    !validIdentity(value.number)
    || !validIdentity(value.companyName)
    || !validText(value.companyAddress, 20_000)
    || !validTextOrNull(value.companyRcsOrRm, 2_000)
    || !validIdentity(value.customerName)
    || !validText(value.customerAddress, 20_000)
    || !validDateOnlyOrNull(value.validUntil)
    || !validInstant(value.documentCreatedAt)
    || !Array.isArray(value.lines)
    || !value.lines.every(validPdfLine)
    || !validTotals(value.totals, false)
    || (value.depositPct !== null && !validPercentage(value.depositPct))
    || !validTextOrNull(value.signedBy, 2_000)
    || !validStringArray(value.mentions)
  ) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'retractation') && value.retractation !== null) {
    if (
      !validShape(value.retractation, ['noticeLines', 'formLines'])
      || !validStringArray(value.retractation.noticeLines)
      || !validStringArray(value.retractation.formLines)
    ) return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'accentColor')
    && value.accentColor !== null
    && value.accentColor !== 'navy'
    && value.accentColor !== 'green'
    && value.accentColor !== 'purple'
    && value.accentColor !== 'orange'
  ) return false;
  return (
    !Object.prototype.hasOwnProperty.call(value, 'signedAt')
    || value.signedAt === null
    || validInstant(value.signedAt)
  ) && (
    !Object.prototype.hasOwnProperty.call(value, 'signatureSvg')
    || validTextOrNull(value.signatureSvg)
  ) && (
    !Object.prototype.hasOwnProperty.call(value, 'logoBytes')
    || validLogoBytes(value.logoBytes)
  );
}

function hasUniqueArtifactIdentities(artifacts: readonly DocumentArchiveArtifactPlan[]): boolean {
  return new Set(artifacts.map((artifact) => artifact.kind)).size === artifacts.length
    && new Set(artifacts.map((artifact) => artifact.documentId)).size === artifacts.length
    && new Set(artifacts.map((artifact) => artifact.versionId)).size === artifacts.length;
}

function assertNoUnsealedBinaryDependency(data: InvoicePdfData | QuotePdfData): void {
  if (data.logoBytes !== undefined && data.logoBytes !== null) {
    throw new Error('DOCUMENT_ARCHIVE_SNAPSHOT_BINARY_DEPENDENCY_UNSEALED');
  }
}

function validArtifactSet(
  reason: DocumentArchiveReason,
  artifacts: unknown,
): artifacts is DocumentArchiveArtifactPlan[] {
  if (!Array.isArray(artifacts) || !artifacts.every(validArtifactPlan)) return false;
  const expectedKinds = reason === 'invoice-issued'
    ? ['facturx_xml', 'invoice_pdf']
    : reason === 'invoice-issued-pdf-only-b2c'
      ? ['invoice_pdf']
      : ['signed_quote'];
  const observedKinds = artifacts.map((artifact) => artifact.kind).sort();
  if (
    observedKinds.length !== expectedKinds.length
    || !observedKinds.every((kind, index) => kind === expectedKinds[index])
    || !hasUniqueArtifactIdentities(artifacts)
  ) return false;
  return artifacts.every((artifact) => artifact.expectedContentProfile === (
    artifact.kind === 'facturx_xml'
      ? 'facturx_xml'
      : artifact.kind === 'signed_quote' || reason === 'invoice-issued-pdf-only-b2c'
        ? 'plain_pdf'
        : 'facturx_pdfa3'
  ));
}

function validateSnapshot(value: unknown): value is DocumentArchiveRenderSnapshot {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      'schemaVersion', 'rendererVersion', 'companyId', 'pieceId', 'reason',
      'metadataCreatedAt', 'artifacts', 'payload',
    ])
    || value.schemaVersion !== DOCUMENT_ARCHIVE_RENDER_SNAPSHOT_VERSION
    || value.rendererVersion !== DOCUMENT_ARCHIVE_RENDERER_VERSION
    || !validIdentity(value.companyId)
    || !validIdentity(value.pieceId)
    || !validInstant(value.metadataCreatedAt)
    || !isRecord(value.payload)
    || !isRecord(value.payload.data)
    || value.payload.data.documentCreatedAt !== value.metadataCreatedAt
    || (
      value.reason !== 'invoice-issued'
      && value.reason !== 'invoice-issued-pdf-only-b2c'
      && value.reason !== 'quote-signed'
    )
    || !validArtifactSet(value.reason, value.artifacts)
  ) return false;

  if (value.reason === 'quote-signed') {
    return exactKeys(value.payload, ['kind', 'data'])
      && value.payload.kind === 'quote'
      && validQuotePdfData(value.payload.data);
  }
  if (
    !exactKeys(value.payload, ['kind', 'data', 'facturXXml'])
    || value.payload.kind !== 'invoice'
    || (value.payload.facturXXml !== null && typeof value.payload.facturXXml !== 'string')
  ) return false;
  if (!validInvoicePdfData(value.payload.data)) return false;
  return value.reason === 'invoice-issued'
    ? typeof value.payload.facturXXml === 'string' && value.payload.facturXXml.length > 0
    : value.payload.facturXXml === null;
}

/** Scelle l'entrée exacte du renderer dans la même transaction que l'acte métier. */
export function sealDocumentArchiveRenderSnapshot(
  input: DocumentArchiveRenderSnapshot,
): DocumentArchiveRenderSnapshotSeal {
  if (!validateSnapshot(input)) throw new Error('DOCUMENT_ARCHIVE_SNAPSHOT_INVALID');
  assertNoUnsealedBinaryDependency(input.payload.data);
  const json = canonicalJson(input);
  if (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('DOCUMENT_ARCHIVE_SNAPSHOT_TOO_LARGE');
  }
  return {
    snapshotSchemaVersion: DOCUMENT_ARCHIVE_RENDER_SNAPSHOT_VERSION,
    rendererVersion: DOCUMENT_ARCHIVE_RENDERER_VERSION,
    json,
    sha256: sha256(json),
  };
}

/** Ouvre uniquement un snapshot canonique, version supportée et lié à son digest. */
export function openDocumentArchiveRenderSnapshot(
  seal: DocumentArchiveRenderSnapshotSeal,
): DocumentArchiveRenderSnapshot {
  if (
    seal.snapshotSchemaVersion !== DOCUMENT_ARCHIVE_RENDER_SNAPSHOT_VERSION
    || seal.rendererVersion !== DOCUMENT_ARCHIVE_RENDERER_VERSION
    || typeof seal.json !== 'string'
    || Buffer.byteLength(seal.json, 'utf8') > MAX_SNAPSHOT_BYTES
    || !SHA256.test(seal.sha256)
    || sha256(seal.json) !== seal.sha256
  ) throw new Error('DOCUMENT_ARCHIVE_SNAPSHOT_SEAL_INVALID');

  let parsed: unknown;
  try {
    parsed = JSON.parse(seal.json);
  } catch {
    throw new Error('DOCUMENT_ARCHIVE_SNAPSHOT_JSON_INVALID');
  }
  if (!validateSnapshot(parsed) || canonicalJson(parsed) !== seal.json) {
    throw new Error('DOCUMENT_ARCHIVE_SNAPSHOT_INVALID');
  }
  assertNoUnsealedBinaryDependency(parsed.payload.data);
  return parsed;
}
