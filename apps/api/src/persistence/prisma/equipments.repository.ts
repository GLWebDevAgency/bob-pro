import { Equipment, type EquipmentProps, type EquipmentRepository } from '@bob/core';
import { Prisma } from '@prisma/client';
import type { PrismaService } from './prisma.service';

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function equipmentFromRow(row: {
  id: string;
  companyId: string;
  chantierId: string;
  label: string;
  kind: string | null;
  brand: string | null;
  serialNumber: string | null;
  location: string | null;
  installedAt: Date | null;
  warrantyUntil: Date | null;
  status: string;
  retiredAt: Date | null;
  notes: string | null;
  revision: number;
}): Equipment {
  return Equipment.rehydrate({
    id: row.id,
    companyId: row.companyId,
    chantierId: row.chantierId,
    label: row.label,
    kind: row.kind,
    brand: row.brand,
    serialNumber: row.serialNumber,
    location: row.location,
    installedAt: row.installedAt === null ? null : dateOnly(row.installedAt),
    warrantyUntil: row.warrantyUntil === null ? null : dateOnly(row.warrantyUntil),
    status: row.status as EquipmentProps['status'],
    retiredAt: row.retiredAt === null ? null : row.retiredAt.toISOString(),
    notes: row.notes,
    revision: row.revision,
  });
}

/** PostgreSQL est l'unique autorité du parc d'équipements en runtime live (PR-11b). */
export class PrismaEquipmentRepository implements EquipmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(equipment: Equipment): Promise<void> {
    const value = equipment.toProps();
    const data = {
      companyId: value.companyId,
      chantierId: value.chantierId,
      label: value.label,
      kind: value.kind,
      brand: value.brand,
      serialNumber: value.serialNumber,
      location: value.location,
      installedAt: value.installedAt === null ? null : new Date(`${value.installedAt}T00:00:00.000Z`),
      warrantyUntil:
        value.warrantyUntil === null ? null : new Date(`${value.warrantyUntil}T00:00:00.000Z`),
      status: value.status,
      retiredAt: value.retiredAt === null ? null : new Date(value.retiredAt),
      notes: value.notes,
      revision: value.revision,
    } as const;
    await this.prisma.client().equipment.upsert({
      where: { id: value.id },
      create: { id: value.id, ...data },
      update: data,
    });
  }

  async findById(companyId: string, id: string): Promise<Equipment | null> {
    const row = await this.prisma.client().equipment.findFirst({ where: { id, companyId } });
    return row === null ? null : equipmentFromRow(row);
  }

  /** SELECT … FOR UPDATE dans la transaction courante — sérialise retrait/édition concurrents. */
  async lockById(companyId: string, id: string): Promise<Equipment | null> {
    const rows = await this.prisma.client().$queryRaw<
      {
        id: string;
        companyId: string;
        chantierId: string;
        label: string;
        kind: string | null;
        brand: string | null;
        serialNumber: string | null;
        location: string | null;
        installedAt: Date | null;
        warrantyUntil: Date | null;
        status: string;
        retiredAt: Date | null;
        notes: string | null;
        revision: number;
      }[]
    >(Prisma.sql`
      SELECT "id", "companyId", "chantierId", "label", "kind", "serialNumber", "brand",
             "location", "installedAt", "warrantyUntil", "status", "retiredAt", "notes", "revision"
        FROM "equipments"
       WHERE "id" = ${id} AND "companyId" = ${companyId}
       FOR UPDATE
    `);
    const row = rows[0];
    return row === undefined ? null : equipmentFromRow(row);
  }

  async listByChantier(companyId: string, chantierId: string): Promise<Equipment[]> {
    const rows = await this.prisma.client().equipment.findMany({
      where: { companyId, chantierId },
      orderBy: [{ label: 'asc' }, { id: 'asc' }],
    });
    return rows.map(equipmentFromRow);
  }

  async listByCompany(companyId: string): Promise<Equipment[]> {
    const rows = await this.prisma.client().equipment.findMany({
      where: { companyId },
      orderBy: [{ label: 'asc' }, { id: 'asc' }],
    });
    return rows.map(equipmentFromRow);
  }
}
