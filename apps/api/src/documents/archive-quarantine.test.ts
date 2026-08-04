import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ArchivePreactivationAuditReport } from './archive-preactivation-audit';
import {
  applyArchiveQuarantine,
  buildArchiveQuarantineManifest,
  type ArchiveQuarantineAuthorization,
  type ArchiveQuarantineAuthorizationVerifier,
  type ArchiveQuarantineManifest,
  type ArchiveQuarantineObject,
  type ArchiveQuarantineSafetyGuard,
  type ArchiveQuarantineStorage,
} from './archive-quarantine';

const RELEASE_SHA = 'a'.repeat(40);
const INVENTORY_SHA = 'b'.repeat(64);
const SNAPSHOT_SHA = 'c'.repeat(64);
const REPORT_SHA = 'd'.repeat(64);
const CREATED_AT = '2026-08-04T12:00:00.000Z';
const COMPLETED_AT = '2026-08-04T13:00:00.000Z';

function report(keys: string[]): ArchivePreactivationAuditReport {
  return {
    schemaVersion: 1,
    auditedAt: CREATED_AT,
    releaseSha: RELEASE_SHA,
    databaseFingerprint: 'staging-project:database-system-1',
    databaseSnapshotDigest: SNAPSHOT_SHA,
    storageBucket: 'bob-documents',
    inventoryDigest: INVENTORY_SHA,
    protocolVersion: 2,
    mode: 'protocol-v2-verified',
    validators: { representationDetector: 1, mustang: '2.24.0', fnfe: '1.4.0.02' },
    readyForActivation: false,
    counts: {
      generatedLegalDocuments: 0,
      objectsRead: 0,
      existingAttestations: 0,
      appliedAttestations: 0,
      externallyValidatedProfessionalInvoices: 0,
      storageOrphans: keys.length,
      missingStoredObjects: 0,
      p0Issues: keys.length + 1,
    },
    issues: keys.map((storageKey) => ({
      severity: 'P0',
      code: 'STORAGE_OBJECT_WITHOUT_SQL_REFERENCE',
      storageKey,
      detail: 'orphan fixture',
    })),
  };
}

function object(value: string, createdAt = CREATED_AT): ArchiveQuarantineObject {
  return {
    bytes: new TextEncoder().encode(value),
    contentType: 'application/pdf; charset=binary',
    createdAt,
  };
}

function storageKey(bucket: string, key: string): string {
  return `${bucket}\u0000${key}`;
}

class MemoryStorage implements ArchiveQuarantineStorage {
  readonly objects = new Map<string, ArchiveQuarantineObject>();
  readonly operations: string[] = [];
  failRemoveAfter = Number.POSITIVE_INFINITY;
  mutateBeforeRemove = false;
  private removeCount = 0;

  async assertPrivateBucket(bucket: string): Promise<void> {
    this.operations.push(`private:${bucket}`);
    if (bucket !== 'archive-quarantine') throw new Error('bucket is not private');
  }

  async load(bucket: string, key: string): Promise<ArchiveQuarantineObject | null> {
    this.operations.push(`load:${bucket}:${key}`);
    return this.objects.get(storageKey(bucket, key)) ?? null;
  }

  async copy(
    sourceBucket: string,
    sourceKey: string,
    destinationBucket: string,
    destinationKey: string,
  ): Promise<void> {
    this.operations.push(`copy:${sourceKey}`);
    const source = this.objects.get(storageKey(sourceBucket, sourceKey));
    if (!source) throw new Error('source missing');
    const destination = storageKey(destinationBucket, destinationKey);
    if (this.objects.has(destination)) throw new Error('destination exists');
    this.objects.set(destination, { ...source, createdAt: '2026-08-04T12:30:00.000Z' });
  }

