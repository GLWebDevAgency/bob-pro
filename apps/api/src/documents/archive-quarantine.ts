import { createHash } from 'node:crypto';
import type { ArchivePreactivationAuditReport } from './archive-preactivation-audit';

const SHA256 = /^[0-9a-f]{64}$/u;
const RELEASE_SHA = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BUCKET = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
const DOCUMENT_KEY = /^companies\/([^/]+)\/documents\/([^/]+)\/v1\/([0-9a-f]{64})\.pdf$/u;
const STORAGE_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/u;
const EXPECTED_AUDIT_CODES = [
  'ARCHIVE_PROTOCOL_V2_STORAGE_ORPHAN_PRESENT',
  'STORAGE_OBJECT_WITHOUT_SQL_REFERENCE',
] as const;

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface ArchiveQuarantineObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly objectId: string;
  readonly version: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Valeurs SQL exactes, privées, scellées pour empêcher un remplacement entre plan et DELETE. */
  readonly metadata: ArchiveQuarantineJson;
  readonly userMetadata: ArchiveQuarantineJson;
}

export type ArchiveQuarantineJson =
  | null
  | boolean
  | number
  | string
  | readonly ArchiveQuarantineJson[]
  | { readonly [key: string]: ArchiveQuarantineJson };

export interface ArchiveQuarantineStorage {
  assertPrivateBucket(bucket: string): Promise<void>;
  load(bucket: string, key: string): Promise<ArchiveQuarantineObject | null>;
  /** Upload sans overwrite. Une collision différente doit rester fatale. */
  putImmutable(bucket: string, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** DELETE REST standard ; l'atomicité vient du trigger PostgreSQL exact-key. */
  removeFenced(bucket: string, key: string): Promise<void>;
}

export interface ArchiveQuarantineSafetyGuard {
  /** Vérifie le plan append-only et son fence DB avant la première copie. */
  assertPlanSealed(manifest: ArchiveQuarantineManifest): Promise<void>;
  /** Journalise l'autorité OIDC vérifiée avant toute mutation Storage. */
  recordAuthorized(input: {
    manifest: ArchiveQuarantineManifest;
    authorization: ArchiveQuarantineAuthorization;
  }): Promise<void>;
  /** Fige chaque destination après GET intégral et contrôle SQL exact. */
  recordDestinationVerified(input: {
    manifest: ArchiveQuarantineManifest;
    entry: ArchiveQuarantineManifestEntry;
    destination: ArchiveQuarantineObject;
  }): Promise<void>;
  /** Persiste/rejoue l'événement append-only autorisant les suppressions. */
  recordCopiedVerified(input: {
    manifest: ArchiveQuarantineManifest;
    storedBytesSha256: string;
    receipt: ArchiveQuarantineObject;
  }): Promise<void>;
  /** Prouve le fence, les références et la progression juste avant chaque DELETE. */
  assertEntryDeleteSafe(input: {
    manifest: ArchiveQuarantineManifest;
    entry: ArchiveQuarantineManifestEntry;
    removedSourceKeySha256s: readonly string[];
  }): Promise<void>;
  /** Le trigger Storage écrit cet événement dans la même transaction que le DELETE. */
  assertSourceDeleted(input: {
    manifest: ArchiveQuarantineManifest;
    entry: ArchiveQuarantineManifestEntry;
  }): Promise<void>;
  /** Rejoue le snapshot relationnel ciblé après les cinq DELETE. */
  assertFinalSnapshotClean(manifest: ArchiveQuarantineManifest): Promise<void>;
  recordDeletedVerified(input: {
    manifest: ArchiveQuarantineManifest;
    storedBytesSha256: string;
    receipt: ArchiveQuarantineObject;
  }): Promise<void>;
  /** Lie le nouvel audit global 0/0/0 exact au journal avant tout reçu completed. */
  recordFinalAuditVerified(input: {
    manifest: ArchiveQuarantineManifest;
    evidence: ArchiveQuarantineFinalAuditEvidence;
  }): Promise<void>;
  recordCompleted(input: {
    manifest: ArchiveQuarantineManifest;
    storedBytesSha256: string;
    receipt: ArchiveQuarantineObject;
  }): Promise<void>;
}

export interface ArchiveQuarantineAuthorizationVerifier {
  /** Vérifie le jeton OIDC GitHub et sa liaison exacte au workflow, au SHA et au manifeste. */
  assertAuthenticated(
    authorization: ArchiveQuarantineAuthorization,
    manifest: ArchiveQuarantineManifest,
  ): Promise<void>;
}

export interface ArchiveQuarantineTarget {
  readonly companyIdSha256: string;
  readonly sourceKeySha256s: readonly string[];
}

export interface ArchiveQuarantineManifestEntry {
  readonly sourceKey: string;
  readonly sourceKeySha256: string;
  readonly destinationKey: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly contentType: string;
  readonly sourceObjectId: string;
  readonly sourceObjectVersion: string | null;
  readonly sourceCreatedAt: string;
  readonly sourceUpdatedAt: string;
  readonly sourceStorageMetadataDigest: string;
  readonly sourceMetadata: ArchiveQuarantineJson;
  readonly sourceUserMetadata: ArchiveQuarantineJson;
}

export interface ArchiveQuarantineManifest {
  readonly schemaVersion: 2;
  readonly environment: 'staging';
  readonly releaseSha: string;
  readonly databaseFingerprint: string;
  readonly databaseSnapshotDigest: string;
  readonly auditDeploymentId: string;
  readonly auditReportSha256: string;
  readonly sourceAuditInventoryDigest: string;
  readonly sourceBucket: string;
  readonly destinationBucket: string;
  readonly companyIdSha256: string;
  readonly entries: readonly ArchiveQuarantineManifestEntry[];
  readonly confirmationDigest: string;
}

export interface ArchiveQuarantineWorkflowIdentity {
  readonly issuer: 'https://token.actions.githubusercontent.com';
  readonly audience: 'bob-document-archive-quarantine-staging';
  readonly repository: 'GLWebDevAgency/bob-pro';
  readonly ref: 'refs/heads/main';
  readonly sha: string;
  readonly environment: 'staging';
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly eventName: 'workflow_dispatch';
  readonly subject: 'repo:GLWebDevAgency/bob-pro:environment:staging';
  readonly repositoryId: '1286748365';
  readonly repositoryOwnerId: '84627817';
  readonly actor: string;
  readonly actorId: '84627817';
  readonly runId: string;
  readonly runAttempt: number;
  readonly tokenSha256: string;
}

export interface ArchiveQuarantineAuthorization {
  readonly schemaVersion: 2;
  readonly environment: 'staging';
  readonly manifestDigest: string;
  readonly authorizationRecordedAt: string;
  readonly authorizationChannel: 'github-actions:workflow_dispatch';
  readonly workflow: ArchiveQuarantineWorkflowIdentity;
}

export interface ArchiveQuarantineFinalAuditEvidence {
  readonly deploymentId: string;
  readonly releaseSha: string;
  readonly databaseFingerprint: string;
  readonly databaseSnapshotDigest: string;
  readonly storageBucket: string;
  readonly inventoryDigest: string;
  readonly reportSha256: string;
  readonly auditedAt: string;
  readonly readyForActivation: true;
  readonly storageOrphans: 0;
  readonly missingStoredObjects: 0;
  readonly p0Issues: 0;
}

export interface ArchiveQuarantineDeletedReceipt {
  readonly schemaVersion: 2;
  readonly phase: 'deleted_verified';
  readonly manifestDigest: string;
  readonly deletedAt: string;
  readonly sourceKeySha256s: readonly string[];
  readonly receiptSha256: string;
}

export interface ArchiveQuarantineReceipt {
  readonly schemaVersion: 2;
  readonly phase: 'completed';
  readonly manifestDigest: string;
  readonly completedAt: string;
  readonly finalAuditDeploymentId: string;
  readonly finalAuditInventoryDigest: string;
  readonly finalAuditReportSha256: string;
  readonly sourceKeySha256s: readonly string[];
  readonly receiptSha256: string;
}

interface ArchiveQuarantineCopyReceipt {
  readonly schemaVersion: 2;
  readonly phase: 'copied_verified';
  readonly manifestDigest: string;
  readonly sourceKeySha256s: readonly string[];
}

function canonicalContentType(value: string): string {
  const normalized = (value.split(';')[0] ?? '').trim().toLowerCase();
  return normalized || 'application/octet-stream';
}

function canonicalInstant(value: string, code: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(code);
  return value;
}

/** PostgreSQL TIMESTAMPTZ(6) sans perte de précision dans le manifeste de suppression. */
function canonicalStorageInstant(value: string, code: string): string {
  const match = STORAGE_INSTANT.exec(value);
  if (match === null) throw new Error(code);
  const millisecondInstant = `${match[1]}.${match[2]!.slice(0, 3)}Z`;
  const parsed = new Date(millisecondInstant);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== millisecondInstant) {
    throw new Error(code);
  }
  return value;
}

