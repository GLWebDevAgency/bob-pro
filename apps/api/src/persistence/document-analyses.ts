import { isDeepStrictEqual } from 'node:util';
import {
  makeDocumentAnalysis,
  type DocumentAnalysis,
  type DocumentAnalysisDraft,
} from '@bob/core';
import type {
  DocumentAnalysisCache as PrismaDocumentAnalysisCache,
  Prisma,
} from '@prisma/client';
import type { PrismaService } from './prisma/prisma.service';

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Version du contrat JSON persistant, indépendante de la version de l'analyseur IA.
 * Toute évolution incompatible doit créer un nouveau validateur SQL et incrémenter cette valeur.
 */
export const DOCUMENT_ANALYSIS_SCHEMA_VERSION = 1 as const;

export interface DocumentAnalysisCacheKey {
  readonly companyId: string;
  readonly documentId: string;
  readonly documentVersion: number;
  readonly sourceSha256: string;
}

/**
 * `analysis` conserve le value object complet afin qu'une lecture de cache ne reconstruise jamais
 * une vérité à partir d'un sous-ensemble. Les champs dupliqués sont revalidés contre la clé et les
 * métadonnées SQL à chaque écriture ET lecture (défense contre une ligne historique corrompue).
 */
export interface DocumentAnalysisCacheRecord extends DocumentAnalysisCacheKey {
  readonly analyzerVersion: string;
  readonly analysisSchemaVersion: typeof DOCUMENT_ANALYSIS_SCHEMA_VERSION;
  readonly analysis: DocumentAnalysis;
  readonly analyzedAt: string;
}

export type DocumentAnalysisCacheWrite = Omit<DocumentAnalysisCacheRecord, 'analysisSchemaVersion'> & {
  /** Réservé aux migrations/tests : une version inconnue est toujours rejetée. */
  readonly analysisSchemaVersion?: number;
};

export interface DocumentAnalysisStore {
  findExact(key: DocumentAnalysisCacheKey): Promise<DocumentAnalysisCacheRecord | null>;
  /** Insert-only : en cas de course, retourne la ligne gagnante sans jamais la remplacer. */
  putIfAbsent(record: DocumentAnalysisCacheWrite): Promise<DocumentAnalysisCacheRecord>;
}

export class InvalidDocumentAnalysisCacheRecordError extends Error {
  constructor(readonly field: string, message: string) {
    super(`Invalid document analysis cache record (${field}): ${message}`);
    this.name = 'InvalidDocumentAnalysisCacheRecordError';
  }
}

function exactRequiredString(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new InvalidDocumentAnalysisCacheRecordError(field, 'non-empty canonical string required');
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new InvalidDocumentAnalysisCacheRecordError(field, `maximum length is ${maxLength}`);
  }
  return value;
}

function validateKey(key: DocumentAnalysisCacheKey): DocumentAnalysisCacheKey {
  const companyId = exactRequiredString(key.companyId, 'companyId');
  const documentId = exactRequiredString(key.documentId, 'documentId');
  if (!Number.isSafeInteger(key.documentVersion) || key.documentVersion <= 0) {
    throw new InvalidDocumentAnalysisCacheRecordError('documentVersion', 'positive safe integer required');
  }
  if (typeof key.sourceSha256 !== 'string' || !SHA256.test(key.sourceSha256)) {
    throw new InvalidDocumentAnalysisCacheRecordError('sourceSha256', 'lowercase SHA-256 required');
  }
  return { companyId, documentId, documentVersion: key.documentVersion, sourceSha256: key.sourceSha256 };
}

function canonicalInstant(value: unknown): string {
  const instant = exactRequiredString(value, 'analyzedAt');
  const timestamp = Date.parse(instant);
  if (!Number.isFinite(timestamp)) {
    throw new InvalidDocumentAnalysisCacheRecordError('analyzedAt', 'valid ISO-8601 instant required');
  }
  const canonical = new Date(timestamp).toISOString();
  if (canonical !== instant) {
    throw new InvalidDocumentAnalysisCacheRecordError('analyzedAt', 'canonical UTC ISO-8601 instant required');
  }
  return canonical;
}

function cloneAnalysis(analysis: DocumentAnalysis): DocumentAnalysis {
  return structuredClone(analysis);
}

