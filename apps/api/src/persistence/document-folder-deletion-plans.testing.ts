import type {
  ConsumeDocumentFolderDeletionPlanResult,
  DocumentFolderDeletionPlanRecord,
  DocumentFolderDeletionPlanStore,
  StoreDocumentFolderDeletionPlanResult,
} from '../documents/document-folder-deletion-plan';

function cloneRecord(record: DocumentFolderDeletionPlanRecord): DocumentFolderDeletionPlanRecord {
  return {
    ...record,
    expectedSnapshot: {
      folders: record.expectedSnapshot.folders.map((folder) => ({ ...folder })),
      documents: record.expectedSnapshot.documents.map((document) => ({ ...document })),
    },
  };
}

/** Double déterministe réservé au harness de tests API. */
export class InMemoryDocumentFolderDeletionPlanStore implements DocumentFolderDeletionPlanStore {
  private readonly rows = new Map<string, DocumentFolderDeletionPlanRecord>();

  insert(plan: DocumentFolderDeletionPlanRecord): Promise<StoreDocumentFolderDeletionPlanResult> {
    if (this.rows.has(plan.id)) return Promise.resolve('id_conflict');
    this.rows.set(plan.id, cloneRecord(plan));
    return Promise.resolve('stored');
  }

  consume(input: {
    companyId: string;
    planId: string;
    at: string;
  }): Promise<ConsumeDocumentFolderDeletionPlanResult> {
    const plan = this.rows.get(input.planId);
    if (
      !plan
      || plan.companyId !== input.companyId
      || plan.consumedAt !== null
      || Date.parse(plan.expiresAt) <= Date.parse(input.at)
    ) {
      return Promise.resolve({ status: 'unavailable' });
    }
    const consumed = { ...cloneRecord(plan), consumedAt: input.at };
    this.rows.set(plan.id, consumed);
    return Promise.resolve({ status: 'consumed', plan: cloneRecord(consumed) });
  }

  purgeExpired(input: { companyId: string; before: string; limit: number }): Promise<number> {
    const ids = [...this.rows.values()]
      .filter((plan) => plan.companyId === input.companyId && plan.expiresAt <= input.before)
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))
      .slice(0, Math.max(0, input.limit))
      .map((plan) => plan.id);
    ids.forEach((id) => this.rows.delete(id));
    return Promise.resolve(ids.length);
  }
}