function canonicalJson(value: unknown): ArchiveQuarantineJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ARCHIVE_QUARANTINE_METADATA_INVALID');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('ARCHIVE_QUARANTINE_METADATA_INVALID');
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  throw new Error('ARCHIVE_QUARANTINE_METADATA_INVALID');
}

function metadataDigest(metadata: ArchiveQuarantineJson, userMetadata: ArchiveQuarantineJson): string {
  return sha256(JSON.stringify({ metadata, userMetadata }));
}

function validStorageKey(value: string): boolean {
  return value.length >= 1
    && value.length <= 1_024
    && !value.startsWith('/')
    && !value.includes('//')
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function canonicalEntry(entry: ArchiveQuarantineManifestEntry): ArchiveQuarantineManifestEntry {
  const sourceMetadata = canonicalJson(entry.sourceMetadata);
  const sourceUserMetadata = canonicalJson(entry.sourceUserMetadata);
  if (
    !validStorageKey(entry.sourceKey)
    || !validStorageKey(entry.destinationKey)
    || sha256(entry.sourceKey) !== entry.sourceKeySha256
    || !SHA256.test(entry.sourceKeySha256)
    || !SHA256.test(entry.sha256)
    || !SHA256.test(entry.sourceStorageMetadataDigest)
    || entry.sourceStorageMetadataDigest !== metadataDigest(sourceMetadata, sourceUserMetadata)
    || !Number.isSafeInteger(entry.byteSize)
    || entry.byteSize < 1
    || canonicalContentType(entry.contentType) !== 'application/pdf'
    || !UUID.test(entry.sourceObjectId)
    || (entry.sourceObjectVersion !== null && (
      entry.sourceObjectVersion.length < 1 || entry.sourceObjectVersion.length > 256
    ))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_ENTRY_INVALID');
  }
  canonicalStorageInstant(entry.sourceCreatedAt, 'ARCHIVE_QUARANTINE_ENTRY_CREATED_AT_INVALID');
  canonicalStorageInstant(entry.sourceUpdatedAt, 'ARCHIVE_QUARANTINE_ENTRY_UPDATED_AT_INVALID');
  const keyMatch = DOCUMENT_KEY.exec(entry.sourceKey);
  if (keyMatch === null || keyMatch[3] !== entry.sha256) {
    throw new Error('ARCHIVE_QUARANTINE_SOURCE_KEY_INVALID');
  }
  return {
    ...entry,
    contentType: canonicalContentType(entry.contentType),
    sourceMetadata,
    sourceUserMetadata,
  };
}

function compareEntries(
  left: ArchiveQuarantineManifestEntry,
  right: ArchiveQuarantineManifestEntry,
): number {
  return left.sourceKeySha256 < right.sourceKeySha256
    ? -1
    : left.sourceKeySha256 > right.sourceKeySha256 ? 1 : 0;
}

function expectedDestinationKey(
  inventoryDigest: string,
  entry: Pick<ArchiveQuarantineManifestEntry, 'sourceKeySha256' | 'sha256'>,
): string {
  return `v2/${inventoryDigest}/${entry.sourceKeySha256}/${entry.sha256}.pdf`;
}

function manifestPayload(input: Omit<ArchiveQuarantineManifest, 'confirmationDigest'>): string {
  return JSON.stringify({
    schemaVersion: 2,
    environment: input.environment,
    releaseSha: input.releaseSha,
    databaseFingerprint: input.databaseFingerprint,
    databaseSnapshotDigest: input.databaseSnapshotDigest,
    auditDeploymentId: input.auditDeploymentId,
    auditReportSha256: input.auditReportSha256,
    sourceAuditInventoryDigest: input.sourceAuditInventoryDigest,
    sourceBucket: input.sourceBucket,
    destinationBucket: input.destinationBucket,
    companyIdSha256: input.companyIdSha256,
    entries: [...input.entries].map(canonicalEntry).sort(compareEntries),
  });
}

export function archiveQuarantineManifestDigest(
  input: Omit<ArchiveQuarantineManifest, 'confirmationDigest'>,
): string {
  if (
    input.schemaVersion !== 2
    || input.environment !== 'staging'
    || !RELEASE_SHA.test(input.releaseSha)
    || input.databaseFingerprint.trim().length < 1
    || input.databaseFingerprint.length > 512
    || !SHA256.test(input.databaseSnapshotDigest)
    || !UUID.test(input.auditDeploymentId)
    || !SHA256.test(input.auditReportSha256)
    || !SHA256.test(input.sourceAuditInventoryDigest)
    || !SHA256.test(input.companyIdSha256)
    || !BUCKET.test(input.sourceBucket)
    || !BUCKET.test(input.destinationBucket)
    || input.sourceBucket === input.destinationBucket
    || input.entries.length !== 5
  ) {
    throw new Error('ARCHIVE_QUARANTINE_MANIFEST_INVALID');
  }
  const canonical = [...input.entries].map(canonicalEntry).sort(compareEntries);
  if (
    new Set(canonical.map(({ sourceKey }) => sourceKey)).size !== canonical.length
    || new Set(canonical.map(({ sourceKeySha256 }) => sourceKeySha256)).size !== canonical.length
    || new Set(canonical.map(({ destinationKey }) => destinationKey)).size !== canonical.length
    || canonical.some((entry) => (
      entry.destinationKey !== expectedDestinationKey(input.sourceAuditInventoryDigest, entry)
    ))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_MANIFEST_SCOPE_INVALID');
  }
  return sha256(manifestPayload({ ...input, entries: canonical }));
}

function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function orphanKeys(
  report: ArchivePreactivationAuditReport,
  target: ArchiveQuarantineTarget,
): string[] {
  const uniqueCodes = [...new Set(report.issues.map(({ code }) => code))].sort();
  const storageIssues = report.issues.filter(
    ({ code }) => code === 'STORAGE_OBJECT_WITHOUT_SQL_REFERENCE',
  );
  if (
    report.schemaVersion !== 1
    || report.protocolVersion !== 2
    || report.mode !== 'protocol-v2-verified'
    || report.readyForActivation
    || !SHA256.test(report.inventoryDigest)
    || !BUCKET.test(report.storageBucket)
    || report.counts.storageOrphans !== 5
    || report.counts.missingStoredObjects !== 0
    || report.counts.p0Issues !== 6
    || report.issues.length !== 6
    || storageIssues.length !== 5
    || !exactSet(uniqueCodes, EXPECTED_AUDIT_CODES)
    || !SHA256.test(target.companyIdSha256)
    || target.sourceKeySha256s.length !== 5
    || new Set(target.sourceKeySha256s).size !== 5
    || target.sourceKeySha256s.some((value) => !SHA256.test(value))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_AUDIT_SCOPE_INVALID');
  }
  const keys = storageIssues
    .map(({ storageKey }) => storageKey)
    .filter((key): key is string => typeof key === 'string');
  const keyHashes = keys.map((key) => sha256(key));
  if (
    keys.length !== 5
    || new Set(keys).size !== 5
    || !exactSet(keyHashes, target.sourceKeySha256s)
  ) {
    throw new Error('ARCHIVE_QUARANTINE_AUDIT_KEYS_DIVERGENT');
  }
  for (const key of keys) {
    const match = DOCUMENT_KEY.exec(key);
    if (match === null || sha256(match[1] ?? '') !== target.companyIdSha256) {
      throw new Error('ARCHIVE_QUARANTINE_AUDIT_TENANT_DIVERGENT');
    }
  }
  return keys.sort((left, right) => sha256(left).localeCompare(sha256(right)));
}

function objectFacts(object: ArchiveQuarantineObject): Omit<
  ArchiveQuarantineManifestEntry,
  'sourceKey' | 'sourceKeySha256' | 'destinationKey'
> {
  canonicalStorageInstant(object.createdAt, 'ARCHIVE_QUARANTINE_OBJECT_CREATED_AT_INVALID');
  canonicalStorageInstant(object.updatedAt, 'ARCHIVE_QUARANTINE_OBJECT_UPDATED_AT_INVALID');
  const sourceMetadata = canonicalJson(object.metadata);
  const sourceUserMetadata = canonicalJson(object.userMetadata);
  if (
    !UUID.test(object.objectId)
    || (object.version !== null && (object.version.length < 1 || object.version.length > 256))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_OBJECT_METADATA_INVALID');
  }
  return {
    sha256: sha256(object.bytes),
    byteSize: object.bytes.byteLength,
    contentType: canonicalContentType(object.contentType),
    sourceObjectId: object.objectId,
    sourceObjectVersion: object.version,
    sourceCreatedAt: object.createdAt,
    sourceUpdatedAt: object.updatedAt,
    sourceStorageMetadataDigest: metadataDigest(sourceMetadata, sourceUserMetadata),
    sourceMetadata,
    sourceUserMetadata,
  };
}

function exactSourceObject(
  object: ArchiveQuarantineObject | null,
  expected: ArchiveQuarantineManifestEntry,
): boolean {
  if (object === null) return false;
  const facts = objectFacts(object);
  return JSON.stringify(facts) === JSON.stringify({
    sha256: expected.sha256,
    byteSize: expected.byteSize,
    contentType: expected.contentType,
    sourceObjectId: expected.sourceObjectId,
    sourceObjectVersion: expected.sourceObjectVersion,
    sourceCreatedAt: expected.sourceCreatedAt,
    sourceUpdatedAt: expected.sourceUpdatedAt,
    sourceStorageMetadataDigest: expected.sourceStorageMetadataDigest,
    sourceMetadata: expected.sourceMetadata,
    sourceUserMetadata: expected.sourceUserMetadata,
  });
}

function exactCopiedObject(
  object: ArchiveQuarantineObject | null,
  expected: ArchiveQuarantineManifestEntry,
): object is ArchiveQuarantineObject {
  return object !== null
    && sha256(object.bytes) === expected.sha256
    && object.bytes.byteLength === expected.byteSize
    && canonicalContentType(object.contentType) === expected.contentType;
}

function exactSealedObject(
  object: ArchiveQuarantineObject | null,
  sealed: ArchiveQuarantineObject,
): object is ArchiveQuarantineObject {
  return object !== null
    && JSON.stringify(objectFacts(object)) === JSON.stringify(objectFacts(sealed));
}

function entryError(code: string, entry: ArchiveQuarantineManifestEntry): Error {
  return new Error(`${code}:${entry.sourceKeySha256}`);
}

/** Lecture byte-derived et construction du plan fermé, sans mutation des sources. */
export async function buildArchiveQuarantineManifest(input: {
  report: ArchivePreactivationAuditReport;
  auditDeploymentId: string;
  auditReportSha256: string;
  destinationBucket: string;
  target: ArchiveQuarantineTarget;
  storage: ArchiveQuarantineStorage;
}): Promise<ArchiveQuarantineManifest> {
  if (
    !UUID.test(input.auditDeploymentId)
    || !SHA256.test(input.auditReportSha256)
    || !BUCKET.test(input.destinationBucket)
    || input.destinationBucket === input.report.storageBucket
  ) {
    throw new Error('ARCHIVE_QUARANTINE_TARGET_INVALID');
  }
  await input.storage.assertPrivateBucket(input.report.storageBucket);
  await input.storage.assertPrivateBucket(input.destinationBucket);
  const entries: ArchiveQuarantineManifestEntry[] = [];
  for (const sourceKey of orphanKeys(input.report, input.target)) {
    const sourceKeySha256 = sha256(sourceKey);
    const source = await input.storage.load(input.report.storageBucket, sourceKey);
    if (source === null) throw new Error(`ARCHIVE_QUARANTINE_SOURCE_MISSING:${sourceKeySha256}`);
    const facts = objectFacts(source);
    const entry = {
      sourceKey,
      sourceKeySha256,
      destinationKey: '',
      ...facts,
    };
    entries.push({
      ...entry,
      destinationKey: expectedDestinationKey(input.report.inventoryDigest, entry),
    });
  }
  const payload = {
    schemaVersion: 2 as const,
    environment: 'staging' as const,
    releaseSha: input.report.releaseSha,
    databaseFingerprint: input.report.databaseFingerprint,
    databaseSnapshotDigest: input.report.databaseSnapshotDigest,
    auditDeploymentId: input.auditDeploymentId,
    auditReportSha256: input.auditReportSha256,
    sourceAuditInventoryDigest: input.report.inventoryDigest,
    sourceBucket: input.report.storageBucket,
    destinationBucket: input.destinationBucket,
    companyIdSha256: input.target.companyIdSha256,
    entries: entries.sort(compareEntries),
  };
  return { ...payload, confirmationDigest: archiveQuarantineManifestDigest(payload) };
}

export function validateArchiveQuarantineManifest(
  manifest: ArchiveQuarantineManifest,
): ArchiveQuarantineManifest {
  const payload = {
    schemaVersion: manifest.schemaVersion,
    environment: manifest.environment,
    releaseSha: manifest.releaseSha,
    databaseFingerprint: manifest.databaseFingerprint,
    databaseSnapshotDigest: manifest.databaseSnapshotDigest,
    auditDeploymentId: manifest.auditDeploymentId,
    auditReportSha256: manifest.auditReportSha256,
    sourceAuditInventoryDigest: manifest.sourceAuditInventoryDigest,
    sourceBucket: manifest.sourceBucket,
    destinationBucket: manifest.destinationBucket,
    companyIdSha256: manifest.companyIdSha256,
    entries: [...manifest.entries].map(canonicalEntry).sort(compareEntries),
  };
  const digest = archiveQuarantineManifestDigest(payload);
  if (manifest.confirmationDigest !== digest) {
    throw new Error('ARCHIVE_QUARANTINE_MANIFEST_DIGEST_MISMATCH');
  }
  return { ...payload, confirmationDigest: digest };
}

function canonicalSourceKeySha256s(manifest: ArchiveQuarantineManifest): string[] {
  return manifest.entries.map(({ sourceKeySha256 }) => sourceKeySha256).sort();
}

function parseDeletedReceipt(
  bytes: Uint8Array,
  manifest: ArchiveQuarantineManifest,
): ArchiveQuarantineDeletedReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('ARCHIVE_QUARANTINE_DELETED_RECEIPT_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ARCHIVE_QUARANTINE_DELETED_RECEIPT_INVALID');
  }
  const receipt = parsed as Record<string, unknown>;
  const expectedKeys = canonicalSourceKeySha256s(manifest);
  const deletedAt = typeof receipt.deletedAt === 'string'
    ? new Date(receipt.deletedAt)
    : new Date(Number.NaN);
  const payload = {
    schemaVersion: 2 as const,
    phase: 'deleted_verified' as const,
    manifestDigest: manifest.confirmationDigest,
    deletedAt: receipt.deletedAt as string,
    sourceKeySha256s: expectedKeys,
  };
  if (
    Object.keys(receipt).sort().join('\u0000') !== [
      'deletedAt', 'manifestDigest', 'phase', 'receiptSha256', 'schemaVersion',
      'sourceKeySha256s',
    ].sort().join('\u0000')
    || receipt.schemaVersion !== 2
    || receipt.phase !== 'deleted_verified'
    || receipt.manifestDigest !== manifest.confirmationDigest
    || !Number.isFinite(deletedAt.getTime())
    || deletedAt.toISOString() !== receipt.deletedAt
    || !Array.isArray(receipt.sourceKeySha256s)
    || !exactSet(receipt.sourceKeySha256s as string[], expectedKeys)
    || typeof receipt.receiptSha256 !== 'string'
    || receipt.receiptSha256 !== sha256(JSON.stringify(payload))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_DELETED_RECEIPT_INVALID');
  }
  return { ...payload, receiptSha256: receipt.receiptSha256 };
}

