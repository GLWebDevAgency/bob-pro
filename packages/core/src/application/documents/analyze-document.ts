import { makeDocumentAnalysis, type DocumentAnalysis } from '../../domain/document/document-analysis';
import { type DocumentDestinationContext } from '../../domain/document/document-destination';
import { type DocumentFolderSystemKey } from '../../domain/document/document-folder';
import { type Result, err } from '../../shared-kernel/result';
import { type DocumentClassificationContext, type DocumentIntelligencePort } from '../ports/document-intelligence';
import { type DocumentRepository } from '../ports/document-repository';
import { type DocumentStoragePort } from '../ports/document-storage';
import { type ClockPort } from '../ports/services';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { loadVerifiedStoredObject, normalizeDocumentContentType } from './verified-stored-object';

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
  /**
   * Contexte de classement tenant-aware (chantiers ouverts + dossiers du coffre), transmis au
   * moteur puis utilisé pour VALIDER la destination suggérée au retour. Optionnel — compat :
   * absent, comportement actuel + fallback déterministe par type.
   */
  context?: DocumentClassificationContext;
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

/**
 * Projette le contexte applicatif (port) vers le contexte de validation du domaine :
 * seuls les chantiers listés existent, et les clés système autorisées sont celles des
 * dossiers système réellement présents (liste vide ⇒ défaut produit : toutes les clés).
 */
function toDestinationContext(context: DocumentClassificationContext | undefined): DocumentDestinationContext | undefined {
  if (!context) return undefined;
  const systemKeys = [
    ...new Set(
      context.dossiers
        .map((dossier) => dossier.systemKey)
        .filter((key): key is DocumentFolderSystemKey => key !== null && key !== undefined),
    ),
  ];
  return {
    chantiers: context.chantiersOuverts.map(({ id, nom }) => ({ id, nom })),
    ...(systemKeys.length > 0 ? { systemKeys } : {}),
  };
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
    const mimeType = normalizeDocumentContentType(currentVersion.mimeType);
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

    const stored = await loadVerifiedStoredObject(this.deps.storage, {
      companyId,
      key: currentVersion.storageKey,
      sizeBytes: currentVersion.byteSize,
      sha256: currentVersion.sha256,
      contentType: mimeType,
    });
    if (!stored.ok) return stored;

    let intelligenceResult;
    try {
      intelligenceResult = await this.deps.intelligence.analyzeDocument({
        documentId: document.id,
        documentVersion: currentVersion.version,
        sourceSha256: currentVersion.sha256,
        filename: props.filename,
        mimeType,
        // Isole l'original en mémoire d'un adapter qui muterait accidentellement son buffer.
        bytes: stored.value.bytes.slice(),
        ...(input.context !== undefined ? { classificationContext: input.context } : {}),
      });
    } catch (error) {
      return err(dependencyError('document-intelligence', error));
    }
    if (!intelligenceResult.ok) return intelligenceResult;

    // La suggestion de destination du moteur est REVALIDÉE ici contre le contexte tenant :
    // un chantierId hors contexte est rejeté et retombe sur le dossier système déterministe.
    const analysis = makeDocumentAnalysis(
      intelligenceResult.value.analysis,
      {
        documentId: document.id,
        documentVersion: currentVersion.version,
        sourceSha256: currentVersion.sha256,
        originalFilename: props.filename,
        analyzerVersion: intelligenceResult.value.analyzerVersion,
        analyzedAt: this.deps.clock.now(),
      },
      toDestinationContext(input.context),
    );
    if (!analysis.ok) return err(appDomain(analysis.error));
    return analysis;
  }
}
