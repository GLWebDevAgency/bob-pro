import { Prisma, type DocumentFolderDeletionPlan as PrismaDeletionPlan } from '@prisma/client';
import type {
  ConsumeDocumentFolderDeletionPlanResult,
  DocumentFolderDeletionPlanRecord,
  DocumentFolderDeletionPlanStore,
  StoreDocumentFolderDeletionPlanResult,
} from '../documents/document-folder-deletion-plan';
import { PrismaService } from './prisma/prisma.service';

function cloneRecord(record: DocumentFolderDeletionPlanRecord): DocumentFolderDeletionPlanRecord {
  return {
    ...record,
    expectedSnapshot: {
      folders: record.expectedSnapshot.folders.map((folder) => ({ ...folder })),
      documents: record.expectedSnapshot.documents.map((document) => ({ ...document })),
    },
  };
}

function mapRow(row: PrismaDeletionPlan): DocumentFolderDeletionPlanRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    folderId: row.folderId,
    expectedRevision: row.expectedRevision,
    // La façade de plan revalide intégralement cette forme avant toute suppression.
    expectedSnapshot: row.expectedSnapshot as unknown as DocumentFolderDeletionPlanRecord['expectedSnapshot'],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt?.toISOString() ?? null,
  };
}

/** Store démo avec les mêmes clôtures tenant/expiration/mono-usage que PostgreSQL. */
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

/**
 * Adapter PostgreSQL. `consume` doit être appelé dans une transaction tenant dédiée :
 * l'UPDATE conditionnel prend le verrou de ligne, puis le SELECT restitue exactement la
 * génération acquise. Le backend exécute ensuite la suppression dans une seconde transaction.
 */
export class PrismaDocumentFolderDeletionPlanStore implements DocumentFolderDeletionPlanStore {
  constructor(private readonly prisma: PrismaService) {}

  async insert(plan: DocumentFolderDeletionPlanRecord): Promise<StoreDocumentFolderDeletionPlanResult> {
    try {
      await this.prisma.client().documentFolderDeletionPlan.create({
        data: {
          id: plan.id,
          companyId: plan.companyId,
          folderId: plan.folderId,
          expectedRevision: plan.expectedRevision,
          expectedSnapshot: plan.expectedSnapshot as unknown as Prisma.InputJsonValue,
          createdAt: new Date(plan.createdAt),
          expiresAt: new Date(plan.expiresAt),
          consumedAt: plan.consumedAt ? new Date(plan.consumedAt) : null,
        },
      });
      return 'stored';
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
        return 'id_conflict';
      }
      throw cause;
    }
  }

  async consume(input: {
    companyId: string;
    planId: string;
    at: string;
  }): Promise<ConsumeDocumentFolderDeletionPlanResult> {
    const at = new Date(input.at);
    const acquired = await this.prisma.client().documentFolderDeletionPlan.updateMany({
      where: {
        id: input.planId,
        companyId: input.companyId,
        consumedAt: null,
        expiresAt: { gt: at },
      },
      data: { consumedAt: at },
    });
    if (acquired.count !== 1) return { status: 'unavailable' };
    const row = await this.prisma.client().documentFolderDeletionPlan.findUnique({ where: { id: input.planId } });
    return row ? { status: 'consumed', plan: mapRow(row) } : { status: 'unavailable' };
  }

  async purgeExpired(input: { companyId: string; before: string; limit: number }): Promise<number> {
    const candidates = await this.prisma.client().documentFolderDeletionPlan.findMany({
      where: { companyId: input.companyId, expiresAt: { lte: new Date(input.before) } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: Math.max(0, input.limit),
    });
    if (candidates.length === 0) return 0;
    const removed = await this.prisma.client().documentFolderDeletionPlan.deleteMany({
      where: { companyId: input.companyId, id: { in: candidates.map((candidate) => candidate.id) } },
    });
    return removed.count;
  }
}