function parseCompletedReceipt(
  bytes: Uint8Array,
  manifest: ArchiveQuarantineManifest,
  evidence: ArchiveQuarantineFinalAuditEvidence,
): ArchiveQuarantineReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('ARCHIVE_QUARANTINE_FINAL_RECEIPT_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ARCHIVE_QUARANTINE_FINAL_RECEIPT_INVALID');
  }
  const receipt = parsed as Record<string, unknown>;
  const sourceKeySha256s = canonicalSourceKeySha256s(manifest);
  const completedAt = typeof receipt.completedAt === 'string'
    ? new Date(receipt.completedAt)
    : new Date(Number.NaN);
  const payload = {
    schemaVersion: 2 as const,
    phase: 'completed' as const,
    manifestDigest: manifest.confirmationDigest,
    completedAt: receipt.completedAt as string,
    finalAuditDeploymentId: evidence.deploymentId,
    finalAuditInventoryDigest: evidence.inventoryDigest,
    finalAuditReportSha256: evidence.reportSha256,
    sourceKeySha256s,
  };
  if (
    Object.keys(receipt).sort().join('\u0000') !== [
      'completedAt', 'finalAuditDeploymentId', 'finalAuditInventoryDigest',
      'finalAuditReportSha256', 'manifestDigest', 'phase', 'receiptSha256', 'schemaVersion',
      'sourceKeySha256s',
    ].sort().join('\u0000')
    || receipt.schemaVersion !== 2
    || receipt.phase !== 'completed'
    || receipt.manifestDigest !== manifest.confirmationDigest
    || !Number.isFinite(completedAt.getTime())
    || completedAt.toISOString() !== receipt.completedAt
    || receipt.finalAuditDeploymentId !== evidence.deploymentId
    || receipt.finalAuditInventoryDigest !== evidence.inventoryDigest
    || receipt.finalAuditReportSha256 !== evidence.reportSha256
    || !Array.isArray(receipt.sourceKeySha256s)
    || !exactSet(receipt.sourceKeySha256s as string[], sourceKeySha256s)
    || typeof receipt.receiptSha256 !== 'string'
    || receipt.receiptSha256 !== sha256(JSON.stringify(payload))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_FINAL_RECEIPT_INVALID');
  }
  return { ...payload, receiptSha256: receipt.receiptSha256 };
}

