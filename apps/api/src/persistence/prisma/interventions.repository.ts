import {
  Intervention,
  type ChecklistItem,
  type CompanyInterventionSettings,
  type CompanyInterventionSettingsRepository,
  type InterventionProps,
  type InterventionRepository,
  type InterventionSignature,
} from '@bob/core';
import { Prisma } from '@prisma/client';
import type { PrismaService } from './prisma.service';

/** Ligne brute d'`interventions` — projection EXPLICITE (jamais un `any` de commodité). */
interface InterventionRow {
  id: string;
  companyId: string;
  chantierId: string;
  customerId: string;
  contractId: string | null;
  equipmentId: string | null;
  kind: string;
  status: string;
  plannedAt: Date | null;
  technicianLabel: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  checklist: unknown;
  summary: string | null;
  signatureProof: unknown;
  reportDocumentId: string | null;
  billedInvoiceId: string | null;
  revision: number;
}

/** Checklist LIBRE : la forme est re-vérifiée à la lecture (le CHECK SQL garantit le tableau). */
function checklistFromJson(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) return [];
  const items: ChecklistItem[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.label !== 'string' || typeof item.done !== 'boolean') continue;
    items.push({
      label: item.label,
      done: item.done,
      ...(typeof item.note === 'string' ? { note: item.note } : {}),
    });
  }
  return items;
}

function signatureFromJson(value: unknown): InterventionSignature | null {
  if (typeof value !== 'object' || value === null) return null;
  const proof = value as Record<string, unknown>;
  if (
    typeof proof.signerName !== 'string' ||
    proof.method !== 'onsite_draw' ||
    typeof proof.sha256 !== 'string' ||
    typeof proof.capturedAt !== 'string'
  ) {
    return null;
  }
  return {
    signerName: proof.signerName,
    method: 'onsite_draw',
    sha256: proof.sha256,
    capturedAt: proof.capturedAt,
    ...(typeof proof.capturedAtDevice === 'string'
      ? { capturedAtDevice: proof.capturedAtDevice }
      : {}),
    ...(typeof proof.syncedAt === 'string' ? { syncedAt: proof.syncedAt } : {}),
  };
}

function interventionFromRow(row: InterventionRow): Intervention {
  return Intervention.rehydrate({
    id: row.id,
    companyId: row.companyId,
    chantierId: row.chantierId,
    customerId: row.customerId,
    contractId: row.contractId,
    equipmentId: row.equipmentId,
    kind: row.kind,
    status: row.status as InterventionProps['status'],
    plannedAt: row.plannedAt === null ? null : row.plannedAt.toISOString(),
    technicianLabel: row.technicianLabel,
    startedAt: row.startedAt === null ? null : row.startedAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    checklist: checklistFromJson(row.checklist),
    summary: row.summary,
    signature: signatureFromJson(row.signatureProof),
    reportDocumentId: row.reportDocumentId,
    billedInvoiceId: row.billedInvoiceId,
    revision: row.revision,
  });
}

function persistablePayload(value: InterventionProps) {
  return {
    companyId: value.companyId,
    chantierId: value.chantierId,
    customerId: value.customerId,
    contractId: value.contractId,
    equipmentId: value.equipmentId,
    kind: value.kind,
    status: value.status,
    plannedAt: value.plannedAt === null ? null : new Date(value.plannedAt),
    technicianLabel: value.technicianLabel,
    startedAt: value.startedAt === null ? null : new Date(value.startedAt),
    finishedAt: value.finishedAt === null ? null : new Date(value.finishedAt),
    checklist: value.checklist as unknown as Prisma.InputJsonValue,
    summary: value.summary,
    signatureProof:
      value.signature === null
        ? Prisma.DbNull
        : (value.signature as unknown as Prisma.InputJsonValue),
    reportDocumentId: value.reportDocumentId,
    billedInvoiceId: value.billedInvoiceId,
    revision: value.revision,
  } as const;
}

