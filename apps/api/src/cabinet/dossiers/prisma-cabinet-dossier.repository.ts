import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { getCorrelationId } from '../../observability/logger';
import type { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  cabinetDossierFiscalProfileSchema,
  cabinetDossierReviewSchema,
  deriveCabinetDossierFinancialSummary,
  storedFecAnalysisSchema,
  type CabinetDossier,
  type CabinetDossierFinancialSummary,
  type CabinetDossierSummary,
} from './cabinet-dossier-contract';
import type {
  CabinetDossierDeleteOutcome,
  CabinetDossierMutationData,
  CabinetDossierMutationOutcome,
  CabinetDossierPage,
  CabinetDossierRepository,
} from './cabinet-dossier-repository';

interface CabinetDossierSummaryRow {
  id: string;
  cabinetId: string;
  siren: string;
  clientName: string;
  sourceFileName: string;
  entryCount: number;
  rowCount: number;
  periodFrom: Date;
  periodTo: Date;
  turnoverCents: bigint;
  resultCents: bigint;
  totalDebitCents: bigint;
  totalCreditCents: bigint;
  trialBalanceBalanced: boolean;
  balanceSheetBalanced: boolean;
  statementsConsistent: boolean;
  balanceSheetDifferenceCents: bigint;
  review: Prisma.JsonValue | null;
  fiscal: Prisma.JsonValue;
  lastImportedAt: Date;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

interface CabinetDossierRow extends CabinetDossierSummaryRow {
  analysis: Prisma.JsonValue;
  analysisSha256: string;
}

interface LockedDossierRow {
  id: string;
  revision: number;
  analysisSha256: string;
}

interface CursorValue {
  updatedAt: string;
  id: string;
}

export class CabinetDossierPersistenceCorruptionError extends Error {
  constructor(readonly reason: string) {
    super(`Cabinet dossier persistence corruption: ${reason}.`);
    this.name = 'CabinetDossierPersistenceCorruptionError';
  }
}

export class CabinetDossierCursorError extends Error {
  constructor() {
    super('Invalid cabinet dossier cursor.');
    this.name = 'CabinetDossierCursorError';
  }
}

function safeNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new CabinetDossierPersistenceCorruptionError(field);
  return number;
}

function dateOnly(value: Date, field: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new CabinetDossierPersistenceCorruptionError(field);
  }
  return value.toISOString().slice(0, 10);
}

function instant(value: Date, field: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new CabinetDossierPersistenceCorruptionError(field);
  }
  return value.toISOString();
}

function financialFromRow(row: CabinetDossierSummaryRow): CabinetDossierFinancialSummary {
  const financial = {
    turnoverCents: safeNumber(row.turnoverCents, 'turnoverCents'),
    resultCents: safeNumber(row.resultCents, 'resultCents'),
    totalDebitCents: safeNumber(row.totalDebitCents, 'totalDebitCents'),
    totalCreditCents: safeNumber(row.totalCreditCents, 'totalCreditCents'),
    trialBalanceBalanced: row.trialBalanceBalanced,
    balanceSheetBalanced: row.balanceSheetBalanced,
    statementsConsistent: row.statementsConsistent,
    balanceSheetDifferenceCents: safeNumber(
      row.balanceSheetDifferenceCents,
      'balanceSheetDifferenceCents',
    ),
  };
  if (financial.trialBalanceBalanced !== (financial.totalDebitCents === financial.totalCreditCents)) {
    throw new CabinetDossierPersistenceCorruptionError('trialBalanceBalanced');
  }
  if (financial.balanceSheetBalanced !== (financial.balanceSheetDifferenceCents === 0)) {
    throw new CabinetDossierPersistenceCorruptionError('balanceSheetBalanced');
  }
  return financial;
}