export function validateArchiveQuarantineWorkflowIdentity(
  workflow: ArchiveQuarantineWorkflowIdentity,
  releaseSha: string,
): void {
  if (
    workflow.issuer !== 'https://token.actions.githubusercontent.com'
    || workflow.audience !== 'bob-document-archive-quarantine-staging'
    || workflow.repository !== 'GLWebDevAgency/bob-pro'
    || workflow.ref !== 'refs/heads/main'
    || workflow.sha !== releaseSha
    || workflow.environment !== 'staging'
    || workflow.workflowRef !== 'GLWebDevAgency/bob-pro/.github/workflows/document-archive-quarantine-staging.yml@refs/heads/main'
    || workflow.workflowSha !== releaseSha
    || workflow.eventName !== 'workflow_dispatch'
    || workflow.subject !== 'repo:GLWebDevAgency/bob-pro:environment:staging'
    || workflow.repositoryId !== '1286748365'
    || workflow.repositoryOwnerId !== '84627817'
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(workflow.actor)
    || workflow.actorId !== '84627817'
    || !/^[1-9][0-9]{0,19}$/u.test(workflow.runId)
    || !Number.isSafeInteger(workflow.runAttempt)
    || workflow.runAttempt < 1
    || !SHA256.test(workflow.tokenSha256)
  ) {
    throw new Error('ARCHIVE_QUARANTINE_WORKFLOW_IDENTITY_INVALID');
  }
}

