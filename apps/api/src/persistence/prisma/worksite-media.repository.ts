import { type WorksiteMediaItem, type WorksiteMediaStorage } from '@bob/core';
import type { PrismaService } from './prisma.service';

function mediaFromRow(row: {
  id: string;
  companyId: string;
  chantierId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  storageKey: string;
  createdAt: Date;
}): WorksiteMediaItem {
  return {
    id: row.id,
    companyId: row.companyId,
    chantierId: row.chantierId,
    filename: row.filename,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    storageKey: row.storageKey,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Métadonnées des photos de chantier (PostgreSQL, table dédiée chantier_photos — séparée du
 * coffre documents fiscal). Les octets vivent dans DocumentStoragePort (Supabase aujourd'hui) ;
 * ce repository ne connaît que la métadonnée et la clé de stockage.
 */
export class PrismaWorksiteMediaStorage implements WorksiteMediaStorage {
  constructor(private readonly prisma: PrismaService) {}

  async save(item: WorksiteMediaItem): Promise<void> {
    await this.prisma.client().chantierPhoto.create({
      data: {
        id: item.id,
        companyId: item.companyId,
        chantierId: item.chantierId,
        filename: item.filename,
        mimeType: item.mimeType,
        byteSize: item.byteSize,
        storageKey: item.storageKey,
        createdAt: new Date(item.createdAt),
      },
    });
  }

  async listByChantier(companyId: string, chantierId: string): Promise<WorksiteMediaItem[]> {
    const rows = await this.prisma.client().chantierPhoto.findMany({
      where: { companyId, chantierId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(mediaFromRow);
  }

  async findById(companyId: string, id: string): Promise<WorksiteMediaItem | null> {
    const row = await this.prisma.client().chantierPhoto.findFirst({ where: { id, companyId } });
    return row === null ? null : mediaFromRow(row);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.prisma.client().chantierPhoto.deleteMany({ where: { id, companyId } });
  }

  /** Agrégat bulk (1 requête groupBy) : compteur de rangée de la liste des chantiers — jamais
   * un listByChantier() par chantier (N+1). */
  async countByCompany(companyId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.client().chantierPhoto.groupBy({
      by: ['chantierId'],
      where: { companyId },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.chantierId, row._count._all]));
  }
}
