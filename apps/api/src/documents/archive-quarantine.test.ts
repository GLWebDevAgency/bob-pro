import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  applyArchiveQuarantine,
  buildArchiveQuarantineManifest,
  finalizeArchiveQuarantine,
  type ArchiveQuarantineAuthorization,
  type ArchiveQuarantineAuthorizationVerifier,
  type ArchiveQuarantineFinalAuditEvidence,
  type ArchiveQuarantineManifest,
  type ArchiveQuarantineObject,
  type ArchiveQuarantineSafetyGuard,
  type ArchiveQuarantineStorage,
  type ArchiveQuarantineTarget,
} from './archive-quarantine';
import type { ArchivePreactivationAuditReport } from './archive-preactivation-audit';

const CREATED_AT = '2026-08-03T11:34:16.123456Z';
const UPDATED_AT = '2026-08-03T11:34:16.654321Z';
const AUTHORIZED_AT = '2026-08-05T00:00:00.000Z';
const DELETED_AT = '2026-08-05T01:00:00.000Z';
const COMPLETED_AT = '2026-08-05T02:00:00.000Z';
const STORAGE_WRITTEN_AT = '2026-08-05T01:00:00.000000Z';
const COMPANY_ID = 'company-a';
const RELEASE_SHA = 'a'.repeat(40);
const SNAPSHOT_SHA = 'b'.repeat(64);
const INVENTORY_SHA = 'c'.repeat(64);
const REPORT_SHA = 'd'.repeat(64);
const AUDIT_DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceFixture(index: number): { key: string; object: ArchiveQuarantineObject } {
  const bytes = new TextEncoder().encode(`pdf-${index}`);
  const sha256 = digest(bytes);
  return {
    key: `companies/${COMPANY_ID}/documents/document-${index}/v1/${sha256}.pdf`,
    object: {
      bytes,
      contentType: 'application/pdf',
      objectId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      version: `version-${index}`,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      metadata: { cacheControl: 'no-cache', fixture: index },
      userMetadata: null,
    },
  };
}

const SOURCES = Array.from({ length: 5 }, (_, index) => sourceFixture(index + 1));
const TARGET: ArchiveQuarantineTarget = {
  companyIdSha256: digest(COMPANY_ID),
  sourceKeySha256s: SOURCES.map(({ key }) => digest(key)),
};

function report(overrides: Partial<ArchivePreactivationAuditReport> = {}): ArchivePreactivationAuditReport {
  return {
    schemaVersion: 1,
    auditedAt: '2026-08-05T00:30:00.000Z',
    releaseSha: RELEASE_SHA,
    databaseFingerprint: 'staging-database',
    databaseSnapshotDigest: SNAPSHOT_SHA,
    storageBucket: 'bob-documents',
    inventoryDigest: INVENTORY_SHA,
    protocolVersion: 2,
    mode: 'protocol-v2-verified',
    validators: { representationDetector: 1, mustang: '2.24.0', fnfe: '1.4.0.02' },
    readyForActivation: false,
    counts: {
      generatedLegalDocuments: 1,
      objectsRead: 1,
      existingAttestations: 0,
      appliedAttestations: 0,
      externallyValidatedProfessionalInvoices: 0,
      storageOrphans: 5,
      missingStoredObjects: 0,
      p0Issues: 6,
    },
    issues: [
      ...SOURCES.map(({ key }) => ({
        severity: 'P0' as const,
        code: 'STORAGE_OBJECT_WITHOUT_SQL_REFERENCE',
        storageKey: key,
        detail: 'private',
      })),
      {
        severity: 'P0',
        code: 'ARCHIVE_PROTOCOL_V2_STORAGE_ORPHAN_PRESENT',
        detail: 'aggregate',
      },
    ],
    ...overrides,
  };
}

function storageMapKey(bucket: string, key: string): string {
  return `${bucket}\u0000${key}`;
}

class MemoryStorage implements ArchiveQuarantineStorage {
  readonly objects = new Map<string, ArchiveQuarantineObject>();
  readonly operations: string[] = [];
  readonly privateBuckets = new Set(['bob-documents', 'archive-quarantine']);
  removeCount = 0;
  failAfterRemoveCount = Number.POSITIVE_INFINITY;
  loseDeleteAcknowledgement = false;

