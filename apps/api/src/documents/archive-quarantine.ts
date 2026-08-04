import { createHash } from 'node:crypto';
import type { ArchivePreactivationAuditReport } from './archive-preactivation-audit';

const SHA256 = /^[0-9a-f]{64}$/u;
const BUCKET = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

export interface ArchiveQuarantineObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly createdAt: string;
}

export interface ArchiveQuarantineStorage {
  assertPrivateBucket(bucket: string): Promise<void>;
  load(bucket: string, key: string): Promise<ArchiveQuarantineObject | null>;
  /** Copie sans overwrite. Une destination existante différente doit être refusée. */
  copy(sourceBucket: string, sourceKey: string, destinationBucket: string, destinationKey: string): Promise<void>;
  /** Compare et supprime dans une seule opération côté adapter ; false = source déjà absente. */
  removeExact(
    bucket: string,
    key: string,
    expected: ArchiveQuarantineManifestEntry,
  ): Promise<boolean>;
  putImmutable(bucket: string, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface ArchiveQuarantineSafetyGuard {
  /** Verrouille l'opération et recertifie les digests SQL + inventaire exacts du plan. */
  assertManifestFresh(manifest: ArchiveQuarantineManifest): Promise<void>;
  /** Maintient un verrou opérateur et prouve l'absence de référence SQL avant chaque DELETE. */
  assertSafeToDelete(
    manifest: ArchiveQuarantineManifest,
    options: { readonly durableCopyReceiptPresent: boolean },
  ): Promise<void>;
  /** Rejoue l'audit final complet après retrait. */
  assertFinalClean(manifest: ArchiveQuarantineManifest): Promise<void>;
}

export interface ArchiveQuarantineAuthorizationVerifier {
  /** Authentifie la trace fondateur et les deux contre-signatures hors du payload déclaratif. */
  assertAuthenticated(
    authorization: ArchiveQuarantineAuthorization,
    manifest: ArchiveQuarantineManifest,
  ): Promise<void>;
}

export interface ArchiveQuarantineManifestEntry {
  readonly sourceKey: string;
  readonly destinationKey: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly contentType: string;
  readonly createdAt: string;
}

export interface ArchiveQuarantineManifest {
  readonly schemaVersion: 1;
  readonly environment: 'staging';
  readonly releaseSha: string;
  readonly databaseFingerprint: string;
  readonly databaseSnapshotDigest: string;
  readonly auditReportSha256: string;
  readonly sourceAuditInventoryDigest: string;
  readonly sourceBucket: string;
  readonly destinationBucket: string;
  readonly entries: readonly ArchiveQuarantineManifestEntry[];
  readonly confirmationDigest: string;
}

export interface ArchiveQuarantineReceipt {
  readonly schemaVersion: 1;
  readonly phase: 'completed';
  readonly manifestDigest: string;
  readonly sourceBucket: string;
  readonly destinationBucket: string;
  readonly completedAt: string;
  readonly entries: readonly ArchiveQuarantineManifestEntry[];
  readonly receiptSha256: string;
}

interface ArchiveQuarantineCopyReceipt {
  readonly schemaVersion: 1;
  readonly phase: 'copied_verified';
  readonly manifestDigest: string;
  readonly sourceBucket: string;
  readonly destinationBucket: string;
  readonly entries: readonly ArchiveQuarantineManifestEntry[];
}

export interface ArchiveQuarantineAuthorization {
  readonly schemaVersion: 1;
  readonly environment: 'staging';
  readonly manifestDigest: string;
  readonly founderAuthorizedAt: string;
  readonly founderChannel: string;
  readonly countersignedBy: readonly ['claude', 'gpt'];
}

function canonicalContentType(value: string): string {
  const normalized = (value.split(';')[0] ?? '').trim().toLowerCase();
  return normalized || 'application/octet-stream';
}

function validStorageKey(value: string): boolean {
  if (value.length < 1 || value.length > 1_024 || value.startsWith('/') || value.includes('//')) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function canonicalEntry(entry: ArchiveQuarantineManifestEntry): ArchiveQuarantineManifestEntry {
  const createdAt = new Date(entry.createdAt);
  if (
    !validStorageKey(entry.sourceKey)
    || !validStorageKey(entry.destinationKey)
    || !SHA256.test(entry.sha256)
    || !Number.isSafeInteger(entry.byteSize)
    || entry.byteSize < 0
    || !Number.isFinite(createdAt.getTime())
    || createdAt.toISOString() !== entry.createdAt
  ) {
    throw new Error('ARCHIVE_QUARANTINE_ENTRY_INVALID');
  }
  return {
    sourceKey: entry.sourceKey,
    destinationKey: entry.destinationKey,
    sha256: entry.sha256,
    byteSize: entry.byteSize,
    contentType: canonicalContentType(entry.contentType),
    createdAt: entry.createdAt,
  };
}

function compareEntries(
  left: ArchiveQuarantineManifestEntry,
  right: ArchiveQuarantineManifestEntry,
): number {
  const leftKey = `${left.sourceKey}\u0000${left.destinationKey}`;
  const rightKey = `${right.sourceKey}\u0000${right.destinationKey}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function expectedDestinationKey(
  inventoryDigest: string,
  entry: Pick<ArchiveQuarantineManifestEntry, 'sourceKey' | 'sha256'>,
): string {
  const sourceKeySha256 = createHash('sha256').update(entry.sourceKey, 'utf8').digest('hex');
  return `v1/${inventoryDigest}/${sourceKeySha256}/${entry.sha256}`;
}

function manifestPayload(input: Omit<ArchiveQuarantineManifest, 'confirmationDigest'>): string {
  return JSON.stringify({
    schemaVersion: 1,
    environment: input.environment,
    releaseSha: input.releaseSha,
    databaseFingerprint: input.databaseFingerprint,
    databaseSnapshotDigest: input.databaseSnapshotDigest,
    auditReportSha256: input.auditReportSha256,
    sourceAuditInventoryDigest: input.sourceAuditInventoryDigest,
    sourceBucket: input.sourceBucket,
    destinationBucket: input.destinationBucket,
    entries: [...input.entries].map(canonicalEntry).sort(compareEntries),
  });
}

export function archiveQuarantineManifestDigest(
  input: Omit<ArchiveQuarantineManifest, 'confirmationDigest'>,
): string {
  if (
    input.schemaVersion !== 1
    || input.environment !== 'staging'
    || !/^[0-9a-f]{40}$/u.test(input.releaseSha)
    || input.databaseFingerprint.trim().length < 1
    || input.databaseFingerprint.length > 512
    || !SHA256.test(input.databaseSnapshotDigest)
    || !SHA256.test(input.auditReportSha256)
    || !SHA256.test(input.sourceAuditInventoryDigest)
    || !BUCKET.test(input.sourceBucket)
    || !BUCKET.test(input.destinationBucket)
    || input.sourceBucket === input.destinationBucket
    || input.entries.length < 1
  ) {
    throw new Error('ARCHIVE_QUARANTINE_MANIFEST_INVALID');
  }
  const canonical = [...input.entries].map(canonicalEntry).sort(compareEntries);
  if (
    new Set(canonical.map(({ sourceKey }) => sourceKey)).size !== canonical.length
    || new Set(canonical.map(({ destinationKey }) => destinationKey)).size !== canonical.length
  ) {
    throw new Error('ARCHIVE_QUARANTINE_MANIFEST_DUPLICATE');
  }
  if (canonical.some((entry) => (
    entry.destinationKey !== expectedDestinationKey(input.sourceAuditInventoryDigest, entry)
  ))) {
    throw new Error('ARCHIVE_QUARANTINE_DESTINATION_DERIVATION_INVALID');
  }
  return createHash('sha256').update(manifestPayload({ ...input, entries: canonical }), 'utf8').digest('hex');
}

function orphanKeys(report: ArchivePreactivationAuditReport): string[] {
  if (
    report.schemaVersion !== 1
    || !SHA256.test(report.inventoryDigest)
    || !BUCKET.test(report.storageBucket)
    || !Number.isSafeInteger(report.counts.storageOrphans)
    || report.counts.storageOrphans < 1
  ) {
    throw new Error('ARCHIVE_QUARANTINE_AUDIT_INVALID');
  }
  const keys = report.issues
    .filter(({ code }) => code === 'STORAGE_OBJECT_WITHOUT_SQL_REFERENCE')
    .map(({ storageKey }) => storageKey)
    .filter((storageKey): storageKey is string => typeof storageKey === 'string')
    .sort();
  if (
    keys.length !== report.counts.storageOrphans
    || new Set(keys).size !== keys.length
    || keys.some((key) => !validStorageKey(key))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_AUDIT_ORPHANS_DIVERGENT');
  }
  return keys;
}

function objectFacts(object: ArchiveQuarantineObject): {
  sha256: string;
  byteSize: number;
  contentType: string;
  createdAt: string;
} {
  const createdAt = new Date(object.createdAt);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== object.createdAt) {
    throw new Error('ARCHIVE_QUARANTINE_OBJECT_CREATED_AT_INVALID');
  }
  return {
    sha256: createHash('sha256').update(object.bytes).digest('hex'),
    byteSize: object.bytes.byteLength,
    contentType: canonicalContentType(object.contentType),
    createdAt: object.createdAt,
  };
}

function exactObject(
  object: ArchiveQuarantineObject | null,
  expected: ArchiveQuarantineManifestEntry,
  includeCreatedAt = false,
): boolean {
  if (object === null) return false;
  const facts = objectFacts(object);
  return facts.sha256 === expected.sha256
    && facts.byteSize === expected.byteSize
    && facts.contentType === expected.contentType
    && (!includeCreatedAt || facts.createdAt === expected.createdAt);
}

/**
 * Inventorie et relit les octets sans aucune mutation. Le digest lie le rapport Archive exact,
 * chaque source réellement relue et chaque destination future.
 */
export async function buildArchiveQuarantineManifest(input: {
  report: ArchivePreactivationAuditReport;
  auditReportSha256: string;
  destinationBucket: string;
  storage: ArchiveQuarantineStorage;
}): Promise<ArchiveQuarantineManifest> {
  if (!BUCKET.test(input.destinationBucket) || input.destinationBucket === input.report.storageBucket) {
    throw new Error('ARCHIVE_QUARANTINE_DESTINATION_INVALID');
  }
  await input.storage.assertPrivateBucket(input.destinationBucket);
  const entries: ArchiveQuarantineManifestEntry[] = [];
  for (const sourceKey of orphanKeys(input.report)) {
    const source = await input.storage.load(input.report.storageBucket, sourceKey);
    if (source === null) throw new Error(`ARCHIVE_QUARANTINE_SOURCE_MISSING:${sourceKey}`);
    const facts = objectFacts(source);
    const entry = {
      sourceKey,
      destinationKey: '',
      ...facts,
    };
    entries.push({
      ...entry,
      destinationKey: expectedDestinationKey(input.report.inventoryDigest, entry),
    });
  }
  const payload = {
    schemaVersion: 1 as const,
    environment: 'staging' as const,
    releaseSha: input.report.releaseSha,
    databaseFingerprint: input.report.databaseFingerprint,
    databaseSnapshotDigest: input.report.databaseSnapshotDigest,
    auditReportSha256: input.auditReportSha256,
    sourceAuditInventoryDigest: input.report.inventoryDigest,
    sourceBucket: input.report.storageBucket,
    destinationBucket: input.destinationBucket,
    entries: entries.sort(compareEntries),
  };
  return { ...payload, confirmationDigest: archiveQuarantineManifestDigest(payload) };
}

function validatedManifest(manifest: ArchiveQuarantineManifest): ArchiveQuarantineManifest {
  const payload = {
    schemaVersion: manifest.schemaVersion,
    environment: manifest.environment,
    releaseSha: manifest.releaseSha,
    databaseFingerprint: manifest.databaseFingerprint,
    databaseSnapshotDigest: manifest.databaseSnapshotDigest,
    auditReportSha256: manifest.auditReportSha256,
    sourceAuditInventoryDigest: manifest.sourceAuditInventoryDigest,
    sourceBucket: manifest.sourceBucket,
    destinationBucket: manifest.destinationBucket,
    entries: [...manifest.entries].map(canonicalEntry).sort(compareEntries),
  };
  const digest = archiveQuarantineManifestDigest(payload);
  if (manifest.confirmationDigest !== digest) {
    throw new Error('ARCHIVE_QUARANTINE_MANIFEST_DIGEST_MISMATCH');
  }
  return { ...payload, confirmationDigest: digest };
}

function exactEntries(
  actual: readonly ArchiveQuarantineManifestEntry[],
  expected: readonly ArchiveQuarantineManifestEntry[],
): boolean {
  try {
    const canonicalActual = actual.map(canonicalEntry).sort(compareEntries);
    const canonicalExpected = expected.map(canonicalEntry).sort(compareEntries);
    return JSON.stringify(canonicalActual) === JSON.stringify(canonicalExpected);
  } catch {
    return false;
  }
}

function parseCompletedReceipt(
  bytes: Uint8Array,
  manifest: ArchiveQuarantineManifest,
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
  const completedAt = typeof receipt.completedAt === 'string'
    ? new Date(receipt.completedAt)
    : new Date(Number.NaN);
  if (
    Object.keys(receipt).sort().join('\u0000') !== [
      'completedAt',
      'destinationBucket',
      'entries',
      'manifestDigest',
      'phase',
      'receiptSha256',
      'schemaVersion',
      'sourceBucket',
    ].sort().join('\u0000')
    || receipt.schemaVersion !== 1
    || receipt.phase !== 'completed'
    || receipt.manifestDigest !== manifest.confirmationDigest
    || receipt.sourceBucket !== manifest.sourceBucket
    || receipt.destinationBucket !== manifest.destinationBucket
    || !Number.isFinite(completedAt.getTime())
    || completedAt.toISOString() !== receipt.completedAt
    || !Array.isArray(receipt.entries)
    || !exactEntries(
      receipt.entries as ArchiveQuarantineManifestEntry[],
      manifest.entries,
    )
    || typeof receipt.receiptSha256 !== 'string'
    || !SHA256.test(receipt.receiptSha256)
  ) {
    throw new Error('ARCHIVE_QUARANTINE_FINAL_RECEIPT_INVALID');
  }
  const payload = {
    schemaVersion: 1 as const,
    phase: 'completed' as const,
    manifestDigest: manifest.confirmationDigest,
    sourceBucket: manifest.sourceBucket,
    destinationBucket: manifest.destinationBucket,
    completedAt: receipt.completedAt,
    entries: manifest.entries,
  };
  if (
    createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
    !== receipt.receiptSha256
  ) {
    throw new Error('ARCHIVE_QUARANTINE_FINAL_RECEIPT_INVALID');
  }
  return { ...payload, receiptSha256: receipt.receiptSha256 };
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
    if (source !== null || !exactObject(destination, entry)) {
      throw new Error(`ARCHIVE_QUARANTINE_FINAL_STATE_INVALID:${entry.sourceKey}`);
    }
  }
}

/**
 * Reprise idempotente : toutes les copies sont relues et vérifiées avant le premier retrait.
 * Une source absente n'est acceptée qu'après relecture du receipt durable `copied_verified`.
 */
export async function applyArchiveQuarantine(input: {
  manifest: ArchiveQuarantineManifest;
  confirmation: string;
  authorization: ArchiveQuarantineAuthorization;
  completedAt: string;
  storage: ArchiveQuarantineStorage;
  guard: ArchiveQuarantineSafetyGuard;
  authorizationVerifier: ArchiveQuarantineAuthorizationVerifier;
}): Promise<ArchiveQuarantineReceipt> {
  const manifest = validatedManifest(input.manifest);
  if (input.confirmation !== `QUARANTINE-STAGING:${manifest.confirmationDigest}`) {
    throw new Error('ARCHIVE_QUARANTINE_CONFIRMATION_REQUIRED');
  }
  const authorizedAt = new Date(input.authorization.founderAuthorizedAt);
  if (
    input.authorization.schemaVersion !== 1
    || input.authorization.environment !== 'staging'
    || input.authorization.manifestDigest !== manifest.confirmationDigest
    || !Number.isFinite(authorizedAt.getTime())
    || authorizedAt.toISOString() !== input.authorization.founderAuthorizedAt
    || input.authorization.founderChannel.trim().length < 1
    || input.authorization.founderChannel.length > 256
    || !Array.isArray(input.authorization.countersignedBy)
    || input.authorization.countersignedBy.length !== 2
    || input.authorization.countersignedBy[0] !== 'claude'
    || input.authorization.countersignedBy[1] !== 'gpt'
  ) {
    throw new Error('ARCHIVE_QUARANTINE_FOUNDER_AUTHORIZATION_REQUIRED');
  }
  const completedAt = new Date(input.completedAt);
  if (
    !Number.isFinite(completedAt.getTime())
    || completedAt.toISOString() !== input.completedAt
    || completedAt.getTime() < authorizedAt.getTime()
  ) {
    throw new Error('ARCHIVE_QUARANTINE_COMPLETED_AT_INVALID');
  }
  await input.authorizationVerifier.assertAuthenticated(input.authorization, manifest);
  await input.storage.assertPrivateBucket(manifest.destinationBucket);
  await input.guard.assertManifestFresh(manifest);

  const encoder = new TextEncoder();
  const copyReceipt: ArchiveQuarantineCopyReceipt = {
    schemaVersion: 1,
    phase: 'copied_verified',
    manifestDigest: manifest.confirmationDigest,
    sourceBucket: manifest.sourceBucket,
    destinationBucket: manifest.destinationBucket,
    entries: manifest.entries,
  };
  const copyReceiptBytes = encoder.encode(`${JSON.stringify(copyReceipt)}\n`);
  const copyReceiptKey = `receipts/${manifest.confirmationDigest}/copied-verified.json`;
  const finalReceiptKey = `receipts/${manifest.confirmationDigest}/completed.json`;

  const existingFinal = await input.storage.load(manifest.destinationBucket, finalReceiptKey);
  if (existingFinal !== null) {
    const receipt = parseCompletedReceipt(existingFinal.bytes, manifest);
    await assertFinalStorageState(input.storage, manifest);
    await input.guard.assertFinalClean(manifest);
    return receipt;
  }

  const existingCopyReceipt = await input.storage.load(
    manifest.destinationBucket,
    copyReceiptKey,
  );
  const durableCopyReceiptPresent = existingCopyReceipt !== null;
  if (
    existingCopyReceipt !== null
    && !Buffer.from(existingCopyReceipt.bytes).equals(Buffer.from(copyReceiptBytes))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_COPY_RECEIPT_CONFLICT');
  }
  await input.guard.assertSafeToDelete(manifest, { durableCopyReceiptPresent });

  const sourcePresence = new Map<string, boolean>();
  for (const entry of manifest.entries) {
    const [source, destination] = await Promise.all([
      input.storage.load(manifest.sourceBucket, entry.sourceKey),
      input.storage.load(manifest.destinationBucket, entry.destinationKey),
    ]);
    if (source !== null && !exactObject(source, entry, true)) {
      throw new Error(`ARCHIVE_QUARANTINE_SOURCE_CHANGED:${entry.sourceKey}`);
    }
    if (destination !== null && !exactObject(destination, entry)) {
      throw new Error(`ARCHIVE_QUARANTINE_DESTINATION_COLLISION:${entry.destinationKey}`);
    }
    if (source === null && !durableCopyReceiptPresent) {
      throw new Error(`ARCHIVE_QUARANTINE_SOURCE_MISSING_BEFORE_RECEIPT:${entry.sourceKey}`);
    }
    if (source === null && destination === null) {
      throw new Error(`ARCHIVE_QUARANTINE_OBJECT_LOST:${entry.sourceKey}`);
    }
    sourcePresence.set(entry.sourceKey, source !== null);
    if (destination === null) {
      await input.storage.copy(
        manifest.sourceBucket,
        entry.sourceKey,
        manifest.destinationBucket,
        entry.destinationKey,
      );
    }
    const copied = await input.storage.load(manifest.destinationBucket, entry.destinationKey);
    if (!exactObject(copied, entry)) {
      throw new Error(`ARCHIVE_QUARANTINE_COPY_UNVERIFIED:${entry.destinationKey}`);
    }
  }

  await input.guard.assertSafeToDelete(manifest, { durableCopyReceiptPresent });
  if (!durableCopyReceiptPresent) {
    await input.storage.putImmutable(
      manifest.destinationBucket,
      copyReceiptKey,
      copyReceiptBytes,
      'application/json',
    );
    const persistedReceipt = await input.storage.load(manifest.destinationBucket, copyReceiptKey);
    if (
      persistedReceipt === null
      || !Buffer.from(persistedReceipt.bytes).equals(Buffer.from(copyReceiptBytes))
    ) {
      throw new Error('ARCHIVE_QUARANTINE_COPY_RECEIPT_UNVERIFIED');
    }
  }

  for (const entry of manifest.entries) {
    if (sourcePresence.get(entry.sourceKey)) {
      await input.guard.assertManifestFresh(manifest);
      await input.guard.assertSafeToDelete(manifest, { durableCopyReceiptPresent: true });
      const removed = await input.storage.removeExact(
        manifest.sourceBucket,
        entry.sourceKey,
        entry,
      );
      if (!removed) {
        throw new Error(`ARCHIVE_QUARANTINE_SOURCE_MISSING_BEFORE_DELETE:${entry.sourceKey}`);
      }
    }
    const [source, destination] = await Promise.all([
      input.storage.load(manifest.sourceBucket, entry.sourceKey),
      input.storage.load(manifest.destinationBucket, entry.destinationKey),
    ]);
    if (source !== null || !exactObject(destination, entry)) {
      throw new Error(`ARCHIVE_QUARANTINE_FINAL_STATE_INVALID:${entry.sourceKey}`);
    }
  }

  await assertFinalStorageState(input.storage, manifest);
  await input.guard.assertFinalClean(manifest);

  const receiptPayload = {
    schemaVersion: 1 as const,
    phase: 'completed' as const,
    manifestDigest: manifest.confirmationDigest,
    sourceBucket: manifest.sourceBucket,
    destinationBucket: manifest.destinationBucket,
    completedAt: input.completedAt,
    entries: manifest.entries,
  };
  const receiptSha256 = createHash('sha256')
    .update(JSON.stringify(receiptPayload), 'utf8')
    .digest('hex');
  const receipt = { ...receiptPayload, receiptSha256 };
  const receiptBytes = encoder.encode(`${JSON.stringify(receipt)}\n`);
  await input.storage.putImmutable(
    manifest.destinationBucket,
    finalReceiptKey,
    receiptBytes,
    'application/json',
  );
  const persistedFinal = await input.storage.load(manifest.destinationBucket, finalReceiptKey);
  if (
    persistedFinal === null
    || !Buffer.from(persistedFinal.bytes).equals(Buffer.from(receiptBytes))
  ) {
    throw new Error('ARCHIVE_QUARANTINE_FINAL_RECEIPT_UNVERIFIED');
  }
  return receipt;
}