  async removeExact(
    bucket: string,
    key: string,
    expected: ArchiveQuarantineManifest['entries'][number],
  ): Promise<boolean> {
    this.operations.push(`remove:${key}`);
    this.removeCount += 1;
    if (this.removeCount > this.failRemoveAfter) throw new Error('simulated remove crash');
    const target = storageKey(bucket, key);
    if (this.mutateBeforeRemove) {
      this.objects.set(target, object('replaced-after-copy-receipt', expected.createdAt));
      this.mutateBeforeRemove = false;
    }
    const current = this.objects.get(target);
    if (!current) return false;
    const currentContentType = (current.contentType.split(';')[0] ?? '').trim().toLowerCase();
    if (
      current.createdAt !== expected.createdAt
      || current.bytes.byteLength !== expected.byteSize
      || currentContentType !== expected.contentType
      || createHash('sha256').update(current.bytes).digest('hex') !== expected.sha256
    ) {
      throw new Error('ARCHIVE_QUARANTINE_CONDITIONAL_DELETE_MISMATCH');
    }
    this.objects.delete(target);
    return true;
  }

  async putImmutable(
    bucket: string,
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    this.operations.push(`put:${key}`);
    const target = storageKey(bucket, key);
    if (this.objects.has(target)) throw new Error('immutable collision');
    this.objects.set(target, {
      bytes,
      contentType,
      createdAt: '2026-08-04T12:45:00.000Z',
    });
  }
}

function guard(): ArchiveQuarantineSafetyGuard & {
  assertManifestFresh: ReturnType<typeof vi.fn>;
  assertSafeToDelete: ReturnType<typeof vi.fn>;
  assertFinalClean: ReturnType<typeof vi.fn>;
} {
  return {
    assertManifestFresh: vi.fn(async () => undefined),
    assertSafeToDelete: vi.fn(async () => undefined),
    assertFinalClean: vi.fn(async () => undefined),
  };
}

function verifier(): ArchiveQuarantineAuthorizationVerifier & {
  assertAuthenticated: ReturnType<typeof vi.fn>;
} {
  return { assertAuthenticated: vi.fn(async () => undefined) };
}

function authorization(manifest: ArchiveQuarantineManifest): ArchiveQuarantineAuthorization {
  return {
    schemaVersion: 1,
    environment: 'staging',
    manifestDigest: manifest.confirmationDigest,
    founderAuthorizedAt: '2026-08-04T12:55:00.000Z',
    founderChannel: 'conversation fondateur 2026-08-04',
    countersignedBy: ['claude', 'gpt'],
  };
}

async function manifestFor(storage: MemoryStorage, keys: string[]): Promise<ArchiveQuarantineManifest> {
  for (const key of keys) storage.objects.set(storageKey('bob-documents', key), object(key));
  return buildArchiveQuarantineManifest({
    report: report(keys),
    auditReportSha256: REPORT_SHA,
    destinationBucket: 'archive-quarantine',
    storage,
  });
}

