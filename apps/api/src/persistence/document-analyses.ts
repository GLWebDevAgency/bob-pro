import { isDeepStrictEqual } from 'node:util';
import {
  makeDocumentAnalysis,
  type DocumentAnalysis,
  type DocumentAnalysisDraft,
  type DocumentDestinationContext,
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
 * V2 (2026-07-18) : + suggestedDisplayName, + suggestedDestination. La version fait partie de la
 * clé primaire : bumper PUBLIE de nouvelles lignes (les V1 historiques deviennent invisibles au
 * store — invalidation de cache sans UPDATE ni DELETE, append-only préservé).
 */
export const DOCUMENT_ANALYSIS_SCHEMA_VERSION = 2 as const;

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
  /**
   * Lecture EN LOT pour l'enrichissement de GET /documents (jamais de N+1, jamais d'appel LLM).
   * Ne retourne que les lignes du contrat courant qui revalident ; une ligne corrompue est
   * simplement absente du résumé — elle ne fait jamais tomber la liste du coffre.
   */
  findManyExact(
    companyId: string,
    keys: readonly Omit<DocumentAnalysisCacheKey, 'companyId'>[],
  ): Promise<DocumentAnalysisCacheRecord[]>;
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

/** @internal Partagé avec le store déterministe situé dans `*.testing.ts`. */
export function validateDocumentAnalysisCacheKey(
  key: DocumentAnalysisCacheKey,
): DocumentAnalysisCacheKey {
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

/**
 * Reconstruit le contexte de validation de destination À PARTIR de la valeur persistée.
 *
 * À la relecture, le cache ne connaît plus les chantiers du tenant : l'anti-hallucination a déjà
 * eu lieu à l'écriture (AnalyzeDocument valide contre le contexte réel). La seule exigence ici est
 * le DÉTERMINISME du round-trip :
 * - suggestion chantier persistée → revalidée contre elle-même (id + label stockés) ;
 * - null explicite → reproduit en interdisant le fallback par type (systemKeys vides) ;
 * - dossier système → clés produit par défaut.
 * Même logique côté client dans packages/api-client/src/document-codecs.ts (decodeDocumentAnalysis).
 */
function destinationRevalidationContext(analysis: Record<string, unknown>): DocumentDestinationContext {
  const destination = analysis.suggestedDestination;
  if (destination === null) return { chantiers: [], systemKeys: [] };
  if (typeof destination === 'object' && destination !== null && Reflect.get(destination, 'kind') === 'chantier') {
    const chantierId = Reflect.get(destination, 'chantierId');
    const label = Reflect.get(destination, 'label');
    return {
      chantiers:
        typeof chantierId === 'string' && typeof label === 'string'
          ? [{ id: chantierId, nom: label }]
          : [],
    };
  }
  return { chantiers: [] };
}

/** @internal Partagé avec le store déterministe situé dans `*.testing.ts`. */
export function validateDocumentAnalysisCacheRecord(
  record: DocumentAnalysisCacheWrite,
): DocumentAnalysisCacheRecord {
  const key = validateDocumentAnalysisCacheKey(record);
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

  const analysis = makeDocumentAnalysis(
    record.analysis as unknown as DocumentAnalysisDraft,
    {
      documentId: key.documentId,
      documentVersion: key.documentVersion,
      sourceSha256: key.sourceSha256,
      originalFilename:
        typeof record.analysis.suggestedFilename === 'string'
          ? record.analysis.suggestedFilename
          : 'document',
      analyzerVersion,
      analyzedAt,
    },
    destinationRevalidationContext(record.analysis as unknown as Record<string, unknown>),
  );
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

function fromPrisma(row: PrismaDocumentAnalysisCache): DocumentAnalysisCacheRecord {
  return validateDocumentAnalysisCacheRecord({
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

export class PrismaDocumentAnalysisStore implements DocumentAnalysisStore {
  constructor(private readonly prisma: PrismaService) {}

  async findExact(key: DocumentAnalysisCacheKey): Promise<DocumentAnalysisCacheRecord | null> {
    const validKey = validateDocumentAnalysisCacheKey(key);
    const row = await this.prisma.client().documentAnalysisCache.findUnique({
      // Version de contrat dans la clé : une ligne V1 historique est un MISS (invalidation).
      where: {
        document_analysis_cache_key: {
          ...validKey,
          analysisSchemaVersion: DOCUMENT_ANALYSIS_SCHEMA_VERSION,
        },
      },
    });
    return row ? fromPrisma(row) : null;
  }

  async findManyExact(
    companyId: string,
    keys: readonly Omit<DocumentAnalysisCacheKey, 'companyId'>[],
  ): Promise<DocumentAnalysisCacheRecord[]> {
    if (keys.length === 0) return [];
    const validKeys = keys.map((key) => validateDocumentAnalysisCacheKey({ companyId, ...key }));
    // Une seule requête pour toute la liste (peu de versions par document) ; l'appariement exact
    // version+sha se fait en mémoire pour éviter un OR combinatoire côté SQL.
    const rows = await this.prisma.client().documentAnalysisCache.findMany({
      where: {
        companyId,
        analysisSchemaVersion: DOCUMENT_ANALYSIS_SCHEMA_VERSION,
        documentId: { in: [...new Set(validKeys.map((key) => key.documentId))] },
      },
    });
    const wanted = new Set(
      validKeys.map((key) => `${key.documentId}#${key.documentVersion}#${key.sourceSha256}`),
    );
    const records: DocumentAnalysisCacheRecord[] = [];
    for (const row of rows) {
      if (!wanted.has(`${row.documentId}#${row.documentVersion}#${row.sourceSha256}`)) continue;
      try {
        records.push(fromPrisma(row));
      } catch (cause) {
        // Ligne corrompue : absente du résumé de liste, jamais un crash du coffre. Les chemins
        // unitaires (findExact) continuent, eux, d'échouer explicitement.
        if (!(cause instanceof InvalidDocumentAnalysisCacheRecordError)) throw cause;
      }
    }
    return records;
  }

  async putIfAbsent(record: DocumentAnalysisCacheWrite): Promise<DocumentAnalysisCacheRecord> {
    const candidate = validateDocumentAnalysisCacheRecord(record);
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
          analysisSchemaVersion: candidate.analysisSchemaVersion,
        },
      },
    });
    if (!winner) {
      throw new Error('Document analysis cache insert completed without a tenant-visible winner.');
    }
    return fromPrisma(winner);
  }
}