function validateAuthorization(
  authorization: ArchiveQuarantineAuthorization,
  manifest: ArchiveQuarantineManifest,
): void {
  const authorizedAt = new Date(authorization.authorizationRecordedAt);
  if (
    authorization.schemaVersion !== 2
    || authorization.environment !== 'staging'
    || authorization.manifestDigest !== manifest.confirmationDigest
    || !Number.isFinite(authorizedAt.getTime())
    || authorizedAt.toISOString() !== authorization.authorizationRecordedAt
    || authorization.authorizationChannel !== 'github-actions:workflow_dispatch'
  ) {
    throw new Error('ARCHIVE_QUARANTINE_AUTHORIZATION_INVALID');
  }
  try {
    validateArchiveQuarantineWorkflowIdentity(authorization.workflow, manifest.releaseSha);
  } catch {
    throw new Error('ARCHIVE_QUARANTINE_AUTHORIZATION_INVALID');
  }
}

async function assertFinalStorageState(
  storage: ArchiveQuarantineStorage,
  manifest: ArchiveQuarantineManifest,
): Promise<void> {
  for (const entry of manifest.entries) {
    const [source, destination] = await Promise.all([
      storage.load(manifest.sourceBucket, entry.sourceKey),
      storage.load(manifest.destinationBucket, entry.destinationKey),
    ]);
    if (source !== null || !exactCopiedObject(destination, entry)) {
      throw entryError('ARCHIVE_QUARANTINE_FINAL_STATE_INVALID', entry);
    }
  }
}

