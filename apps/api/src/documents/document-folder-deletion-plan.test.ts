import {
  appConflict,
  err,
  ok,
  type AppError,
  type ClockPort,
  type DeleteDocumentFolderStrategy,
  type DocumentFolderDeletionPreview,
  type DocumentFolderDeletionSnapshot,
  type IdGeneratorPort,
  type Result,
} from '@bob/core';
import { describe, expect, it } from 'vitest';
import {
  DocumentFolderDeletionPlanService,
  type ConsumeDocumentFolderDeletionPlanResult,
  type DocumentFolderDeletionPlanRecord,
  type DocumentFolderDeletionPlanStore,
} from './document-folder-deletion-plan';

const COMPANY = 'company-a';
const OTHER_COMPANY = 'company-b';
const FOLDER = 'folder-source';
const NOW = '2026-07-13T12:00:00.000Z';

function cloneSnapshot(snapshot: DocumentFolderDeletionSnapshot): DocumentFolderDeletionSnapshot {
  return {
    folders: snapshot.folders.map((folder) => ({ ...folder })),
    documents: snapshot.documents.map((document) => ({ ...document })),
  };
}

function cloneRecord(record: DocumentFolderDeletionPlanRecord): DocumentFolderDeletionPlanRecord {
  return { ...record, expectedSnapshot: cloneSnapshot(record.expectedSnapshot) };
}

function deletionPreview(overrides: Partial<DocumentFolderDeletionPreview> = {}): DocumentFolderDeletionPreview {
  return {
    folder: {
      id: FOLDER,
      companyId: COMPANY,
      parentId: null,
      name: 'Archives 2025',
      normalizedName: 'archives 2025',
      systemKey: null,
      status: 'active',
      revision: 4,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: NOW,
      deletedAt: null,
    },
    expectedRevision: 4,
    directChildCount: 1,
    descendantFolderCount: 1,
    directDocumentCount: 1,
    documentCount: 2,
    canDeleteEmpty: false,
    snapshot: {
      folders: [
        { id: FOLDER, parentId: null, revision: 4 },
        { id: 'folder-child', parentId: FOLDER, revision: 2 },
      ],
      documents: [
        { id: 'document-direct', folderId: FOLDER, revision: 3 },
        { id: 'document-child', folderId: 'folder-child', revision: 2 },
      ],
    },
    ...overrides,
  };
}

class MutableClock implements ClockPort {
  current = NOW;

  now(): string {
    return this.current;
  }

  today(): string {
    return this.current.slice(0, 10);
  }
}

class QueuedIds implements IdGeneratorPort {
  constructor(private readonly values: string[] = ['plan-000000000001']) {}

  newId(): string {
    return this.values.shift() ?? 'plan-000000000999';
  }
}

class MemoryPlanStore implements DocumentFolderDeletionPlanStore {
  readonly rows = new Map<string, DocumentFolderDeletionPlanRecord>();
  insertCalls = 0;
  consumeCalls = 0;
  throwOnInsert = false;
  throwOnConsume = false;
  corruptConsumedRecord?: (record: DocumentFolderDeletionPlanRecord) => unknown;

  async insert(plan: DocumentFolderDeletionPlanRecord): Promise<'stored' | 'id_conflict'> {
    this.insertCalls += 1;
    if (this.throwOnInsert) throw new Error('database unavailable');
    if (this.rows.has(plan.id)) return 'id_conflict';
    this.rows.set(plan.id, cloneRecord(plan));
    return 'stored';
  }

  async consume(input: {
    companyId: string;
    planId: string;
    at: string;
  }): Promise<ConsumeDocumentFolderDeletionPlanResult> {
    this.consumeCalls += 1;
    if (this.throwOnConsume) throw new Error('database unavailable');
    const plan = this.rows.get(input.planId);
    if (
      !plan ||
      plan.companyId !== input.companyId ||
      plan.consumedAt !== null ||
      Date.parse(plan.expiresAt) <= Date.parse(input.at)
    ) {
      return { status: 'unavailable' };
    }
    // Aucune suspension entre la condition et l'écriture : analogue au UPDATE ... RETURNING atomique.
    const consumed = { ...cloneRecord(plan), consumedAt: input.at };
    this.rows.set(plan.id, consumed);
    const returned = this.corruptConsumedRecord?.(cloneRecord(consumed)) ?? cloneRecord(consumed);
    return { status: 'consumed', plan: returned as DocumentFolderDeletionPlanRecord };
  }

