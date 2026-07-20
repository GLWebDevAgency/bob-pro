import { Prisma, type CompanyDiagnosticAssessment as DiagnosticRow } from '@prisma/client';
import {
  assertDiagnosticAssessmentRecord,
  validateDiagnosticAssessmentAnswers,
  type DiagnosticAssessmentRecord,
  type DiagnosticAssessmentRepository,
  type DiagnosticAssessmentSaveInput,
  type DiagnosticAssessmentSaveResult,
  type DiagAxisId,
  type PersistedDiagnosticAnswers,
} from '@bob/core';
import type { PrismaService } from './prisma.service';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function answersFromJson(value: Prisma.JsonValue): PersistedDiagnosticAnswers {
  const hasOffApp = isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'offAppSales');
  const parsed = validateDiagnosticAssessmentAnswers(value, [
    'platform',
    ...(hasOffApp ? (['offAppSales'] as const) : []),
    'accountant',
  ]);
  if (!parsed.ok) throw new Error('DIAGNOSTIC_ASSESSMENT_ANSWERS_CORRUPT');
  return parsed.value;
}

function fromRow(row: DiagnosticRow): DiagnosticAssessmentRecord {
  const assessment: DiagnosticAssessmentRecord = {
    companyId: row.companyId,
    revision: row.revision,
    answers: answersFromJson(row.answers),
    score: row.score,
    axes: [
      { id: 'reception', score: row.receptionScore },
      { id: 'emission', score: row.emissionScore },
      { id: 'donnees', score: row.dataQualityScore },
    ],
    sourceFingerprint: row.sourceFingerprint,
    rulesetVersion: row.rulesetVersion,
    sourceAsOf: row.sourceAsOf.toISOString().slice(0, 10),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  assertDiagnosticAssessmentRecord(assessment);
  return assessment;
}

function jsonAnswers(value: PersistedDiagnosticAnswers): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function axis(input: DiagnosticAssessmentSaveInput, id: DiagAxisId): number {
  const value = input.axes.find((candidate) => candidate.id === id)?.score;
  if (!Number.isSafeInteger(value) || value === undefined || value < 0 || value > 100) {
    throw new Error(`DIAGNOSTIC_ASSESSMENT_AXIS_INVALID:${id}`);
  }
  return value;
}

function rowData(input: DiagnosticAssessmentSaveInput) {
  return {
    answers: jsonAnswers(input.answers),
    score: input.score,
    receptionScore: axis(input, 'reception'),
    emissionScore: axis(input, 'emission'),
    dataQualityScore: axis(input, 'donnees'),
    sourceFingerprint: input.sourceFingerprint,
    rulesetVersion: input.rulesetVersion,
    sourceAsOf: new Date(`${input.sourceAsOf}T00:00:00.000Z`),
  };
}

/** Autorité PostgreSQL : une ligne par tenant, RLS et compare-and-swap atomique. */
export class PrismaDiagnosticAssessmentRepository implements DiagnosticAssessmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByCompanyId(companyId: string): Promise<DiagnosticAssessmentRecord | null> {
    const row = await this.prisma.client().companyDiagnosticAssessment.findUnique({
      where: { companyId },
    });
    return row === null ? null : fromRow(row);
  }

  async save(input: DiagnosticAssessmentSaveInput): Promise<DiagnosticAssessmentSaveResult> {
    const data = rowData(input);
    if (input.expectedRevision === 0) {
      const inserted = await this.prisma.client().companyDiagnosticAssessment.createMany({
        data: [{ companyId: input.companyId, revision: 1, ...data }],
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        const assessment = await this.findByCompanyId(input.companyId);
        if (assessment === null) throw new Error('DIAGNOSTIC_ASSESSMENT_CREATED_BUT_NOT_VISIBLE');
        return { status: 'created', assessment };
      }
      const current = await this.findByCompanyId(input.companyId);
      return { status: 'revision_conflict', currentRevision: current?.revision ?? null };
    }

    const updated = await this.prisma.client().companyDiagnosticAssessment.updateMany({
      where: { companyId: input.companyId, revision: input.expectedRevision },
      data: {
        ...data,
        revision: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    if (updated.count === 1) {
      const assessment = await this.findByCompanyId(input.companyId);
      if (assessment === null) throw new Error('DIAGNOSTIC_ASSESSMENT_UPDATED_BUT_NOT_VISIBLE');
      return { status: 'updated', assessment };
    }
    const current = await this.findByCompanyId(input.companyId);
    return { status: 'revision_conflict', currentRevision: current?.revision ?? null };
  }
}
