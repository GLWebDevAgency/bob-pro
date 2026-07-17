import {
  Chantier,
  ChantierNote,
  type CatalogueCategory,
  type CatalogueCreateWriteResult,
  type CatalogueDeleteWriteResult,
  type CatalogueItemRecord,
  type CatalogueRepository,
  type CatalogueUpdateWriteResult,
  type ChantierNoteProps,
  type ChantierNoteRepository,
  type ChantierProps,
  type ChantierRepository,
  type VatRate,
} from '@bob/core';
import type { PrismaService } from './prisma.service';

function catalogueFromRow(row: {
  id: string;
  companyId: string;
  label: string;
  category: string;
  unit: string | null;
  unitPriceHt: number;
  vatRate: unknown;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}): CatalogueItemRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    label: row.label,
    category: row.category as CatalogueCategory,
    unit: row.unit,
    unitPriceHT: row.unitPriceHt,
    vatRate: Number(row.vatRate) as VatRate,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** PostgreSQL est l'unique autorité du catalogue propriétaire en runtime live. */
export class PrismaCatalogueRepository implements CatalogueRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listByCompany(companyId: string): Promise<readonly CatalogueItemRecord[]> {
    const rows = await this.prisma.client().cataloguePrestation.findMany({
      where: { companyId },
      orderBy: [{ category: 'asc' }, { label: 'asc' }, { id: 'asc' }],
    });
    return rows.map(catalogueFromRow);
  }

  async create(item: CatalogueItemRecord): Promise<CatalogueCreateWriteResult> {
    // createMany(skipDuplicates) évite d'empoisonner la transaction HTTP en cas de collision
    // d'identifiant (contrairement à create()+catch P2002 sous PostgreSQL).
    const created = await this.prisma.client().cataloguePrestation.createMany({
      data: [{
        id: item.id,
        companyId: item.companyId,
        label: item.label,
        category: item.category,
        unit: item.unit,
        unitPriceHt: item.unitPriceHT,
        vatRate: item.vatRate,
        revision: item.revision,
        createdAt: new Date(item.createdAt),
        updatedAt: new Date(item.updatedAt),
      }],
      skipDuplicates: true,
    });
    if (created.count === 0) return { status: 'id_conflict' };
    const row = await this.prisma.client().cataloguePrestation.findFirst({
      where: { id: item.id, companyId: item.companyId },
    });
    if (row === null) throw new Error('CATALOGUE_CREATED_ROW_NOT_VISIBLE');
    return { status: 'created', item: catalogueFromRow(row) };
  }

  async update(input: Parameters<CatalogueRepository['update']>[0]): Promise<CatalogueUpdateWriteResult> {
    const updated = await this.prisma.client().cataloguePrestation.updateMany({
      where: {
        id: input.id,
        companyId: input.companyId,
        revision: input.expectedRevision,
      },
      data: {
        label: input.item.label,
        category: input.item.category,
        unit: input.item.unit,
        unitPriceHt: input.item.unitPriceHT,
        vatRate: input.item.vatRate,
        revision: input.item.revision,
        updatedAt: new Date(input.item.updatedAt),
      },
    });
    if (updated.count === 0) {
      const exists = await this.prisma.client().cataloguePrestation.findFirst({
        where: { id: input.id, companyId: input.companyId },
        select: { id: true },
      });
      return exists === null ? { status: 'not_found' } : { status: 'revision_conflict' };
    }
    const row = await this.prisma.client().cataloguePrestation.findFirst({
      where: { id: input.id, companyId: input.companyId },
    });
    // La requête HTTP est transactionnelle : notre ligne mise à jour ne peut pas disparaître
    // avant cette relecture. Une absence signale donc un défaut de persistance, pas un 404 métier.
    if (row === null) throw new Error('CATALOGUE_UPDATED_ROW_NOT_VISIBLE');
    return { status: 'updated', item: catalogueFromRow(row) };
  }

  async delete(input: Parameters<CatalogueRepository['delete']>[0]): Promise<CatalogueDeleteWriteResult> {
    const deleted = await this.prisma.client().cataloguePrestation.deleteMany({
      where: {
        id: input.id,
        companyId: input.companyId,
        revision: input.expectedRevision,
      },
    });
    if (deleted.count === 1) return { status: 'deleted' };
    const exists = await this.prisma.client().cataloguePrestation.findFirst({
      where: { id: input.id, companyId: input.companyId },
      select: { id: true },
    });
    return exists === null ? { status: 'not_found' } : { status: 'revision_conflict' };
  }
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function chantierFromRow(row: {
  id: string;
  companyId: string;
  name: string;
  customerId: string | null;
  address: string | null;
  notes: string | null;
  status: string;
  openedAt: Date;
}): Chantier {
  return Chantier.rehydrate({
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    customerId: row.customerId,
    address: row.address,
    notes: row.notes,
    status: row.status as ChantierProps['status'],
    openedAt: dateOnly(row.openedAt),
  });
}

/** PostgreSQL est l'unique autorité des chantiers en runtime live. */
export class PrismaChantierRepository implements ChantierRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(chantier: Chantier): Promise<void> {
    const value = chantier.toProps();
    const data = {
      companyId: value.companyId,
      name: value.name,
      customerId: value.customerId,
      address: value.address,
      notes: value.notes,
      status: value.status,
      openedAt: new Date(`${value.openedAt}T00:00:00.000Z`),
    } as const;

    await this.prisma.client().chantier.upsert({
      where: { id: value.id },
      create: { id: value.id, ...data },
      update: data,
    });
  }

  async findById(id: string): Promise<Chantier | null> {
    const row = await this.prisma.client().chantier.findUnique({ where: { id } });
    return row === null ? null : chantierFromRow(row);
  }

  async listByCompany(companyId: string): Promise<Chantier[]> {
    const rows = await this.prisma.client().chantier.findMany({
      where: { companyId },
      orderBy: [{ status: 'asc' }, { openedAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(chantierFromRow);
  }
}

function chantierNoteFromRow(row: {
  id: string;
  companyId: string;
  chantierId: string;
  text: string;
  authorLabel: string;
  createdAt: Date;
}): ChantierNote {
  return ChantierNote.rehydrate({
    id: row.id,
    companyId: row.companyId,
    chantierId: row.chantierId,
    text: row.text,
    authorLabel: row.authorLabel,
    createdAt: row.createdAt.toISOString(),
  } satisfies ChantierNoteProps);
}

/** PostgreSQL est l'unique autorité du journal de chantier en runtime live. */
export class PrismaChantierNoteRepository implements ChantierNoteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(note: ChantierNote): Promise<void> {
    const value = note.toProps();
    await this.prisma.client().chantierNote.create({
      data: {
        id: value.id,
        companyId: value.companyId,
        chantierId: value.chantierId,
        text: value.text,
        authorLabel: value.authorLabel,
        createdAt: new Date(value.createdAt),
      },
    });
  }

  async listByChantier(companyId: string, chantierId: string): Promise<ChantierNote[]> {
    const rows = await this.prisma.client().chantierNote.findMany({
      where: { companyId, chantierId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(chantierNoteFromRow);
  }
}