describe('quarantaine historique des orphelins Archive', () => {
  it('construit un plan déterministe sans mutation et ne place aucune clé brute en destination', async () => {
    const left = new MemoryStorage();
    const right = new MemoryStorage();
    const keys = [
      'companies/company-b/documents/Facture Client sensible.pdf',
      'companies/company-a/documents/orphan.pdf',
    ];
    const leftManifest = await manifestFor(left, keys);
    const rightManifest = await manifestFor(right, [...keys].reverse());

    expect(leftManifest).toEqual(rightManifest);
    expect(left.operations.some((operation) => operation.startsWith('copy:'))).toBe(false);
    expect(left.operations.some((operation) => operation.startsWith('remove:'))).toBe(false);
    expect(leftManifest.entries.map(({ sourceKey }) => sourceKey)).toEqual([...keys].sort());
    expect(leftManifest.entries.every(({ destinationKey, sourceKey }) => (
      !destinationKey.includes(sourceKey) && !destinationKey.includes('sensible')
    ))).toBe(true);
  });

  it('refuse confirmation ou autorisation divergente avant toute mutation', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage, ['companies/company-a/documents/orphan.pdf']);
    const safety = guard();
    const baseline = new Map(storage.objects);

    await expect(applyArchiveQuarantine({
      manifest,
      confirmation: manifest.confirmationDigest,
      authorization: authorization(manifest),
      completedAt: COMPLETED_AT,
      storage,
      guard: safety,
      authorizationVerifier: verifier(),
    })).rejects.toThrow('ARCHIVE_QUARANTINE_CONFIRMATION_REQUIRED');
    await expect(applyArchiveQuarantine({
      manifest,
      confirmation: `QUARANTINE-STAGING:${manifest.confirmationDigest}`,
      authorization: { ...authorization(manifest), manifestDigest: 'e'.repeat(64) },
      completedAt: COMPLETED_AT,
      storage,
      guard: safety,
      authorizationVerifier: verifier(),
    })).rejects.toThrow('ARCHIVE_QUARANTINE_FOUNDER_AUTHORIZATION_REQUIRED');
    expect(storage.objects).toEqual(baseline);
    expect(storage.operations.some((operation) => /^(?:copy|put|remove):/u.test(operation))).toBe(false);
  });

  it('copie et relit tout, scelle le receipt, puis seulement retire les sources', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage, [
      'companies/company-b/documents/orphan-b.pdf',
      'companies/company-a/documents/orphan-a.pdf',
    ]);
    const safety = guard();
    storage.operations.length = 0;
    const receipt = await applyArchiveQuarantine({
      manifest,
      confirmation: `QUARANTINE-STAGING:${manifest.confirmationDigest}`,
      authorization: authorization(manifest),
      completedAt: COMPLETED_AT,
      storage,
      guard: safety,
      authorizationVerifier: verifier(),
    });

    expect(receipt.phase).toBe('completed');
    expect(receipt.receiptSha256).toMatch(/^[0-9a-f]{64}$/u);
    const copyReceiptIndex = storage.operations.findIndex((operation) =>
      operation === `put:receipts/${manifest.confirmationDigest}/copied-verified.json`);
    const firstRemoveIndex = storage.operations.findIndex((operation) => operation.startsWith('remove:'));
    expect(copyReceiptIndex).toBeGreaterThanOrEqual(0);
    expect(firstRemoveIndex).toBeGreaterThan(copyReceiptIndex);
    expect(safety.assertSafeToDelete).toHaveBeenCalledTimes(4);
    expect(safety.assertManifestFresh).toHaveBeenCalledTimes(3);
    expect(safety.assertFinalClean).toHaveBeenCalledOnce();
    expect(manifest.entries.every(({ sourceKey }) => (
      !storage.objects.has(storageKey(manifest.sourceBucket, sourceKey))
    ))).toBe(true);
  });

  it('refuse une collision destination sans supprimer la moindre source', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage, ['companies/company-a/documents/orphan.pdf']);
    const [entry] = manifest.entries;
    storage.objects.set(
      storageKey(manifest.destinationBucket, entry!.destinationKey),
      object('different', '2026-08-04T12:30:00.000Z'),
    );
    await expect(applyArchiveQuarantine({
      manifest,
      confirmation: `QUARANTINE-STAGING:${manifest.confirmationDigest}`,
      authorization: authorization(manifest),
      completedAt: COMPLETED_AT,
      storage,
      guard: guard(),
      authorizationVerifier: verifier(),
    })).rejects.toThrow('ARCHIVE_QUARANTINE_DESTINATION_COLLISION');
    expect(storage.objects.has(storageKey(manifest.sourceBucket, entry!.sourceKey))).toBe(true);
    expect(storage.operations.some((operation) => operation.startsWith('remove:'))).toBe(false);
  });

  it('authentifie la décision et refuse un objet remplacé juste avant le DELETE conditionnel', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage, ['companies/company-a/documents/orphan.pdf']);
    const rejectedVerifier: ArchiveQuarantineAuthorizationVerifier = {
      assertAuthenticated: vi.fn(async () => {
        throw new Error('ARCHIVE_QUARANTINE_AUTHENTICATION_FAILED');
      }),
    };
    const common = {
      manifest,
      confirmation: `QUARANTINE-STAGING:${manifest.confirmationDigest}`,
      authorization: authorization(manifest),
      completedAt: COMPLETED_AT,
      storage,
      guard: guard(),
    };
    const baseline = new Map(storage.objects);
    await expect(applyArchiveQuarantine({
      ...common,
      authorizationVerifier: rejectedVerifier,
    })).rejects.toThrow('ARCHIVE_QUARANTINE_AUTHENTICATION_FAILED');
    expect(storage.objects).toEqual(baseline);

    storage.mutateBeforeRemove = true;
    await expect(applyArchiveQuarantine({
      ...common,
      authorizationVerifier: verifier(),
    })).rejects.toThrow('ARCHIVE_QUARANTINE_CONDITIONAL_DELETE_MISMATCH');
    const [entry] = manifest.entries;
    expect(storage.objects.has(storageKey(manifest.sourceBucket, entry!.sourceKey))).toBe(true);
  });

  it('reprend après crash post-receipt sans exiger une source déjà retirée', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage, [
      'companies/company-a/documents/orphan-a.pdf',
      'companies/company-b/documents/orphan-b.pdf',
    ]);
    storage.failRemoveAfter = 1;
    const input = {
      manifest,
      confirmation: `QUARANTINE-STAGING:${manifest.confirmationDigest}`,
      authorization: authorization(manifest),
      completedAt: COMPLETED_AT,
      storage,
      guard: guard(),
      authorizationVerifier: verifier(),
    };
    await expect(applyArchiveQuarantine(input)).rejects.toThrow('simulated remove crash');
    expect(storage.objects.has(storageKey(
      manifest.destinationBucket,
      `receipts/${manifest.confirmationDigest}/copied-verified.json`,
    ))).toBe(true);
    storage.failRemoveAfter = Number.POSITIVE_INFINITY;
    await expect(applyArchiveQuarantine({
      ...input,
      guard: guard(),
      authorizationVerifier: verifier(),
    })).resolves.toMatchObject({
      phase: 'completed',
      manifestDigest: manifest.confirmationDigest,
    });
  });

  it('lie le plan aux octets, dates, rapport et identité de staging', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage, ['companies/company-a/documents/orphan.pdf']);
    const changed = {
      ...manifest,
      databaseSnapshotDigest: 'f'.repeat(64),
    };
    expect(createHash('sha256').update(JSON.stringify(changed)).digest('hex')).not.toBe(
      manifest.confirmationDigest,
    );
    await expect(applyArchiveQuarantine({
      manifest: changed,
      confirmation: `QUARANTINE-STAGING:${manifest.confirmationDigest}`,
      authorization: authorization(manifest),
      completedAt: COMPLETED_AT,
      storage,
      guard: guard(),
      authorizationVerifier: verifier(),
    })).rejects.toThrow('ARCHIVE_QUARANTINE_MANIFEST_DIGEST_MISMATCH');
  });

  it('refuse une destination non dérivée et un receipt final incomplet', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage, ['companies/company-a/documents/orphan.pdf']);
    const [entry] = manifest.entries;
    const redirected = {
      ...manifest,
      entries: [{ ...entry!, destinationKey: 'v1/manual/orphan.pdf' }],
    };
    await expect(applyArchiveQuarantine({
      manifest: redirected,
      confirmation: `QUARANTINE-STAGING:${manifest.confirmationDigest}`,
      authorization: authorization(manifest),
      completedAt: COMPLETED_AT,
      storage,
      guard: guard(),
      authorizationVerifier: verifier(),
    })).rejects.toThrow('ARCHIVE_QUARANTINE_DESTINATION_DERIVATION_INVALID');

    const finalKey = `receipts/${manifest.confirmationDigest}/completed.json`;
    storage.objects.set(storageKey(manifest.destinationBucket, finalKey), {
      bytes: new TextEncoder().encode(JSON.stringify({
        schemaVersion: 1,
        phase: 'completed',
        manifestDigest: manifest.confirmationDigest,
        receiptSha256: 'e'.repeat(64),
      })),
      contentType: 'application/json',
      createdAt: CREATED_AT,
    });
    await expect(applyArchiveQuarantine({
      manifest,
      confirmation: `QUARANTINE-STAGING:${manifest.confirmationDigest}`,
      authorization: authorization(manifest),
      completedAt: COMPLETED_AT,
      storage,
      guard: guard(),
      authorizationVerifier: verifier(),
    })).rejects.toThrow('ARCHIVE_QUARANTINE_FINAL_RECEIPT_INVALID');
  });
});
