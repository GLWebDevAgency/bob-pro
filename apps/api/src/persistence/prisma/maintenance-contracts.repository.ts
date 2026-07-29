import {
  MaintenanceContract,
  type ContractInvoiceProjection,
  type ContractInvoicesReadPort,
  type EquipmentContractCoveragePort,
  type InvoiceKind,
  type InvoiceStatus,
  type MaintenanceContractProps,
  type MaintenanceContractRepository,
} from '@bob/core';
import { Prisma } from '@prisma/client';
import type { PrismaService } from './prisma.service';
import { docKindToInvoiceKind } from './mappers';

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function toDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

interface ContractRow {
  id: string;
  companyId: string;
  customerId: string;
  chantierId: string | null;
  label: string;
  status: string;
  anniversaryDate: Date;
  noticeDays: number;
  visitsPerYear: number;
  tacitRenewal: boolean;
  importCoveredUntil: Date | null;
  activatedAt: Date | null;
  terminatedAt: Date | null;
  terminationEffectiveDate: Date | null;
  terminationNote: string | null;
  notes: string | null;
  revision: number;
  lines: {
    id: string;
    catalogueItemId: string | null;
    label: string;
    quantity: { toString(): string };
    unitPriceHtCents: number;
    vatRate: { toString(): string };
    position: number;
  }[];
  equipments: { equipmentId: string }[];
}

const CONTRACT_INCLUDE = {
  lines: { orderBy: { position: 'asc' as const } },
  equipments: true,
};

function contractFromRow(row: ContractRow): MaintenanceContract {
  return MaintenanceContract.rehydrate({
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    chantierId: row.chantierId,
    label: row.label,
    status: row.status as MaintenanceContractProps['status'],
    anniversaryDate: dateOnly(row.anniversaryDate),
    noticeDays: row.noticeDays,
    visitsPerYear: row.visitsPerYear,
    tacitRenewal: row.tacitRenewal,
    importCoveredUntil: row.importCoveredUntil === null ? null : dateOnly(row.importCoveredUntil),
    activatedAt: row.activatedAt === null ? null : row.activatedAt.toISOString(),
    terminatedAt: row.terminatedAt === null ? null : row.terminatedAt.toISOString(),
    terminationEffectiveDate:
      row.terminationEffectiveDate === null ? null : dateOnly(row.terminationEffectiveDate),
    terminationNote: row.terminationNote,
    notes: row.notes,
    revision: row.revision,
    lines: row.lines.map((line) => ({
      id: line.id,
      catalogueItemId: line.catalogueItemId,
      label: line.label,
      quantity: Number(line.quantity.toString()),
      unitPriceHtCents: line.unitPriceHtCents,
      vatRate: Number(line.vatRate.toString()) as MaintenanceContractProps['lines'][number]['vatRate'],
      position: line.position,
    })),
    equipmentIds: row.equipments.map((link) => link.equipmentId),
  });
}

/** PostgreSQL est l'unique autorité des contrats de maintenance en runtime live (PR-12b). */
export class PrismaMaintenanceContractRepository implements MaintenanceContractRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(contract: MaintenanceContract): Promise<void> {
    const value = contract.toProps();
    const data = {
      companyId: value.companyId,
      customerId: value.customerId,
      chantierId: value.chantierId,
      label: value.label,
      status: value.status,
      anniversaryDate: toDate(value.anniversaryDate),
      noticeDays: value.noticeDays,
      visitsPerYear: value.visitsPerYear,
      tacitRenewal: value.tacitRenewal,
      importCoveredUntil:
        value.importCoveredUntil === null ? null : toDate(value.importCoveredUntil),
      activatedAt: value.activatedAt === null ? null : new Date(value.activatedAt),
      terminatedAt: value.terminatedAt === null ? null : new Date(value.terminatedAt),
      terminationEffectiveDate:
        value.terminationEffectiveDate === null ? null : toDate(value.terminationEffectiveDate),
      terminationNote: value.terminationNote,
      notes: value.notes,
      revision: value.revision,
    } as const;
    const db = this.prisma.client();
    await db.maintenanceContract.upsert({
      where: { id: value.id },
      create: { id: value.id, ...data },
      update: data,
    });
    // Lignes + liaison équipements : remplacement ATOMIQUE (l'agrégat est l'autorité de sa
    // composition — même doctrine que les lignes de pièces).
    await db.maintenanceContractLine.deleteMany({ where: { contractId: value.id } });
    if (value.lines.length > 0) {
      await db.maintenanceContractLine.createMany({
        data: value.lines.map((line) => ({
          id: line.id,
          companyId: value.companyId,
          contractId: value.id,
          catalogueItemId: line.catalogueItemId,
          label: line.label,
          quantity: new Prisma.Decimal(line.quantity),
          unitPriceHtCents: line.unitPriceHtCents,
          vatRate: new Prisma.Decimal(line.vatRate),
          position: line.position,
        })),
      });
    }
    await db.maintenanceContractEquipment.deleteMany({ where: { contractId: value.id } });
    if (value.equipmentIds.length > 0) {
      await db.maintenanceContractEquipment.createMany({
        data: value.equipmentIds.map((equipmentId) => ({
          companyId: value.companyId,
          contractId: value.id,
          equipmentId,
        })),
      });
    }
  }

  async findById(companyId: string, id: string): Promise<MaintenanceContract | null> {
    const row = await this.prisma.client().maintenanceContract.findFirst({
      where: { id, companyId },
      include: CONTRACT_INCLUDE,
    });
    return row === null ? null : contractFromRow(row);
  }

  /** SELECT … FOR UPDATE dans la transaction courante — sérialise les émissions concurrentes
   * de la facture annuelle (garde IssueInvoice) et les mutations du contrat. */
  async lockById(companyId: string, id: string): Promise<MaintenanceContract | null> {
    const db = this.prisma.client();
    await db.$queryRaw(
      Prisma.sql`SELECT "id" FROM "maintenance_contracts" WHERE "id" = ${id} AND "companyId" = ${companyId} FOR UPDATE`,
    );
    const row = await db.maintenanceContract.findFirst({
      where: { id, companyId },
      include: CONTRACT_INCLUDE,
    });
    return row === null ? null : contractFromRow(row);
  }

  async listByCompany(companyId: string): Promise<MaintenanceContract[]> {
    const rows = await this.prisma.client().maintenanceContract.findMany({
      where: { companyId },
      include: CONTRACT_INCLUDE,
      orderBy: [{ label: 'asc' }, { id: 'asc' }],
    });
    return rows.map(contractFromRow);
  }

  async listByCustomer(companyId: string, customerId: string): Promise<MaintenanceContract[]> {
    const rows = await this.prisma.client().maintenanceContract.findMany({
      where: { companyId, customerId },
      include: CONTRACT_INCLUDE,
      orderBy: [{ label: 'asc' }, { id: 'asc' }],
    });
    return rows.map(contractFromRow);
  }

  async deleteById(companyId: string, id: string): Promise<void> {
    // Le trigger BEFORE DELETE draft-only re-refuse tout contrat vivant (défense en profondeur).
    await this.prisma.client().maintenanceContract.deleteMany({ where: { id, companyId } });
  }
}