  constructor() {
    for (const source of SOURCES) {
      this.objects.set(storageMapKey('bob-documents', source.key), source.object);
    }
  }

  async assertPrivateBucket(bucket: string): Promise<void> {
    if (!this.privateBuckets.has(bucket)) throw new Error('ARCHIVE_QUARANTINE_BUCKET_NOT_PRIVATE');
  }

  async load(bucket: string, key: string): Promise<ArchiveQuarantineObject | null> {
    const value = this.objects.get(storageMapKey(bucket, key));
    return value === undefined ? null : { ...value, bytes: new Uint8Array(value.bytes) };
  }

  async putImmutable(
    bucket: string,
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    this.operations.push(`put:${digest(key)}`);
    const storageKey = storageMapKey(bucket, key);
    if (this.objects.has(storageKey)) throw new Error('ARCHIVE_QUARANTINE_DESTINATION_EXISTS');
    this.objects.set(storageKey, {
      bytes: new Uint8Array(bytes),
      contentType,
      objectId: randomUUID(),
      version: randomUUID(),
      createdAt: STORAGE_WRITTEN_AT,
      updatedAt: STORAGE_WRITTEN_AT,
      metadata: { cacheControl: 'no-cache' },
      userMetadata: null,
    });
  }

  async removeFenced(bucket: string, key: string): Promise<void> {
    this.operations.push(`remove:${digest(key)}`);
    this.objects.delete(storageMapKey(bucket, key));
    this.removeCount += 1;
    if (this.removeCount >= this.failAfterRemoveCount) throw new Error('simulated remove crash');
    if (this.loseDeleteAcknowledgement) throw new Error('simulated lost delete acknowledgement');
  }
}

function safetyGuard(): ArchiveQuarantineSafetyGuard {
  return {
    assertPlanSealed: vi.fn(async () => undefined),
    recordAuthorized: vi.fn(async () => undefined),
    recordDestinationVerified: vi.fn(async () => undefined),
    recordCopiedVerified: vi.fn(async () => undefined),
    assertEntryDeleteSafe: vi.fn(async () => undefined),
    assertSourceDeleted: vi.fn(async () => undefined),
    assertFinalSnapshotClean: vi.fn(async () => undefined),
    recordDeletedVerified: vi.fn(async () => undefined),
    recordFinalAuditVerified: vi.fn(async () => undefined),
    recordCompleted: vi.fn(async () => undefined),
  };
}

function verifier(reject = false): ArchiveQuarantineAuthorizationVerifier {
  return {
    assertAuthenticated: vi.fn(async () => {
      if (reject) throw new Error('ARCHIVE_QUARANTINE_OIDC_REJECTED');
    }),
  };
}

function authorization(manifest: ArchiveQuarantineManifest): ArchiveQuarantineAuthorization {
  return {
    schemaVersion: 2,
    environment: 'staging',
    manifestDigest: manifest.confirmationDigest,
    authorizationRecordedAt: AUTHORIZED_AT,
    authorizationChannel: 'github-actions:workflow_dispatch',
    workflow: {
      issuer: 'https://token.actions.githubusercontent.com',
      audience: 'bob-document-archive-quarantine-staging',
      repository: 'GLWebDevAgency/bob-pro',
      ref: 'refs/heads/main',
      sha: manifest.releaseSha,
      environment: 'staging',
      workflowRef: 'GLWebDevAgency/bob-pro/.github/workflows/document-archive-quarantine-staging.yml@refs/heads/main',
      workflowSha: RELEASE_SHA,
      eventName: 'workflow_dispatch',
      subject: 'repo:GLWebDevAgency/bob-pro:environment:staging',
      repositoryId: '1286748365',
      repositoryOwnerId: '84627817',
      actor: 'founder',
      actorId: '84627817',
      runId: '123456789',
      runAttempt: 1,
      tokenSha256: 'f'.repeat(64),
    },
  };
}

async function manifestFor(storage: MemoryStorage): Promise<ArchiveQuarantineManifest> {
  return buildArchiveQuarantineManifest({
    report: report(),
    auditDeploymentId: AUDIT_DEPLOYMENT_ID,
    auditReportSha256: REPORT_SHA,
    destinationBucket: 'archive-quarantine',
    target: TARGET,
    storage,
  });
}

