import {
  err,
  ok,
  type AppError,
  type ClockPort,
  type DeleteDocumentFolderStrategy,
  type DocumentFolderDeletionPreview,
  type DocumentFolderDeletionSnapshot,
  type DocumentFolderView,
  type IdGeneratorPort,
  type Result,
} from '@bob/core';

const DEFAULT_PLAN_TTL_MS = 5 * 60_000;
const MAX_PLAN_TTL_MS = 30 * 60_000;
const PLAN_ID_ATTEMPTS = 3;
const PLAN_ID_PATTERN = /^[A-Za-z0-9._:-]{16,200}$/;

export interface DocumentFolderDeletionPlanRecord {
  id: string;
  companyId: string;
  folderId: string;
  expectedRevision: number;
  /** Snapshot de sécurité strictement serveur-side. Ne jamais le sérialiser dans la réponse HTTP. */
  expectedSnapshot: DocumentFolderDeletionSnapshot;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export type StoreDocumentFolderDeletionPlanResult = 'stored' | 'id_conflict';

export type ConsumeDocumentFolderDeletionPlanResult =
  | { status: 'consumed'; plan: DocumentFolderDeletionPlanRecord }
  | { status: 'unavailable' };

/**
 * Persistance des confirmations destructives.
 *
 * `consume` DOIT être une seule opération atomique : filtrer par `(id, companyId)`,
 * `consumedAt IS NULL` et `expiresAt > at`, renseigner `consumedAt`, puis retourner la ligne.
 * Tous les échecs (absent, autre tenant, expiré, déjà consommé) sont volontairement
 * indiscernables afin de ne pas transformer les ids opaques en oracle inter-tenant.
 */
export interface DocumentFolderDeletionPlanStore {
  insert(plan: DocumentFolderDeletionPlanRecord): Promise<StoreDocumentFolderDeletionPlanResult>;
  consume(input: {
    companyId: string;
    planId: string;
    at: string;
  }): Promise<ConsumeDocumentFolderDeletionPlanResult>;
  /** Supprime, dans un tenant, au plus `limit` lignes dont `expiresAt <= before`. */
  purgeExpired(input: { companyId: string; before: string; limit: number }): Promise<number>;
}

export interface DocumentFolderDeletionPlanPreviewView {
  planId: string;
  expiresAt: string;
  folder: Pick<DocumentFolderView, 'id' | 'parentId' | 'name' | 'systemKey'>;
  directChildCount: number;
  descendantFolderCount: number;
  directDocumentCount: number;
  documentCount: number;
  canDeleteEmpty: boolean;
}

interface PreviewDeleteFolderPort {
  execute(input: {
    companyId: string;
    folderId: string;
  }): Promise<Result<DocumentFolderDeletionPreview, AppError>>;
}

interface DeleteFolderPort {
  execute(input: {
    companyId: string;
    folderId: string;
    expectedRevision: number;
    expectedSnapshot: DocumentFolderDeletionSnapshot;
    strategy: DeleteDocumentFolderStrategy;
  }): Promise<
    Result<
      { folderId: string; transferredDocuments: number; transferredChildren: number },
      AppError
    >
  >;
}

interface DocumentFolderDeletionPlanDependencies {
  store: DocumentFolderDeletionPlanStore;
  previewDeleteFolder: PreviewDeleteFolderPort;
  deleteFolder: DeleteFolderPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  ttlMs?: number;
}

function planDependency(cause: string): AppError {
  return { kind: 'dependency', port: 'document-folder-deletion-plan', cause };
}

function unavailablePlan(): AppError {
  return {
    kind: 'conflict',
    entity: 'document_folder_deletion_plan',
    reason: 'Cette confirmation a expiré ou a déjà été utilisée. Recrée un aperçu avant de confirmer.',
  };
}

function invalidStrategy(message: string): AppError {
  return { kind: 'validation', issues: [{ field: 'strategy', message }] };
}

function cloneSnapshot(snapshot: DocumentFolderDeletionSnapshot): DocumentFolderDeletionSnapshot {
  return {
    folders: snapshot.folders.map((folder) => ({ ...folder })),
    documents: snapshot.documents.map((document) => ({ ...document })),
  };
}

function validTimestamp(value: string): boolean {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function addMilliseconds(instant: string, durationMs: number): string | null {
  const timestamp = Date.parse(instant);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + durationMs).toISOString();
}

function structurallyValidStrategy(value: DeleteDocumentFolderStrategy): boolean {
  if (!value || typeof value !== 'object') return false;
  if (value.kind === 'empty') return true;
  return (
    value.kind === 'transfer' &&
    typeof value.targetFolderId === 'string' &&
    value.targetFolderId.length > 0 &&
    value.targetFolderId.length <= 200 &&
    Number.isSafeInteger(value.targetExpectedRevision) &&
    value.targetExpectedRevision >= 1
  );
}

function structurallyValidSnapshot(
  snapshot: DocumentFolderDeletionSnapshot,
  folderId: string,
  expectedRevision: number,
): boolean {
  if (!snapshot || !Array.isArray(snapshot.folders) || !Array.isArray(snapshot.documents)) return false;
  const folderIds = new Set<string>();
  for (const folder of snapshot.folders) {
    if (
      !folder ||
      typeof folder.id !== 'string' ||
      folder.id.length === 0 ||
      folderIds.has(folder.id) ||
      (folder.parentId !== null && typeof folder.parentId !== 'string') ||
      !Number.isSafeInteger(folder.revision) ||
      folder.revision < 1
    ) {
      return false;
    }
    folderIds.add(folder.id);
  }
  const root = snapshot.folders.find((folder) => folder.id === folderId);
  if (!root || root.revision !== expectedRevision) return false;
  if (snapshot.folders.some((folder) => folder.id !== folderId && !folder.parentId)) return false;
  if (snapshot.folders.some((folder) => folder.id !== folderId && !folderIds.has(folder.parentId ?? ''))) return false;

  const documentIds = new Set<string>();
  for (const document of snapshot.documents) {
    if (
      !document ||
      typeof document.id !== 'string' ||
      document.id.length === 0 ||
      documentIds.has(document.id) ||
      typeof document.folderId !== 'string' ||
      !folderIds.has(document.folderId) ||
      !Number.isSafeInteger(document.revision) ||
      document.revision < 1
    ) {
      return false;
    }
    documentIds.add(document.id);
  }
  return true;
}

function structurallyValidPreview(
  preview: DocumentFolderDeletionPreview,
  input: { companyId: string; folderId: string },
): boolean {
  const counts = [
    preview.directChildCount,
    preview.descendantFolderCount,
    preview.directDocumentCount,
    preview.documentCount,
  ];
  return (
    preview.folder.id === input.folderId &&
    preview.folder.companyId === input.companyId &&
    Number.isSafeInteger(preview.expectedRevision) &&
    preview.expectedRevision >= 1 &&
    counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    preview.directChildCount <= preview.descendantFolderCount &&
    preview.directDocumentCount <= preview.documentCount &&
    typeof preview.canDeleteEmpty === 'boolean' &&
    preview.canDeleteEmpty === (preview.descendantFolderCount === 0 && preview.documentCount === 0) &&
    structurallyValidSnapshot(preview.snapshot, input.folderId, preview.expectedRevision)
  );
}

function validConsumedRecord(
  record: unknown,
  input: { companyId: string; planId: string; consumedAt: string },
): record is DocumentFolderDeletionPlanRecord {
  if (!record || typeof record !== 'object') return false;
  const candidate = record as Partial<DocumentFolderDeletionPlanRecord>;
  return (
    candidate.id === input.planId &&
    candidate.companyId === input.companyId &&
    typeof candidate.folderId === 'string' &&
    candidate.folderId.length > 0 &&
    Number.isSafeInteger(candidate.expectedRevision) &&
    (candidate.expectedRevision ?? 0) >= 1 &&
    validTimestamp(candidate.createdAt ?? '') &&
    validTimestamp(candidate.expiresAt ?? '') &&
    validTimestamp(candidate.consumedAt ?? '') &&
    Date.parse(candidate.createdAt ?? '') <= Date.parse(input.consumedAt) &&
    Date.parse(candidate.expiresAt ?? '') > Date.parse(input.consumedAt) &&
    Date.parse(candidate.consumedAt ?? '') === Date.parse(input.consumedAt) &&
    structurallyValidSnapshot(
      candidate.expectedSnapshot as DocumentFolderDeletionSnapshot,
      candidate.folderId,
      candidate.expectedRevision ?? 0,
    )
  );
}

/**
 * Façade serveur de la confirmation destructive.
 *
 * La consommation précède volontairement la suppression. Si le processus tombe entre les deux,
 * rien n'est supprimé et le plan est perdu : c'est un choix fail-closed. L'utilisateur recrée un
 * aperçu ; un même plan ne peut jamais déclencher deux suppressions concurrentes.
 */
export class DocumentFolderDeletionPlanService {
  private readonly ttlMs: number;