  async purgeExpired(input: { companyId: string; before: string; limit: number }): Promise<number> {
    const ids = [...this.rows.values()]
      .filter((plan) => plan.companyId === input.companyId && plan.expiresAt <= input.before)
      .slice(0, input.limit)
      .map((plan) => plan.id);
    ids.forEach((id) => this.rows.delete(id));
    return ids.length;
  }
}

class PreviewStub {
  calls: { companyId: string; folderId: string }[] = [];
  result: Result<DocumentFolderDeletionPreview, AppError> = ok(deletionPreview());

  async execute(input: { companyId: string; folderId: string }): Promise<Result<DocumentFolderDeletionPreview, AppError>> {
    this.calls.push(input);
    return this.result;
  }
}

type DeleteOutput = { folderId: string; transferredDocuments: number; transferredChildren: number };
type DeleteInput = {
  companyId: string;
  folderId: string;
  expectedRevision: number;
  expectedSnapshot: DocumentFolderDeletionSnapshot;
  strategy: DeleteDocumentFolderStrategy;
};

class DeleteStub {
  calls: DeleteInput[] = [];
  result: Result<DeleteOutput, AppError> = ok({
    folderId: FOLDER,
    transferredDocuments: 1,
    transferredChildren: 1,
  });
  gate: Promise<void> | null = null;

  async execute(input: DeleteInput): Promise<Result<DeleteOutput, AppError>> {
    this.calls.push({ ...input, expectedSnapshot: cloneSnapshot(input.expectedSnapshot) });
    if (this.gate) await this.gate;
    return this.result;
  }
}

function harness(ids = new QueuedIds()) {
  const store = new MemoryPlanStore();
  const preview = new PreviewStub();
  const remove = new DeleteStub();
  const clock = new MutableClock();
  const service = new DocumentFolderDeletionPlanService({
    store,
    previewDeleteFolder: preview,
    deleteFolder: remove,
    clock,
    ids,
  });
  return { store, preview, remove, clock, service };
}