function applyInput(
  manifest: ArchiveQuarantineManifest,
  storage: MemoryStorage,
  guard = safetyGuard(),
) {
  return {
    manifest,
    confirmation: `QUARANTINE-STAGING:${manifest.confirmationDigest}`,
    authorization: authorization(manifest),
    deletedAt: DELETED_AT,
    storage,
    guard,
    authorizationVerifier: verifier(),
  };
}

function finalAudit(manifest: ArchiveQuarantineManifest): ArchiveQuarantineFinalAuditEvidence {
  return {
    deploymentId: '22222222-2222-4222-8222-222222222222',
    releaseSha: manifest.releaseSha,
    databaseFingerprint: manifest.databaseFingerprint,
    databaseSnapshotDigest: 'e'.repeat(64),
    storageBucket: manifest.sourceBucket,
    inventoryDigest: '1'.repeat(64),
    reportSha256: '2'.repeat(64),
    auditedAt: '2026-08-05T01:30:00.000Z',
    readyForActivation: true,
    storageOrphans: 0,
    missingStoredObjects: 0,
    p0Issues: 0,
  };
}

describe('quarantaine Archive FLY fermée', () => {
  it('lie exactement cinq PDF, un tenant hashé, l’audit et les métadonnées Storage', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage);
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      environment: 'staging',
      releaseSha: RELEASE_SHA,
      auditDeploymentId: AUDIT_DEPLOYMENT_ID,
      auditReportSha256: REPORT_SHA,
      sourceAuditInventoryDigest: INVENTORY_SHA,
      companyIdSha256: digest(COMPANY_ID),
    });
    expect(manifest.entries).toHaveLength(5);
    expect(manifest.entries.map(({ sourceKeySha256 }) => sourceKeySha256).sort()).toEqual(
      [...TARGET.sourceKeySha256s].sort(),
    );
    expect(manifest.entries.every(({ sourceObjectId, sourceStorageMetadataDigest }) => (
      /^[0-9a-f-]{36}$/u.test(sourceObjectId) && /^[0-9a-f]{64}$/u.test(sourceStorageMetadataDigest)
    ))).toBe(true);
  });

  it('refuse tout élargissement : sixième objet, autre tenant, chantier ou code étranger', async () => {
    const storage = new MemoryStorage();
    const sixth = sourceFixture(6);
    storage.objects.set(storageMapKey('bob-documents', sixth.key), sixth.object);
    await expect(buildArchiveQuarantineManifest({
      report: report({
        counts: { ...report().counts, storageOrphans: 6, p0Issues: 7 },
        issues: [
          ...report().issues,
          { severity: 'P0', code: 'STORAGE_OBJECT_WITHOUT_SQL_REFERENCE', storageKey: sixth.key, detail: 'private' },
        ],
      }),
      auditDeploymentId: AUDIT_DEPLOYMENT_ID,
      auditReportSha256: REPORT_SHA,
      destinationBucket: 'archive-quarantine',
      target: { ...TARGET, sourceKeySha256s: [...TARGET.sourceKeySha256s, digest(sixth.key)] },
      storage,
    })).rejects.toThrow('ARCHIVE_QUARANTINE_AUDIT_SCOPE_INVALID');

    const alienKey = SOURCES[0]!.key.replace(COMPANY_ID, 'company-b');
    const alienIssues = report().issues.map((issue, index) => (
      index === 0 ? { ...issue, storageKey: alienKey } : issue
    ));
    await expect(buildArchiveQuarantineManifest({
      report: report({ issues: alienIssues }),
      auditDeploymentId: AUDIT_DEPLOYMENT_ID,
      auditReportSha256: REPORT_SHA,
      destinationBucket: 'archive-quarantine',
      target: {
        ...TARGET,
        sourceKeySha256s: TARGET.sourceKeySha256s.map((value, index) => (
          index === 0 ? digest(alienKey) : value
        )),
      },
      storage,
    })).rejects.toThrow('ARCHIVE_QUARANTINE_AUDIT_TENANT_DIVERGENT');

    const chantierKey = SOURCES[0]!.key.replace('/documents/', '/chantiers/');
    await expect(buildArchiveQuarantineManifest({
      report: report({
        issues: report().issues.map((issue, index) => (
          index === 0 ? { ...issue, storageKey: chantierKey } : issue
        )),
      }),
      auditDeploymentId: AUDIT_DEPLOYMENT_ID,
      auditReportSha256: REPORT_SHA,
      destinationBucket: 'archive-quarantine',
      target: {
        ...TARGET,
        sourceKeySha256s: TARGET.sourceKeySha256s.map((value, index) => (
          index === 0 ? digest(chantierKey) : value
        )),
      },
      storage,
    })).rejects.toThrow('ARCHIVE_QUARANTINE_AUDIT_TENANT_DIVERGENT');

    await expect(buildArchiveQuarantineManifest({
      report: report({
        issues: [...report().issues, { severity: 'P0', code: 'UNEXPECTED_P0', detail: 'no' }],
      }),
      auditDeploymentId: AUDIT_DEPLOYMENT_ID,
      auditReportSha256: REPORT_SHA,
      destinationBucket: 'archive-quarantine',
      target: TARGET,
      storage,
    })).rejects.toThrow('ARCHIVE_QUARANTINE_AUDIT_SCOPE_INVALID');
  });

  it('refuse un bucket source ou destination public avant toute copie', async () => {
    const storage = new MemoryStorage();
    storage.privateBuckets.delete('bob-documents');
    await expect(manifestFor(storage)).rejects.toThrow('ARCHIVE_QUARANTINE_BUCKET_NOT_PRIVATE');
    expect(storage.operations).toEqual([]);
  });

  it('copie et relit tout avant le premier DELETE, puis acquitte les cinq ordres', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage);
    const guard = safetyGuard();
    storage.operations.length = 0;
    const receipt = await applyArchiveQuarantine(applyInput(manifest, storage, guard));

    const firstRemove = storage.operations.findIndex((operation) => operation.startsWith('remove:'));
    const putsBeforeDelete = storage.operations.slice(0, firstRemove).filter((operation) => (
      operation.startsWith('put:')
    ));
    expect(receipt.phase).toBe('deleted_verified');
    expect(putsBeforeDelete).toHaveLength(6); // 5 PDF + copied_verified.json
    expect(guard.recordAuthorized).toHaveBeenCalledOnce();
    expect(guard.recordDestinationVerified).toHaveBeenCalledTimes(5);
    expect(guard.recordCopiedVerified).toHaveBeenCalledOnce();
    expect(guard.assertEntryDeleteSafe).toHaveBeenCalledTimes(5);
    expect(guard.assertSourceDeleted).toHaveBeenCalledTimes(5);
    expect(guard.assertFinalSnapshotClean).toHaveBeenCalledOnce();
    expect(guard.recordDeletedVerified).toHaveBeenCalledOnce();
  });

  it('refuse une collision destination sans supprimer une source', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage);
    const entry = manifest.entries[0]!;
    storage.objects.set(storageMapKey(manifest.destinationBucket, entry.destinationKey), {
      ...SOURCES[0]!.object,
      bytes: new TextEncoder().encode('different'),
    });
    await expect(applyArchiveQuarantine(applyInput(manifest, storage))).rejects.toThrow(
      `ARCHIVE_QUARANTINE_DESTINATION_COLLISION:${entry.sourceKeySha256}`,
    );
    expect(storage.operations.some((operation) => operation.startsWith('remove:'))).toBe(false);
  });

  it('refuse une destination perdue après copied_verified avant le premier DELETE', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage);
    const entry = manifest.entries[0]!;
    const guard = safetyGuard();
    vi.spyOn(guard, 'recordCopiedVerified').mockImplementation(async () => {
      storage.objects.delete(storageMapKey(manifest.destinationBucket, entry.destinationKey));
    });

    await expect(applyArchiveQuarantine(applyInput(manifest, storage, guard))).rejects.toThrow(
      `ARCHIVE_QUARANTINE_COPY_LOST_BEFORE_DELETE:${entry.sourceKeySha256}`,
    );
    expect(storage.operations.some((operation) => operation.startsWith('remove:'))).toBe(false);
  });

  it('refuse un reçu de copie remplacé après copied_verified avant le premier DELETE', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage);
    const guard = safetyGuard();
    const copyReceiptKey = `receipts/${manifest.confirmationDigest}/copied-verified.json`;
    vi.spyOn(guard, 'recordCopiedVerified').mockImplementation(async () => {
      const current = storage.objects.get(storageMapKey(manifest.destinationBucket, copyReceiptKey));
      if (current === undefined) throw new Error('test receipt missing');
      storage.objects.set(storageMapKey(manifest.destinationBucket, copyReceiptKey), {
        ...current,
        objectId: randomUUID(),
      });
    });

    await expect(applyArchiveQuarantine(applyInput(manifest, storage, guard))).rejects.toThrow(
      'ARCHIVE_QUARANTINE_COPY_RECEIPT_LOST_BEFORE_DELETE',
    );
    expect(storage.operations.some((operation) => operation.startsWith('remove:'))).toBe(false);
  });

  it('authentifie le workflow avant toute mutation', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage);
    const input = applyInput(manifest, storage);
    await expect(applyArchiveQuarantine({
      ...input,
      authorizationVerifier: verifier(true),
    })).rejects.toThrow('ARCHIVE_QUARANTINE_OIDC_REJECTED');
    expect(storage.operations).toEqual([]);
  });

  it('reprend après crash post-DELETE sans perdre ni recopier un objet', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage);
    storage.failAfterRemoveCount = 2;
    await expect(applyArchiveQuarantine(applyInput(manifest, storage))).rejects.toThrow(
      'simulated remove crash',
    );
    expect(storage.removeCount).toBe(2);
    storage.failAfterRemoveCount = Number.POSITIVE_INFINITY;
    await expect(applyArchiveQuarantine(applyInput(manifest, storage))).resolves.toMatchObject({
      phase: 'deleted_verified',
      manifestDigest: manifest.confirmationDigest,
    });
    expect(storage.removeCount).toBe(5);
  });

  it('réconcilie un ACK DELETE perdu au passage suivant', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage);
    storage.loseDeleteAcknowledgement = true;
    await expect(applyArchiveQuarantine(applyInput(manifest, storage))).rejects.toThrow(
      'simulated lost delete acknowledgement',
    );
    storage.loseDeleteAcknowledgement = false;
    await expect(applyArchiveQuarantine(applyInput(manifest, storage))).resolves.toMatchObject({
      phase: 'deleted_verified',
    });
    expect(storage.removeCount).toBe(5);
  });

  it('rend le deuxième apply strictement idempotent via le receipt deleted_verified', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage);
    const first = await applyArchiveQuarantine(applyInput(manifest, storage));
    const operations = [...storage.operations];
    const second = await applyArchiveQuarantine(applyInput(manifest, storage));
    expect(second).toEqual(first);
    expect(storage.operations).toEqual(operations);
  });

  it('n’écrit completed qu’après le nouvel audit global exact 0/0/0', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage);
    const guard = safetyGuard();
    await applyArchiveQuarantine(applyInput(manifest, storage, guard));
    expect(guard.recordCompleted).not.toHaveBeenCalled();

    const evidence = finalAudit(manifest);
    const first = await finalizeArchiveQuarantine({
      manifest,
      evidence,
      completedAt: COMPLETED_AT,
      storage,
      guard,
    });
    expect(first).toMatchObject({
      phase: 'completed',
      finalAuditDeploymentId: evidence.deploymentId,
      finalAuditInventoryDigest: evidence.inventoryDigest,
      finalAuditReportSha256: evidence.reportSha256,
    });
    expect(guard.recordFinalAuditVerified).toHaveBeenCalledOnce();
    expect(guard.recordCompleted).toHaveBeenCalledOnce();

    const operations = [...storage.operations];
    const second = await finalizeArchiveQuarantine({
      manifest,
      evidence,
      completedAt: COMPLETED_AT,
      storage,
      guard,
    });
    expect(second).toEqual(first);
    expect(storage.operations).toEqual(operations);
  });

  it('ne révèle jamais une clé brute dans une erreur de source modifiée', async () => {
    const storage = new MemoryStorage();
    const manifest = await manifestFor(storage);
    const entry = manifest.entries[0]!;
    storage.objects.set(storageMapKey(manifest.sourceBucket, entry.sourceKey), {
      ...SOURCES[0]!.object,
      updatedAt: '2026-08-05T00:00:00.000001Z',
    });
    let message = '';
    try {
      await applyArchiveQuarantine(applyInput(manifest, storage));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(entry.sourceKeySha256);
    expect(message).not.toContain(entry.sourceKey);
    expect(message).not.toContain(COMPANY_ID);
  });
});