  constructor(private readonly deps: DocumentFolderDeletionPlanDependencies) {
    this.ttlMs = deps.ttlMs ?? DEFAULT_PLAN_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > MAX_PLAN_TTL_MS) {
      throw new Error(`Invalid document-folder deletion plan TTL: ${String(this.ttlMs)}.`);
    }
  }

  async preview(input: {
    companyId: string;
    folderId: string;
  }): Promise<Result<DocumentFolderDeletionPlanPreviewView, AppError>> {
    let preview: Result<DocumentFolderDeletionPreview, AppError>;
    try {
      preview = await this.deps.previewDeleteFolder.execute(input);
    } catch {
      return err(planDependency('Impossible de calculer l’aperçu de suppression.'));
    }
    if (!preview.ok) return preview;
    if (!structurallyValidPreview(preview.value, input)) {
      return err(planDependency('Aperçu de suppression incohérent.'));
    }

    let createdAt: string;
    try {
      createdAt = this.deps.clock.now();
    } catch {
      return err(planDependency('Horloge serveur indisponible.'));
    }
    const expiresAt = addMilliseconds(createdAt, this.ttlMs);
    if (!expiresAt) return err(planDependency('Horloge serveur invalide.'));

    for (let attempt = 0; attempt < PLAN_ID_ATTEMPTS; attempt += 1) {
      let planId: string;
      try {
        planId = this.deps.ids.newId();
      } catch {
        return err(planDependency('Impossible de générer la confirmation opaque.'));
      }
      if (!PLAN_ID_PATTERN.test(planId)) continue;
      const record: DocumentFolderDeletionPlanRecord = {
        id: planId,
        companyId: input.companyId,
        folderId: input.folderId,
        expectedRevision: preview.value.expectedRevision,
        expectedSnapshot: cloneSnapshot(preview.value.snapshot),
        createdAt,
        expiresAt,
        consumedAt: null,
      };
      try {
        const stored = await this.deps.store.insert(record);
        if (stored === 'id_conflict') continue;
        if (stored !== 'stored') {
          return err(planDependency('Réponse de persistance de confirmation incohérente.'));
        }
      } catch {
        return err(planDependency('Impossible de conserver la confirmation de suppression.'));
      }
      return ok({
        planId,
        expiresAt,
        folder: {
          id: preview.value.folder.id,
          parentId: preview.value.folder.parentId,
          name: preview.value.folder.name,
          systemKey: preview.value.folder.systemKey,
        },
        directChildCount: preview.value.directChildCount,
        descendantFolderCount: preview.value.descendantFolderCount,
        directDocumentCount: preview.value.directDocumentCount,
        documentCount: preview.value.documentCount,
        canDeleteEmpty: preview.value.canDeleteEmpty,
      });
    }
    return err(planDependency('Impossible de générer un identifiant de confirmation opaque.'));
  }