function validatedRecord(record: DocumentAnalysisCacheWrite): DocumentAnalysisCacheRecord {
  const key = validateKey(record);
  if (
    record.analysisSchemaVersion !== undefined &&
    record.analysisSchemaVersion !== DOCUMENT_ANALYSIS_SCHEMA_VERSION
  ) {
    throw new InvalidDocumentAnalysisCacheRecordError(
      'analysisSchemaVersion',
      `supported version is ${DOCUMENT_ANALYSIS_SCHEMA_VERSION}`,
    );
  }
  const analyzerVersion = exactRequiredString(record.analyzerVersion, 'analyzerVersion', 120);
  const analyzedAt = canonicalInstant(record.analyzedAt);
  if (record.analysis === null || typeof record.analysis !== 'object' || Array.isArray(record.analysis)) {
    throw new InvalidDocumentAnalysisCacheRecordError('analysis', 'JSON object required');
  }

  const analysis = makeDocumentAnalysis(record.analysis as unknown as DocumentAnalysisDraft, {
    documentId: key.documentId,
    documentVersion: key.documentVersion,
    sourceSha256: key.sourceSha256,
    originalFilename:
      typeof record.analysis.suggestedFilename === 'string'
        ? record.analysis.suggestedFilename
        : 'document',
    analyzerVersion,
    analyzedAt,
  });
  if (!analysis.ok) {
    const field = analysis.error.code === 'VALIDATION' ? analysis.error.field : 'analysis';
    const message = analysis.error.code === 'VALIDATION' ? analysis.error.message : analysis.error.code;
    throw new InvalidDocumentAnalysisCacheRecordError(field, message);
  }
  // `makeDocumentAnalysis` normalise les sorties non fiables. Le cache, lui, n'accepte qu'une
  // sortie déjà canonique : une divergence signale une corruption ou un contournement du domaine.
  if (!isDeepStrictEqual(record.analysis, analysis.value)) {
    throw new InvalidDocumentAnalysisCacheRecordError('analysis', 'non-canonical or inconsistent value');
  }

  return {
    ...key,
    analyzerVersion,
    analysisSchemaVersion: DOCUMENT_ANALYSIS_SCHEMA_VERSION,
    analysis: cloneAnalysis(analysis.value),
    analyzedAt,
  };
}

function cloneRecord(record: DocumentAnalysisCacheRecord): DocumentAnalysisCacheRecord {
  return { ...record, analysis: cloneAnalysis(record.analysis) };
}

function cacheKey(key: DocumentAnalysisCacheKey): string {
  return JSON.stringify([key.companyId, key.documentId, key.documentVersion, key.sourceSha256]);
}

function fromPrisma(row: PrismaDocumentAnalysisCache): DocumentAnalysisCacheRecord {
  return validatedRecord({
    companyId: row.companyId,
    documentId: row.documentId,
    documentVersion: row.documentVersion,
    sourceSha256: row.sourceSha256,
    analyzerVersion: row.analyzerVersion,
    analysisSchemaVersion: row.analysisSchemaVersion,
    analysis: row.analysis as unknown as DocumentAnalysis,
    analyzedAt: row.analyzedAt.toISOString(),
  });
}

export class InMemoryDocumentAnalysisStore implements DocumentAnalysisStore {
  private rows = new Map<string, DocumentAnalysisCacheRecord>();

  async findExact(key: DocumentAnalysisCacheKey): Promise<DocumentAnalysisCacheRecord | null> {
    const validKey = validateKey(key);
    const row = this.rows.get(cacheKey(validKey));
    return row ? cloneRecord(row) : null;
  }

  async putIfAbsent(record: DocumentAnalysisCacheWrite): Promise<DocumentAnalysisCacheRecord> {
    const candidate = validatedRecord(record);
    const key = cacheKey(candidate);
    const winner = this.rows.get(key);
    if (winner) return cloneRecord(winner);
    this.rows.set(key, cloneRecord(candidate));
    return cloneRecord(candidate);
  }

  snapshot(): Map<string, DocumentAnalysisCacheRecord> {
    return new Map([...this.rows].map(([key, record]) => [key, cloneRecord(record)]));
  }

  restore(snapshot: Map<string, DocumentAnalysisCacheRecord>): void {
    this.rows = new Map([...snapshot].map(([key, record]) => [key, cloneRecord(record)]));
  }
}

export class PrismaDocumentAnalysisStore implements DocumentAnalysisStore {
  constructor(private readonly prisma: PrismaService) {}

  async findExact(key: DocumentAnalysisCacheKey): Promise<DocumentAnalysisCacheRecord | null> {
    const validKey = validateKey(key);
    const row = await this.prisma.client().documentAnalysisCache.findUnique({
      where: { document_analysis_cache_key: validKey },
    });
    return row ? fromPrisma(row) : null;
  }

  async putIfAbsent(record: DocumentAnalysisCacheWrite): Promise<DocumentAnalysisCacheRecord> {
    const candidate = validatedRecord(record);
    // PostgreSQL traduit createMany(skipDuplicates) en INSERT ... ON CONFLICT DO NOTHING : deux
    // workers concurrents convergent vers la première ligne validée, sans UPDATE ni last-write-wins.
    await this.prisma.client().documentAnalysisCache.createMany({
      data: {
        companyId: candidate.companyId,
        documentId: candidate.documentId,
        documentVersion: candidate.documentVersion,
        sourceSha256: candidate.sourceSha256,
        analyzerVersion: candidate.analyzerVersion,
        analysisSchemaVersion: candidate.analysisSchemaVersion,
        analysis: candidate.analysis as unknown as Prisma.InputJsonValue,
        analyzedAt: new Date(candidate.analyzedAt),
      },
      skipDuplicates: true,
    });
    const winner = await this.prisma.client().documentAnalysisCache.findUnique({
      where: {
        document_analysis_cache_key: {
          companyId: candidate.companyId,
          documentId: candidate.documentId,
          documentVersion: candidate.documentVersion,
          sourceSha256: candidate.sourceSha256,
        },
      },
    });
    if (!winner) {
      throw new Error('Document analysis cache insert completed without a tenant-visible winner.');
    }
    return fromPrisma(winner);
  }
}
