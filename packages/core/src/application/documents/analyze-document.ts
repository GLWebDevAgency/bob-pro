import { makeDocumentAnalysis, type DocumentAnalysis } from '../../domain/document/document-analysis';
import { type Result, err } from '../../shared-kernel/result';
import { type DocumentIntelligencePort } from '../ports/document-intelligence';
import { type DocumentRepository } from '../ports/document-repository';
import { type DocumentStoragePort } from '../ports/document-storage';
import { type ClockPort } from '../ports/services';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';

export const DOCUMENT_INTELLIGENCE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/xml',
  'text/xml',
] as const;

/** Limite commune à l'archivage mobile/API et au rechargement d'un original historique. */
export const DOCUMENT_INTELLIGENCE_MAX_BYTES = 10 * 1024 * 1024;

export interface AnalyzeDocumentInput {
  companyId: string;
  documentId: string;
}

export interface AnalyzeDocumentDeps {
  documents: Pick<DocumentRepository, 'findById'>;
  storage: DocumentStoragePort;
  intelligence: DocumentIntelligencePort;
  clock: ClockPort;
}

function dependencyError(port: string, error: unknown): AppError {
  return { kind: 'dependency', port, cause: error instanceof Error ? error.message : String(error) };
}

function normalizedMimeType(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Analyse l'original déjà archivé, en lecture seule.
 *
 * Le use case ne persiste aucune dépense, écriture ou classification. Une future persistance
 * de l'analyse et toute confirmation de rangement restent des commandes séparées.
 */
export class AnalyzeDocument {
  constructor(private readonly deps: AnalyzeDocumentDeps) {}

  async execute(input: AnalyzeDocumentInput): Promise<Result<DocumentAnalysis, AppError>> {
    const companyId = input.companyId.trim();
    const documentId = input.documentId.trim();
    const issues: { field: string; message: string }[] = [];
    if (!companyId) issues.push({ field: 'companyId', message: 'Tenant requis.' });
    if (!documentId) issues.push({ field: 'documentId', message: 'Id document requis.' });
    if (issues.length > 0) return err({ kind: 'validation', issues });

    let document;
    try {
      document = await this.deps.documents.findById(companyId, documentId);
    } catch (error) {
      return err(dependencyError('document-repository', error));
    }
    if (!document) return err(appNotFound('document', documentId));
    if (document.status !== 'active') {
      return err(appConflict('document', 'Un document supprimé ne peut pas être analysé.'));
    }

    const props = document.toProps();
    const currentVersion = props.versions.reduce(
      (latest, version) => (version.version > latest.version ? version : latest),
      props.versions[0]!,
    );
    const mimeType = normalizedMimeType(currentVersion.mimeType);
    if (!DOCUMENT_INTELLIGENCE_MIME_TYPES.includes(mimeType as (typeof DOCUMENT_INTELLIGENCE_MIME_TYPES)[number])) {
      return err({
        kind: 'validation',
        issues: [{ field: 'mimeType', message: `Type non pris en charge par l'analyse documentaire : ${mimeType || 'inconnu'}.` }],
      });
    }
    if (currentVersion.byteSize > DOCUMENT_INTELLIGENCE_MAX_BYTES) {
      return err({
        kind: 'validation',
        issues: [{ field: 'document', message: 'Document trop volumineux pour l’analyse (10 Mo maximum).' }],
      });
    }

    let stored;
    try {
      stored = await this.deps.storage.get(companyId, currentVersion.storageKey);
    } catch (error) {
      return err(dependencyError('document-storage', error));
    }
    if (!stored) {
      return err(dependencyError('document-storage', 'Original archivé introuvable.'));
    }
    if (stored.bytes.byteLength === 0 || stored.bytes.byteLength !== currentVersion.byteSize) {
      return err(dependencyError('document-storage', 'Taille de l’original incohérente avec les métadonnées.'));
    }
    if (normalizedMimeType(stored.contentType) !== mimeType) {
      return err(dependencyError('document-storage', 'Type MIME de l’original incohérent avec les métadonnées.'));
    }

    let intelligenceResult;
    try {
      intelligenceResult = await this.deps.intelligence.analyzeDocument({
        documentId: document.id,
        documentVersion: currentVersion.version,
        sourceSha256: currentVersion.sha256,
        filename: props.filename,
        mimeType,
        // Isole l'original en mémoire d'un adapter qui muterait accidentellement son buffer.
        bytes: stored.bytes.slice(),
      });
    } catch (error) {
      return err(dependencyError('document-intelligence', error));
    }
    if (!intelligenceResult.ok) return intelligenceResult;

    const analysis = makeDocumentAnalysis(intelligenceResult.value.analysis, {
      documentId: document.id,
      documentVersion: currentVersion.version,
      sourceSha256: currentVersion.sha256,
      originalFilename: props.filename,
      analyzerVersion: intelligenceResult.value.analyzerVersion,
      analyzedAt: this.deps.clock.now(),
    });
    if (!analysis.ok) return err(appDomain(analysis.error));
    return analysis;
  }
}