function summaryFromRow(row: CabinetDossierSummaryRow): CabinetDossierSummary {
  const fiscal = cabinetDossierFiscalProfileSchema.safeParse(row.fiscal);
  if (!fiscal.success) throw new CabinetDossierPersistenceCorruptionError('fiscal');
  const review = row.review === null ? { success: true as const, data: null } : cabinetDossierReviewSchema.safeParse(row.review);
  if (!review.success) throw new CabinetDossierPersistenceCorruptionError('review');
  if (!Number.isSafeInteger(row.entryCount) || row.entryCount < 1) {
    throw new CabinetDossierPersistenceCorruptionError('entryCount');
  }
  if (!Number.isSafeInteger(row.rowCount) || row.rowCount < row.entryCount) {
    throw new CabinetDossierPersistenceCorruptionError('rowCount');
  }
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new CabinetDossierPersistenceCorruptionError('revision');
  }
  return {
    id: row.id,
    cabinetId: row.cabinetId,
    siren: row.siren,
    clientName: row.clientName,
    sourceFileName: row.sourceFileName,
    entryCount: row.entryCount,
    rowCount: row.rowCount,
    period: { from: dateOnly(row.periodFrom, 'periodFrom'), to: dateOnly(row.periodTo, 'periodTo') },
    financial: financialFromRow(row),
    review: review.data,
    fiscal: fiscal.data,
    lastImportedAt: instant(row.lastImportedAt, 'lastImportedAt'),
    revision: row.revision,
    createdAt: instant(row.createdAt, 'createdAt'),
    updatedAt: instant(row.updatedAt, 'updatedAt'),
  };
}

function dossierFromRow(row: CabinetDossierRow): CabinetDossier {
  const analysis = storedFecAnalysisSchema.safeParse(row.analysis);
  if (!analysis.success) throw new CabinetDossierPersistenceCorruptionError('analysis');
  if (!/^[0-9a-f]{64}$/.test(row.analysisSha256)) {
    throw new CabinetDossierPersistenceCorruptionError('analysisSha256');
  }
  const summary = summaryFromRow(row);
  if (JSON.stringify(summary.financial) !== JSON.stringify(deriveCabinetDossierFinancialSummary(analysis.data))) {
    throw new CabinetDossierPersistenceCorruptionError('financial');
  }
  return { ...summary, analysis: analysis.data, analysisSha256: row.analysisSha256 };
}

function encodeCursor(row: Pick<CabinetDossierSummaryRow, 'updatedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ updatedAt: row.updatedAt.toISOString(), id: row.id }), 'utf8')
    .toString('base64url');
}

function decodeCursor(value: string): CursorValue {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof decoded !== 'object'
      || decoded === null
      || Array.isArray(decoded)
      || Object.keys(decoded).sort().join(',') !== 'id,updatedAt'
    ) throw new CabinetDossierCursorError();
    const candidate = decoded as Record<string, unknown>;
    if (
      typeof candidate.id !== 'string'
      || candidate.id.length < 1
      || candidate.id.length > 160
      || typeof candidate.updatedAt !== 'string'
    ) throw new CabinetDossierCursorError();
    const parsed = new Date(candidate.updatedAt);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== candidate.updatedAt) {
      throw new CabinetDossierCursorError();
    }
    return { id: candidate.id, updatedAt: candidate.updatedAt };
  } catch (error) {
    if (error instanceof CabinetDossierCursorError) throw error;
    throw new CabinetDossierCursorError();
  }
}

function json(value: unknown): Prisma.Sql {
  return Prisma.sql`${JSON.stringify(value)}::jsonb`;
}

function nullableJson(value: unknown | null): Prisma.Sql {
  return value === null ? Prisma.sql`NULL` : json(value);
}

const SUMMARY_COLUMNS = Prisma.sql`
  "id", "cabinetId", "siren", "clientName", "sourceFileName", "entryCount", "rowCount",
  "periodFrom", "periodTo", "turnoverCents", "resultCents", "totalDebitCents",
  "totalCreditCents", "trialBalanceBalanced", "balanceSheetBalanced", "statementsConsistent",
  "balanceSheetDifferenceCents", "review", "fiscal", "lastImportedAt", "revision",
  "createdAt", "updatedAt"
`;