interface ContractInvoiceRow {
  id: string;
  number: string | null;
  kind: string;
  status: string;
  maintenanceContractId: string | null;
  servicePeriodStart: Date | null;
  servicePeriodEnd: Date | null;
}

function projectionOf(row: ContractInvoiceRow): ContractInvoiceProjection {
  return {
    id: row.id,
    number: row.number,
    kind: docKindToInvoiceKind(row.kind) as InvoiceKind,
    status: row.status as InvoiceStatus,
    servicePeriodStart: row.servicePeriodStart === null ? null : dateOnly(row.servicePeriodStart),
    servicePeriodEnd: row.servicePeriodEnd === null ? null : dateOnly(row.servicePeriodEnd),
  };
}

/**
 * Lecture des factures de contrat pour la dérivation de couverture (§2.5) — servie par
 * l'index PARTIEL invoices_contract_period_idx. [Annexe erratum n° 8] la lecture par SOCIÉTÉ
 * est UNE requête (préfixe (companyId) du même index), projections groupées par contrat —
 * jamais N requêtes par contrat au cron ni pour les priorités Aujourd'hui.
 */
export class PrismaContractInvoicesRead implements ContractInvoicesReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listByMaintenanceContract(
    companyId: string,
    contractId: string,
  ): Promise<ContractInvoiceProjection[]> {
    const rows = await this.prisma.client().invoice.findMany({
      where: { companyId, maintenanceContractId: contractId },
      select: {
        id: true,
        number: true,
        kind: true,
        status: true,
        maintenanceContractId: true,
        servicePeriodStart: true,
        servicePeriodEnd: true,
      },
    });
    return rows.map(projectionOf);
  }

  async listContractInvoicesByCompany(
    companyId: string,
  ): Promise<Map<string, ContractInvoiceProjection[]>> {
    const rows = await this.prisma.client().invoice.findMany({
      where: { companyId, maintenanceContractId: { not: null } },
      select: {
        id: true,
        number: true,
        kind: true,
        status: true,
        maintenanceContractId: true,
        servicePeriodStart: true,
        servicePeriodEnd: true,
      },
    });
    const grouped = new Map<string, ContractInvoiceProjection[]>();
    for (const row of rows) {
      const contractId = row.maintenanceContractId;
      if (contractId === null) continue;
      const bucket = grouped.get(contractId);
      const projection = projectionOf(row);
      if (bucket) bucket.push(projection);
      else grouped.set(contractId, [projection]);
    }
    return grouped;
  }
}

/**
 * [Amélioration 4] — couverture contractuelle RÉELLE d'un équipement, lue depuis la table de
 * liaison : libellés des contrats ACTIFS le couvrant. Câblé dans RetireEquipment (l'écran ET
 * la voix disent l'avertissement AVANT la confirmation) — fini le contractWarning=null.
 */
export class PrismaEquipmentContractCoverage implements EquipmentContractCoveragePort {
  constructor(private readonly prisma: PrismaService) {}

  async activeContractLabels(companyId: string, equipmentId: string): Promise<string[]> {
    const links = await this.prisma.client().maintenanceContractEquipment.findMany({
      where: { companyId, equipmentId, contract: { status: 'active' } },
      select: { contract: { select: { label: true } } },
      orderBy: { contractId: 'asc' },
    });
    return links.map((link) => link.contract.label);
  }
}
