import { Prisma, type DocumentFolderDeletionPlan as PrismaDeletionPlan } from '@prisma/client';
import type {
  ConsumeDocumentFolderDeletionPlanResult,
  DocumentFolderDeletionPlanRecord,
  DocumentFolderDeletionPlanStore,
  StoreDocumentFolderDeletionPlanResult,
} from '../documents/document-folder-deletion-plan';
import { PrismaService } from './prisma/prisma.service';

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