  async consume(input: {
    companyId: string;
    planId: string;
    strategy: DeleteDocumentFolderStrategy;
  }): Promise<
    Result<
      { folderId: string; transferredDocuments: number; transferredChildren: number },
      AppError
    >
  > {
    if (!structurallyValidStrategy(input.strategy)) {
      return err(invalidStrategy('La stratégie de suppression est invalide.'));
    }
    if (!PLAN_ID_PATTERN.test(input.planId)) return err(unavailablePlan());

    let now: string;
    try {
      now = this.deps.clock.now();
    } catch {
      return err(planDependency('Horloge serveur indisponible.'));
    }
    if (!validTimestamp(now)) return err(planDependency('Horloge serveur invalide.'));

    let acquired: ConsumeDocumentFolderDeletionPlanResult;
    try {
      acquired = await this.deps.store.consume({ companyId: input.companyId, planId: input.planId, at: now });
    } catch {
      return err(planDependency('Impossible de verrouiller la confirmation de suppression.'));
    }
    if (acquired.status === 'unavailable') return err(unavailablePlan());
    if (!validConsumedRecord(acquired.plan, { companyId: input.companyId, planId: input.planId, consumedAt: now })) {
      return err(planDependency('Confirmation de suppression incohérente.'));
    }

    try {
      return await this.deps.deleteFolder.execute({
        companyId: acquired.plan.companyId,
        folderId: acquired.plan.folderId,
        expectedRevision: acquired.plan.expectedRevision,
        expectedSnapshot: cloneSnapshot(acquired.plan.expectedSnapshot),
        strategy: input.strategy,
      });
    } catch {
      return err(planDependency('La suppression du dossier n’a pas pu être exécutée.'));
    }
  }
}