describe('DocumentFolderDeletionPlanService', () => {
  it('conserve le snapshot côté serveur et ne renvoie que le plan opaque et les comptes calculés', async () => {
    const h = harness();

    const result = await h.service.preview({ companyId: COMPANY, folderId: FOLDER });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      planId: 'plan-000000000001',
      expiresAt: '2026-07-13T12:05:00.000Z',
      folder: { id: FOLDER, parentId: null, name: 'Archives 2025', systemKey: null },
      directChildCount: 1,
      descendantFolderCount: 1,
      directDocumentCount: 1,
      documentCount: 2,
      canDeleteEmpty: false,
    });
    expect(result.value).not.toHaveProperty('snapshot');
    expect(result.value).not.toHaveProperty('expectedRevision');
    expect(h.store.rows.get(result.value.planId)).toMatchObject({
      companyId: COMPANY,
      folderId: FOLDER,
      expectedRevision: 4,
      consumedAt: null,
    });
    expect(h.store.rows.get(result.value.planId)?.expectedSnapshot.documents).toHaveLength(2);
  });

  it('consomme atomiquement le plan et transmet au domaine uniquement le snapshot serveur', async () => {
    const h = harness();
    const preview = await h.service.preview({ companyId: COMPANY, folderId: FOLDER });
    if (!preview.ok) throw new Error('preview failed');
    const stored = h.store.rows.get(preview.value.planId);
    if (!stored) throw new Error('missing stored plan');
    // Une valeur forgée hors du store ne doit jamais influencer la suppression.
    const strategy = { kind: 'transfer', targetFolderId: 'folder-target', targetExpectedRevision: 7 } as const;

    const result = await h.service.consume({ companyId: COMPANY, planId: preview.value.planId, strategy });

    expect(result).toEqual(ok({ folderId: FOLDER, transferredDocuments: 1, transferredChildren: 1 }));
    expect(h.remove.calls).toEqual([
      {
        companyId: COMPANY,
        folderId: FOLDER,
        expectedRevision: 4,
        expectedSnapshot: stored.expectedSnapshot,
        strategy,
      },
    ]);
    expect(h.store.rows.get(preview.value.planId)?.consumedAt).toBe(NOW);
  });

  it('rend le plan strictement mono-usage, y compris sous deux confirmations concurrentes', async () => {
    const h = harness();
    const preview = await h.service.preview({ companyId: COMPANY, folderId: FOLDER });
    if (!preview.ok) throw new Error('preview failed');
    let release!: () => void;
    h.remove.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = h.service.consume({ companyId: COMPANY, planId: preview.value.planId, strategy: { kind: 'empty' } });
    const second = await h.service.consume({
      companyId: COMPANY,
      planId: preview.value.planId,
      strategy: { kind: 'empty' },
    });
    release();
    const firstResult = await first;

    expect(firstResult.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatchObject({ kind: 'conflict', entity: 'document_folder_deletion_plan' });
    expect(h.remove.calls).toHaveLength(1);
  });

  it('ne révèle pas un plan à un autre tenant et laisse le tenant propriétaire le consommer', async () => {
    const h = harness();
    const preview = await h.service.preview({ companyId: COMPANY, folderId: FOLDER });
    if (!preview.ok) throw new Error('preview failed');

    const foreign = await h.service.consume({
      companyId: OTHER_COMPANY,
      planId: preview.value.planId,
      strategy: { kind: 'empty' },
    });
    const owner = await h.service.consume({
      companyId: COMPANY,
      planId: preview.value.planId,
      strategy: { kind: 'empty' },
    });

    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error).toMatchObject({ kind: 'conflict', entity: 'document_folder_deletion_plan' });
    expect(owner.ok).toBe(true);
    expect(h.remove.calls).toHaveLength(1);
  });

  it('rejette un plan expiré avant toute suppression', async () => {
    const h = harness();
    const preview = await h.service.preview({ companyId: COMPANY, folderId: FOLDER });
    if (!preview.ok) throw new Error('preview failed');
    h.clock.current = '2026-07-13T12:05:00.000Z';

    const result = await h.service.consume({
      companyId: COMPANY,
      planId: preview.value.planId,
      strategy: { kind: 'empty' },
    });

    expect(result.ok).toBe(false);
    expect(h.remove.calls).toHaveLength(0);
    expect(h.store.rows.get(preview.value.planId)?.consumedAt).toBeNull();
  });

  it('brûle le plan si le domaine détecte un snapshot périmé, afin d’imposer un nouvel aperçu', async () => {
    const h = harness();
    h.remove.result = err(appConflict('document_folder', 'Le contenu du dossier a changé.'));
    const preview = await h.service.preview({ companyId: COMPANY, folderId: FOLDER });
    if (!preview.ok) throw new Error('preview failed');

    const stale = await h.service.consume({
      companyId: COMPANY,
      planId: preview.value.planId,
      strategy: { kind: 'empty' },
    });
    const retry = await h.service.consume({
      companyId: COMPANY,
      planId: preview.value.planId,
      strategy: { kind: 'empty' },
    });

    expect(stale.ok).toBe(false);
    expect(retry.ok).toBe(false);
    expect(h.remove.calls).toHaveLength(1);
  });

  it('valide la stratégie avant consommation, sans perdre un plan sur une requête mal formée', async () => {
    const h = harness();
    const preview = await h.service.preview({ companyId: COMPANY, folderId: FOLDER });
    if (!preview.ok) throw new Error('preview failed');

    const invalid = await h.service.consume({
      companyId: COMPANY,
      planId: preview.value.planId,
      strategy: {
        kind: 'transfer',
        targetFolderId: 'folder-target',
        targetExpectedRevision: 0,
      },
    });
    const valid = await h.service.consume({
      companyId: COMPANY,
      planId: preview.value.planId,
      strategy: { kind: 'empty' },
    });

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.kind).toBe('validation');
    expect(valid.ok).toBe(true);
    expect(h.store.consumeCalls).toBe(1);
  });

  it('réessaie une collision d’id opaque et échoue fermé après trois collisions', async () => {
    const ids = new QueuedIds([
      'plan-000000000001',
      'plan-000000000002',
      'plan-000000000003',
      'plan-000000000004',
    ]);
    const h = harness(ids);
    const seeded = deletionPreview();
    const seed = (id: string): DocumentFolderDeletionPlanRecord => ({
      id,
      companyId: COMPANY,
      folderId: FOLDER,
      expectedRevision: seeded.expectedRevision,
      expectedSnapshot: cloneSnapshot(seeded.snapshot),
      createdAt: NOW,
      expiresAt: '2026-07-13T12:05:00.000Z',
      consumedAt: null,
    });
    h.store.rows.set('plan-000000000001', seed('plan-000000000001'));

    const retried = await h.service.preview({ companyId: COMPANY, folderId: FOLDER });

    expect(retried.ok && retried.value.planId).toBe('plan-000000000002');

    h.store.rows.set('plan-000000000003', seed('plan-000000000003'));
    h.store.rows.set('plan-000000000004', seed('plan-000000000004'));
    h.store.rows.set('plan-000000000999', seed('plan-000000000999'));
    const exhausted = await h.service.preview({ companyId: COMPANY, folderId: FOLDER });
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.error.kind).toBe('dependency');
  });

  it('échoue fermé si le store est indisponible ou restitue un plan incohérent', async () => {
    const insertFailure = harness();
    insertFailure.store.throwOnInsert = true;
    const notStored = await insertFailure.service.preview({ companyId: COMPANY, folderId: FOLDER });
    expect(notStored.ok).toBe(false);
    if (!notStored.ok) expect(notStored.error).toMatchObject({ kind: 'dependency', port: 'document-folder-deletion-plan' });

    const consumeFailure = harness();
    const consumePreview = await consumeFailure.service.preview({ companyId: COMPANY, folderId: FOLDER });
    if (!consumePreview.ok) throw new Error('preview failed');
    consumeFailure.store.throwOnConsume = true;
    const notAcquired = await consumeFailure.service.consume({
      companyId: COMPANY,
      planId: consumePreview.value.planId,
      strategy: { kind: 'empty' },
    });
    expect(notAcquired.ok).toBe(false);
    expect(consumeFailure.remove.calls).toHaveLength(0);

    const corrupt = harness();
    const corruptPreview = await corrupt.service.preview({ companyId: COMPANY, folderId: FOLDER });
    if (!corruptPreview.ok) throw new Error('preview failed');
    corrupt.store.corruptConsumedRecord = (record) => ({ ...record, companyId: OTHER_COMPANY });
    const rejected = await corrupt.service.consume({
      companyId: COMPANY,
      planId: corruptPreview.value.planId,
      strategy: { kind: 'empty' },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.kind).toBe('dependency');
    expect(corrupt.remove.calls).toHaveLength(0);
  });

  it('refuse un aperçu incohérent avant toute persistance', async () => {
    const h = harness();
    h.preview.result = ok(deletionPreview({ expectedRevision: 99 }));

    const result = await h.service.preview({ companyId: COMPANY, folderId: FOLDER });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('dependency');
    expect(h.store.insertCalls).toBe(0);
  });

  it('borne la durée de vie de la confirmation à 30 minutes', () => {
    const h = harness();
    expect(
      () =>
        new DocumentFolderDeletionPlanService({
          store: h.store,
          previewDeleteFolder: h.preview,
          deleteFolder: h.remove,
          clock: h.clock,
          ids: new QueuedIds(),
          ttlMs: 30 * 60_000 + 1,
        }),
    ).toThrow(/TTL/);
  });
});