function mutationValues(data: CabinetDossierMutationData): Prisma.Sql {
  return Prisma.sql`
    "clientName" = ${data.clientName},
    "sourceFileName" = ${data.sourceFileName},
    "entryCount" = ${data.entryCount},
    "rowCount" = ${data.rowCount},
    "periodFrom" = ${data.period.from}::date,
    "periodTo" = ${data.period.to}::date,
    "turnoverCents" = ${data.financial.turnoverCents},
    "resultCents" = ${data.financial.resultCents},
    "totalDebitCents" = ${data.financial.totalDebitCents},
    "totalCreditCents" = ${data.financial.totalCreditCents},
    "trialBalanceBalanced" = ${data.financial.trialBalanceBalanced},
    "balanceSheetBalanced" = ${data.financial.balanceSheetBalanced},
    "statementsConsistent" = ${data.financial.statementsConsistent},
    "balanceSheetDifferenceCents" = ${data.financial.balanceSheetDifferenceCents},
    "analysis" = ${json(data.analysis)},
    "analysisSha256" = ${data.analysisSha256},
    "review" = ${nullableJson(data.review)},
    "fiscal" = ${json(data.fiscal)},
    "lastImportedAt" = ${new Date(data.lastImportedAt)}
  `;
}

export class PrismaCabinetDossierRepository implements CabinetDossierRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listSummaries(input: {
    cabinetId: string;
    cursor?: string;
    limit: number;
  }): Promise<CabinetDossierPage> {
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await this.prisma.client().$queryRaw<CabinetDossierSummaryRow[]>(Prisma.sql`
      SELECT ${SUMMARY_COLUMNS}
        FROM "cabinet_dossiers"
       WHERE "cabinetId" = ${input.cabinetId}
         ${cursor === null ? Prisma.empty : Prisma.sql`AND ("updatedAt", "id") < (${new Date(cursor.updatedAt)}, ${cursor.id})`}
       ORDER BY "updatedAt" DESC, "id" DESC
       LIMIT ${input.limit + 1}
    `);
    const pageRows = rows.slice(0, input.limit);
    return {
      items: pageRows.map(summaryFromRow),
      nextCursor: rows.length > input.limit && pageRows.length > 0
        ? encodeCursor(pageRows[pageRows.length - 1]!)
        : null,
    };
  }

  async findBySiren(cabinetId: string, siren: string): Promise<CabinetDossier | null> {
    const rows = await this.prisma.client().$queryRaw<CabinetDossierRow[]>(Prisma.sql`
      SELECT ${SUMMARY_COLUMNS}, "analysis", "analysisSha256"
        FROM "cabinet_dossiers"
       WHERE "cabinetId" = ${cabinetId} AND "siren" = ${siren}
       LIMIT 1
    `);
    return rows[0] ? dossierFromRow(rows[0]) : null;
  }

  async create(input: {
    id: string;
    cabinetId: string;
    actorUserId: string;
    data: CabinetDossierMutationData;
    now: string;
  }): Promise<CabinetDossierMutationOutcome> {
    this.requireTransaction();
    const rows = await this.prisma.client().$queryRaw<CabinetDossierRow[]>(Prisma.sql`
      INSERT INTO "cabinet_dossiers" (
        "id", "cabinetId", "siren", "clientName", "sourceFileName", "entryCount", "rowCount",
        "periodFrom", "periodTo", "turnoverCents", "resultCents", "totalDebitCents",
        "totalCreditCents", "trialBalanceBalanced", "balanceSheetBalanced", "statementsConsistent",
        "balanceSheetDifferenceCents", "analysis", "analysisSha256", "review", "fiscal",
        "lastImportedAt", "revision", "createdAt", "updatedAt"
      ) VALUES (
        ${input.id}, ${input.cabinetId}, ${input.data.siren}, ${input.data.clientName},
        ${input.data.sourceFileName}, ${input.data.entryCount}, ${input.data.rowCount},
        ${input.data.period.from}::date, ${input.data.period.to}::date,
        ${input.data.financial.turnoverCents}, ${input.data.financial.resultCents},
        ${input.data.financial.totalDebitCents}, ${input.data.financial.totalCreditCents},
        ${input.data.financial.trialBalanceBalanced}, ${input.data.financial.balanceSheetBalanced},
        ${input.data.financial.statementsConsistent}, ${input.data.financial.balanceSheetDifferenceCents},
        ${json(input.data.analysis)}, ${input.data.analysisSha256}, ${nullableJson(input.data.review)},
        ${json(input.data.fiscal)}, ${new Date(input.data.lastImportedAt)}, 1,
        ${new Date(input.now)}, ${new Date(input.now)}
      )
      ON CONFLICT ("cabinetId", "siren") DO NOTHING
      RETURNING ${SUMMARY_COLUMNS}, "analysis", "analysisSha256"
    `);
    const dossier = rows[0];
    if (!dossier) return { kind: 'conflict' };
    await this.audit(input.cabinetId, input.actorUserId, 'CabinetDossierCreated', input.id, {
      siren: input.data.siren,
      revision: 1,
      analysisSha256: input.data.analysisSha256,
    });
    return { kind: 'saved', dossier: dossierFromRow(dossier) };
  }

  async replace(input: {
    cabinetId: string;
    actorUserId: string;
    expectedRevision: number;
    data: CabinetDossierMutationData;
    now: string;
  }): Promise<CabinetDossierMutationOutcome> {
    this.requireTransaction();
    const current = await this.lock(input.cabinetId, input.data.siren);
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.expectedRevision) return { kind: 'conflict' };
    const rows = await this.prisma.client().$queryRaw<CabinetDossierRow[]>(Prisma.sql`
      UPDATE "cabinet_dossiers"
         SET ${mutationValues(input.data)},
             "revision" = ${input.expectedRevision + 1},
             "updatedAt" = ${new Date(input.now)}
       WHERE "cabinetId" = ${input.cabinetId}
         AND "siren" = ${input.data.siren}
         AND "revision" = ${input.expectedRevision}
      RETURNING ${SUMMARY_COLUMNS}, "analysis", "analysisSha256"
    `);
    const dossier = rows[0];
    if (!dossier) return { kind: 'conflict' };
    await this.audit(input.cabinetId, input.actorUserId, 'CabinetDossierUpdated', current.id, {
      siren: input.data.siren,
      fromRevision: input.expectedRevision,
      toRevision: input.expectedRevision + 1,
      previousAnalysisSha256: current.analysisSha256,
      analysisSha256: input.data.analysisSha256,
    });
    return { kind: 'saved', dossier: dossierFromRow(dossier) };
  }

  async delete(input: {
    cabinetId: string;
    siren: string;
    actorUserId: string;
    expectedRevision: number;
    now: string;
  }): Promise<CabinetDossierDeleteOutcome> {
    this.requireTransaction();
    const current = await this.lock(input.cabinetId, input.siren);
    if (!current) return 'not_found';
    if (current.revision !== input.expectedRevision) return 'conflict';
    const deleted = await this.prisma.client().$executeRaw(Prisma.sql`
      DELETE FROM "cabinet_dossiers"
       WHERE "cabinetId" = ${input.cabinetId}
         AND "siren" = ${input.siren}
         AND "revision" = ${input.expectedRevision}
    `);
    if (deleted !== 1) return 'conflict';
    await this.audit(input.cabinetId, input.actorUserId, 'CabinetDossierDeleted', current.id, {
      siren: input.siren,
      revision: input.expectedRevision,
      analysisSha256: current.analysisSha256,
      deletedAt: input.now,
    });
    return 'deleted';
  }

  private async lock(cabinetId: string, siren: string): Promise<LockedDossierRow | null> {
    const rows = await this.prisma.client().$queryRaw<LockedDossierRow[]>(Prisma.sql`
      SELECT "id", "revision", "analysisSha256"
        FROM "cabinet_dossiers"
       WHERE "cabinetId" = ${cabinetId} AND "siren" = ${siren}
       FOR UPDATE
    `);
    return rows[0] ?? null;
  }

  private requireTransaction(): void {
    if (!this.prisma.inTransaction()) {
      throw new Error('Cabinet dossier mutations require an active tenant transaction.');
    }
  }

  private async audit(
    cabinetId: string,
    actorUserId: string,
    action: string,
    entityId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.prisma.client().cabinetAuditEvent.create({
      data: {
        id: randomUUID(),
        cabinetId,
        actorUserId,
        action,
        entityType: 'cabinet_dossier',
        entityId,
        payload: payload as Prisma.InputJsonValue,
        correlationId: getCorrelationId() === '-' ? null : getCorrelationId(),
      },
    });
  }
}

export const cabinetDossierCursor = { encode: encodeCursor, decode: decodeCursor };