/** Erreur Prisma « violation de contrainte d'unicité » (P2002) — la PK d'une fiche cliente. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** PostgreSQL est l'unique autorité des fiches de passage en runtime live (PR-15b). */
export class PrismaInterventionRepository implements InterventionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Création STRICTE (jamais un upsert) : l'id vient du CLIENT (offline-first §3.6). Une
   * collision de clé primaire — y compris avec la fiche d'un AUTRE tenant, invisible sous RLS —
   * remonte `id_collision` SANS révéler l'existence ni le tenant ([Revue P15]).
   */
  async create(intervention: Intervention): Promise<{ outcome: 'created' | 'id_collision' }> {
    const value = intervention.toProps();
    try {
      await this.prisma.client().intervention.create({
        data: { id: value.id, ...persistablePayload(value) },
      });
      return { outcome: 'created' };
    } catch (error) {
      if (isUniqueViolation(error)) return { outcome: 'id_collision' };
      throw error;
    }
  }

  /** Mise à jour tenant-scopée : jamais un upsert (une fiche inconnue ne se crée pas ici). */
  async save(intervention: Intervention): Promise<void> {
    const value = intervention.toProps();
    const { companyId: _companyId, ...data } = persistablePayload(value);
    const updated = await this.prisma.client().intervention.updateMany({
      where: { id: value.id, companyId: value.companyId },
      data,
    });
    if (updated.count === 0) {
      throw new Error(`intervention ${value.id} absente du tenant courant`);
    }
  }

  async findById(companyId: string, id: string): Promise<Intervention | null> {
    const row = await this.prisma.client().intervention.findFirst({ where: { id, companyId } });
    return row === null ? null : interventionFromRow(row as unknown as InterventionRow);
  }

  /** SELECT … FOR UPDATE dans la transaction courante — sérialise les mutations concurrentes
   * (deux appareils, voix + UI, rejeu de l'outbox offline). */
  async lockById(companyId: string, id: string): Promise<Intervention | null> {
    const rows = await this.prisma.client().$queryRaw<InterventionRow[]>(Prisma.sql`
      SELECT "id", "companyId", "chantierId", "customerId", "contractId", "equipmentId",
             "kind", "status", "plannedAt", "technicianLabel", "startedAt", "finishedAt",
             "checklist", "summary", "signatureProof", "reportDocumentId", "billedInvoiceId",
             "revision"
        FROM "interventions"
       WHERE "id" = ${id} AND "companyId" = ${companyId}
       FOR UPDATE
    `);
    const row = rows[0];
    return row === undefined ? null : interventionFromRow(row);
  }

  async listByChantier(companyId: string, chantierId: string): Promise<Intervention[]> {
    const rows = await this.prisma.client().intervention.findMany({
      where: { companyId, chantierId },
      orderBy: [{ plannedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map((row) => interventionFromRow(row as unknown as InterventionRow));
  }

  async listByCompany(companyId: string): Promise<Intervention[]> {
    const rows = await this.prisma.client().intervention.findMany({
      where: { companyId },
      orderBy: [{ plannedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map((row) => interventionFromRow(row as unknown as InterventionRow));
  }

  /** PR-16 — détache les fiches liées à un brouillon de facture supprimé (le droit de
   * « Facturer ce passage » se rallume par l'état réel, jamais par un statut inventé). */
  async detachByInvoice(companyId: string, invoiceId: string): Promise<void> {
    await this.prisma.client().intervention.updateMany({
      where: { companyId, billedInvoiceId: invoiceId },
      data: { billedInvoiceId: null, revision: { increment: 1 } },
    });
  }
}

/** Réglages de fiche par société (titre de PDF paramétrable + templates de checklist). */
export class PrismaCompanyInterventionSettingsRepository
  implements CompanyInterventionSettingsRepository
{
  constructor(private readonly prisma: PrismaService) {}

  async find(companyId: string): Promise<CompanyInterventionSettings | null> {
    const row = await this.prisma
      .client()
      .companyInterventionSettings.findFirst({ where: { companyId } });
    if (row === null) return null;
    const templates: Record<string, string[]> = {};
    if (typeof row.checklistTemplates === 'object' && row.checklistTemplates !== null) {
      for (const [key, value] of Object.entries(row.checklistTemplates)) {
        if (Array.isArray(value)) {
          templates[key] = value.filter((label): label is string => typeof label === 'string');
        }
      }
    }
    return {
      companyId: row.companyId,
      reportTitle: row.reportTitle,
      checklistTemplates: templates,
      revision: row.revision,
    };
  }

  async save(settings: CompanyInterventionSettings): Promise<void> {
    const data = {
      reportTitle: settings.reportTitle,
      checklistTemplates: settings.checklistTemplates as unknown as Prisma.InputJsonValue,
      revision: settings.revision,
    } as const;
    await this.prisma.client().companyInterventionSettings.upsert({
      where: { companyId: settings.companyId },
      create: { companyId: settings.companyId, ...data },
      update: data,
    });
  }
}
