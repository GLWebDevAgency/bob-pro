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
  equipmentId: string | null;
  interventionId: string | null;
  phase: string | null;
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
    // PR-11 — tag équipement additif (null = photo du site, lignes historiques comprises).
    equipmentId: row.equipmentId,
    // PR-15 — tag fiche de passage + phase avant/après (null = photo hors passage).
    interventionId: row.interventionId,
    phase: row.phase === 'before' || row.phase === 'after' ? row.phase : null,
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
        equipmentId: item.equipmentId ?? null,
        // PR-15 — le tag fiche (prouvé par le use case) atteint la base ; le trigger
        // intervention_scope_coherence re-vérifie site ET verrou post-signature.
        interventionId: item.interventionId ?? null,
        phase: item.phase ?? null,
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