/** Saga reprenable : toutes les copies et leur reçu existent avant le premier DELETE fenced. */
export async function applyArchiveQuarantine(input: {
  manifest: ArchiveQuarantineManifest;
  confirmation: string;
  authorization: ArchiveQuarantineAuthorization;
  deletedAt: string;
  storage: ArchiveQuarantineStorage;
  guard: ArchiveQuarantineSafetyGuard;
  authorizationVerifier: ArchiveQuarantineAuthorizationVerifier;
}): Promise<ArchiveQuarantineDeletedReceipt> {
  const manifest = validateArchiveQuarantineManifest(input.manifest);
  if (input.confirmation !== `QUARANTINE-STAGING:${manifest.confirmationDigest}`) {
    throw new Error('ARCHIVE_QUARANTINE_CONFIRMATION_REQUIRED');
  }
  validateAuthorization(input.authorization, manifest);
  const deletedAt = canonicalInstant(
    input.deletedAt,
    'ARCHIVE_QUARANTINE_DELETED_AT_INVALID',
  );
  if (
    new Date(deletedAt).getTime()
      < new Date(input.authorization.authorizationRecordedAt).getTime()
  ) {
    throw new Error('ARCHIVE_QUARANTINE_DELETED_AT_INVALID');
  }
  await input.authorizationVerifier.assertAuthenticated(input.authorization, manifest);
  await input.storage.assertPrivateBucket(manifest.sourceBucket);
  await input.storage.assertPrivateBucket(manifest.destinationBucket);
  await input.guard.assertPlanSealed(manifest);
  await input.guard.recordAuthorized({ manifest, authorization: input.authorization });

  const copyReceiptKey = `receipts/${manifest.confirmationDigest}/copied-verified.json`;
  const deletedReceiptKey = `receipts/${manifest.confirmationDigest}/deleted-verified.json`;
  const existingDeleted = await input.storage.load(manifest.destinationBucket, deletedReceiptKey);
  if (existingDeleted !== null) {
    const receipt = parseDeletedReceipt(existingDeleted.bytes, manifest);
    await assertFinalStorageState(input.storage, manifest);
    await input.guard.assertFinalSnapshotClean(manifest);
    await input.guard.recordDeletedVerified({
      manifest,
      storedBytesSha256: sha256(existingDeleted.bytes),
      receipt: existingDeleted,
    });
    return receipt;
  }

  const sourceKeySha256s = canonicalSourceKeySha256s(manifest);
  const copyReceipt: ArchiveQuarantineCopyReceipt = {
    schemaVersion: 2,
    phase: 'copied_verified',
    manifestDigest: manifest.confirmationDigest,
    sourceKeySha256s,
  };
  const copyReceiptBytes = new TextEncoder().encode(`${JSON.stringify(copyReceipt)}\n`);
  const copyReceiptSha256 = sha256(copyReceiptBytes);
  const existingCopyReceipt = await input.storage.load(manifest.destinationBucket, copyReceiptKey);
  const durableCopyReceiptPresent = existingCopyReceipt !== null;
  if (
    existingCopyReceipt !== null
    && !Buffer.from(existingCopyReceipt.bytes).equals(Buffer.from(copyReceiptBytes))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_COPY_RECEIPT_CONFLICT');
  }

  for (const entry of manifest.entries) {
    const [source, destination] = await Promise.all([
      input.storage.load(manifest.sourceBucket, entry.sourceKey),
      input.storage.load(manifest.destinationBucket, entry.destinationKey),
    ]);
    if (source !== null && !exactSourceObject(source, entry)) {
      throw entryError('ARCHIVE_QUARANTINE_SOURCE_CHANGED', entry);
    }
    if (destination !== null && !exactCopiedObject(destination, entry)) {
      throw entryError('ARCHIVE_QUARANTINE_DESTINATION_COLLISION', entry);
    }
    if (source === null && !durableCopyReceiptPresent) {
      throw entryError('ARCHIVE_QUARANTINE_SOURCE_MISSING_BEFORE_RECEIPT', entry);
    }
    if (source === null && destination === null) {
      throw entryError('ARCHIVE_QUARANTINE_OBJECT_LOST', entry);
    }
    if (destination === null && source !== null) {
      await input.storage.putImmutable(
        manifest.destinationBucket,
        entry.destinationKey,
        source.bytes,
        entry.contentType,
      );
    }
    const copied = await input.storage.load(manifest.destinationBucket, entry.destinationKey);
    if (!exactCopiedObject(copied, entry)) {
      throw entryError('ARCHIVE_QUARANTINE_COPY_UNVERIFIED', entry);
    }
    await input.guard.recordDestinationVerified({ manifest, entry, destination: copied });
  }

  await input.storage.assertPrivateBucket(manifest.sourceBucket);
  await input.storage.assertPrivateBucket(manifest.destinationBucket);
  if (!durableCopyReceiptPresent) {
    await input.storage.putImmutable(
      manifest.destinationBucket,
      copyReceiptKey,
      copyReceiptBytes,
      'application/json',
    );
  }
  const persistedCopyReceipt = await input.storage.load(manifest.destinationBucket, copyReceiptKey);
  if (
    persistedCopyReceipt === null
    || !Buffer.from(persistedCopyReceipt.bytes).equals(Buffer.from(copyReceiptBytes))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_COPY_RECEIPT_UNVERIFIED');
  }
  await input.guard.recordCopiedVerified({
    manifest,
    storedBytesSha256: copyReceiptSha256,
    receipt: persistedCopyReceipt,
  });

  const removedSourceKeySha256s: string[] = [];
  await input.storage.assertPrivateBucket(manifest.sourceBucket);
  await input.storage.assertPrivateBucket(manifest.destinationBucket);
  for (const entry of manifest.entries) {
    const source = await input.storage.load(manifest.sourceBucket, entry.sourceKey);
    if (source !== null) {
      if (!exactSourceObject(source, entry)) {
        throw entryError('ARCHIVE_QUARANTINE_SOURCE_CHANGED', entry);
      }
      await input.storage.assertPrivateBucket(manifest.sourceBucket);
      await input.storage.assertPrivateBucket(manifest.destinationBucket);
      const [destinationBeforeDelete, copyReceiptBeforeDelete] = await Promise.all([
        input.storage.load(manifest.destinationBucket, entry.destinationKey),
        input.storage.load(manifest.destinationBucket, copyReceiptKey),
      ]);
      if (!exactCopiedObject(destinationBeforeDelete, entry)) {
        throw entryError('ARCHIVE_QUARANTINE_COPY_LOST_BEFORE_DELETE', entry);
      }
      if (
        !exactSealedObject(copyReceiptBeforeDelete, persistedCopyReceipt)
        || !Buffer.from(copyReceiptBeforeDelete.bytes).equals(Buffer.from(copyReceiptBytes))
      ) {
        throw new Error('ARCHIVE_QUARANTINE_COPY_RECEIPT_LOST_BEFORE_DELETE');
      }
      await input.guard.assertEntryDeleteSafe({
        manifest,
        entry,
        removedSourceKeySha256s,
      });
      await input.storage.removeFenced(manifest.sourceBucket, entry.sourceKey);
    }
    const [remainingSource, copied] = await Promise.all([
      input.storage.load(manifest.sourceBucket, entry.sourceKey),
      input.storage.load(manifest.destinationBucket, entry.destinationKey),
    ]);
    if (remainingSource !== null) {
      if (!exactSourceObject(remainingSource, entry)) {
        throw entryError('ARCHIVE_QUARANTINE_SOURCE_CHANGED_AFTER_DELETE', entry);
      }
      throw entryError('ARCHIVE_QUARANTINE_DELETE_NOT_APPLIED', entry);
    }
    if (!exactCopiedObject(copied, entry)) {
      throw entryError('ARCHIVE_QUARANTINE_COPY_LOST', entry);
    }
    await input.guard.assertSourceDeleted({ manifest, entry });
    removedSourceKeySha256s.push(entry.sourceKeySha256);
  }

  await assertFinalStorageState(input.storage, manifest);
  await input.guard.assertFinalSnapshotClean(manifest);
  const receiptPayload = {
    schemaVersion: 2 as const,
    phase: 'deleted_verified' as const,
    manifestDigest: manifest.confirmationDigest,
    deletedAt,
    sourceKeySha256s,
  };
  const receiptSha256 = sha256(JSON.stringify(receiptPayload));
  const receipt = { ...receiptPayload, receiptSha256 };
  const receiptBytes = new TextEncoder().encode(`${JSON.stringify(receipt)}\n`);
  const storedBytesSha256 = sha256(receiptBytes);
  await input.storage.putImmutable(
    manifest.destinationBucket,
    deletedReceiptKey,
    receiptBytes,
    'application/json',
  );
  const persistedDeleted = await input.storage.load(
    manifest.destinationBucket,
    deletedReceiptKey,
  );
  if (
    persistedDeleted === null
    || !Buffer.from(persistedDeleted.bytes).equals(Buffer.from(receiptBytes))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_DELETED_RECEIPT_UNVERIFIED');
  }
  await input.guard.recordDeletedVerified({
    manifest,
    storedBytesSha256,
    receipt: persistedDeleted,
  });
  return receipt;
}

function validateFinalAuditEvidence(
  evidence: ArchiveQuarantineFinalAuditEvidence,
  manifest: ArchiveQuarantineManifest,
): ArchiveQuarantineFinalAuditEvidence {
  canonicalInstant(evidence.auditedAt, 'ARCHIVE_QUARANTINE_FINAL_AUDIT_INVALID');
  if (
    !UUID.test(evidence.deploymentId)
    || evidence.releaseSha !== manifest.releaseSha
    || evidence.databaseFingerprint !== manifest.databaseFingerprint
    || !SHA256.test(evidence.databaseSnapshotDigest)
    || evidence.storageBucket !== manifest.sourceBucket
    || !SHA256.test(evidence.inventoryDigest)
    || !SHA256.test(evidence.reportSha256)
    || evidence.readyForActivation !== true
    || evidence.storageOrphans !== 0
    || evidence.missingStoredObjects !== 0
    || evidence.p0Issues !== 0
  ) {
    throw new Error('ARCHIVE_QUARANTINE_FINAL_AUDIT_INVALID');
  }
  return evidence;
}

/** Écrit completed uniquement après le nouvel audit global 0/0/0 lié au même artefact. */
export async function finalizeArchiveQuarantine(input: {
  manifest: ArchiveQuarantineManifest;
  evidence: ArchiveQuarantineFinalAuditEvidence;
  completedAt: string;
  storage: ArchiveQuarantineStorage;
  guard: ArchiveQuarantineSafetyGuard;
}): Promise<ArchiveQuarantineReceipt> {
  const manifest = validateArchiveQuarantineManifest(input.manifest);
  const evidence = validateFinalAuditEvidence(input.evidence, manifest);
  const completedAt = canonicalInstant(
    input.completedAt,
    'ARCHIVE_QUARANTINE_COMPLETED_AT_INVALID',
  );
  if (new Date(completedAt).getTime() < new Date(evidence.auditedAt).getTime()) {
    throw new Error('ARCHIVE_QUARANTINE_COMPLETED_AT_INVALID');
  }

  await input.storage.assertPrivateBucket(manifest.sourceBucket);
  await input.storage.assertPrivateBucket(manifest.destinationBucket);
  const deletedReceiptKey = `receipts/${manifest.confirmationDigest}/deleted-verified.json`;
  const deletedReceipt = await input.storage.load(manifest.destinationBucket, deletedReceiptKey);
  if (deletedReceipt === null) throw new Error('ARCHIVE_QUARANTINE_DELETED_RECEIPT_MISSING');
  parseDeletedReceipt(deletedReceipt.bytes, manifest);
  await assertFinalStorageState(input.storage, manifest);
  await input.guard.assertFinalSnapshotClean(manifest);
  await input.guard.recordFinalAuditVerified({ manifest, evidence });

  const finalReceiptKey = `receipts/${manifest.confirmationDigest}/completed.json`;
  const existingFinal = await input.storage.load(manifest.destinationBucket, finalReceiptKey);
  if (existingFinal !== null) {
    const receipt = parseCompletedReceipt(existingFinal.bytes, manifest, evidence);
    await input.guard.recordCompleted({
      manifest,
      storedBytesSha256: sha256(existingFinal.bytes),
      receipt: existingFinal,
    });
    return receipt;
  }

  const receiptPayload = {
    schemaVersion: 2 as const,
    phase: 'completed' as const,
    manifestDigest: manifest.confirmationDigest,
    completedAt,
    finalAuditDeploymentId: evidence.deploymentId,
    finalAuditInventoryDigest: evidence.inventoryDigest,
    finalAuditReportSha256: evidence.reportSha256,
    sourceKeySha256s: canonicalSourceKeySha256s(manifest),
  };
  const receipt = {
    ...receiptPayload,
    receiptSha256: sha256(JSON.stringify(receiptPayload)),
  };
  const receiptBytes = new TextEncoder().encode(`${JSON.stringify(receipt)}\n`);
  await input.storage.putImmutable(
    manifest.destinationBucket,
    finalReceiptKey,
    receiptBytes,
    'application/json',
  );
  const persisted = await input.storage.load(manifest.destinationBucket, finalReceiptKey);
  if (persisted === null || !Buffer.from(persisted.bytes).equals(Buffer.from(receiptBytes))) {
    throw new Error('ARCHIVE_QUARANTINE_FINAL_RECEIPT_UNVERIFIED');
  }
  await input.guard.recordCompleted({
    manifest,
    storedBytesSha256: sha256(receiptBytes),
    receipt: persisted,
  });
  return receipt;
}
