import { describe, expect, it } from 'vitest';
import { Document } from '../../domain/document/document';
import { type DocumentAnalysisDraft } from '../../domain/document/document-analysis';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type DocumentIntelligenceInput, type DocumentIntelligenceOutput, type DocumentIntelligencePort } from '../ports/document-intelligence';
import { type DocumentRepository } from '../ports/document-repository';
import { type DocumentStoragePort, type StoredObject } from '../ports/document-storage';
import { type ClockPort } from '../ports/services';
import { type AppError } from '../result';
import { AnalyzeDocument, DOCUMENT_INTELLIGENCE_MAX_BYTES } from './analyze-document';

const CURRENT_BYTES = new Uint8Array([37, 80, 68, 70]);
const CURRENT_SHA = 'b'.repeat(64);
const PREVIOUS_SHA = 'a'.repeat(64);
const CURRENT_KEY = `companies/co-1/documents/doc-1/2-${CURRENT_SHA}.pdf`;

const clock: ClockPort = {
  now: () => '2026-07-13T15:00:00.000Z',
  today: () => '2026-07-13',
};

function makeDocument(input?: { status?: 'active' | 'deleted'; mimeType?: string; byteSize?: number }): Document {
  const status = input?.status ?? 'active';
  const mimeType = input?.mimeType ?? 'application/pdf';
  const byteSize = input?.byteSize ?? CURRENT_BYTES.byteLength;
  const result = Document.record({
    id: 'doc-1',
    companyId: 'co-1',
    kind: 'other',
    origin: 'uploaded',
    status,
    filename: 'releve-juillet.pdf',
    mimeType,
    byteSize,
    sha256: CURRENT_SHA,
    storageKey: CURRENT_KEY,
    folderId: null,
    linkedEntityType: null,
    linkedEntityId: null,
    documentDate: null,
    issuedAt: null,
    createdAt: '2026-07-13T14:00:00.000Z',
    createdBy: 'user-1',
    retentionUntil: '2036-07-13',
    deletedAt: status === 'deleted' ? '2026-07-13T14:30:00.000Z' : null,
    tags: [],
    versions: [
      {
        id: 'version-1',
        documentId: 'doc-1',
        version: 1,
        storageKey: `companies/co-1/documents/doc-1/1-${PREVIOUS_SHA}.pdf`,
        sha256: PREVIOUS_SHA,
        mimeType,
        byteSize: 3,
        createdAt: '2026-07-13T13:00:00.000Z',
        reason: 'initial',
      },
      {
        id: 'version-2',
        documentId: 'doc-1',
        version: 2,
        storageKey: CURRENT_KEY,
        sha256: CURRENT_SHA,
        mimeType,
        byteSize,
        createdAt: '2026-07-13T14:00:00.000Z',
        reason: 'nouveau scan',
      },
    ],
  } as Parameters<typeof Document.record>[0]);
  if (!result.ok) throw new Error(`Fixture Document invalide : ${JSON.stringify(result.error)}`);
  return result.value;
}

class MemoryDocuments implements DocumentRepository {
  saveCount = 0;
  constructor(private readonly document: Document | null) {}

  async save(): Promise<void> {
    this.saveCount += 1;
  }

  async classify(): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    return 'not_found';
  }
  async markReviewed(): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    return 'not_found';
  }

  async rename(): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    return 'not_found';
  }

  async findById(companyId: string, id: string): Promise<Document | null> {
    if (!this.document || this.document.companyId !== companyId || this.document.id !== id) return null;
    return this.document;
  }

  async findByEntity(): Promise<Document[]> {
    return [];
  }

  async listByCompany(): Promise<Document[]> {
    return [];
  }

  async listExpired(): Promise<Document[]> {
    return [];
  }
}

class MemoryStorage implements DocumentStoragePort {
  getCount = 0;
  object: { bytes: Uint8Array; contentType: string } | null = {
    bytes: CURRENT_BYTES,
    contentType: 'application/pdf; charset=binary',
  };
  throws: Error | null = null;

  async put(): Promise<StoredObject> {
    throw new Error('non utilisé');
  }

  async get(companyId: string, key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    this.getCount += 1;
    if (this.throws) throw this.throws;
    if (companyId !== 'co-1' || key !== CURRENT_KEY) return null;
    return this.object;
  }

  async getSignedUrl(): Promise<string> {
    throw new Error('non utilisé');
  }

  async stat(): Promise<{ sizeBytes: number; contentType: string } | null> {
    return null;
  }

  async remove(): Promise<void> {}
}

function validDraft(): DocumentAnalysisDraft {
  return {
    type: 'bank_statement',
    typeConfidence: 0.94,
    summary: 'Relevé bancaire de juillet 2026.',
    facts: [
      {
        key: 'period_end',
        valueType: 'date',
        value: '2026-07-31',
        confidence: 0.9,
        provenance: { source: 'document_text', evidence: [{ page: 1, excerpt: '31/07/2026' }] },
      },
    ],
    suggestedTags: ['banque', 'juillet-2026'],
    suggestedFilename: '2026-07-releve-bancaire',
  };
}

class StubIntelligence implements DocumentIntelligencePort {
  calls: DocumentIntelligenceInput[] = [];
  throws: Error | null = null;
  output: Result<DocumentIntelligenceOutput, AppError> = ok({
    analyzerVersion: 'generic-doc-v1',
    analysis: validDraft(),
  });

  async analyzeDocument(input: DocumentIntelligenceInput): Promise<Result<DocumentIntelligenceOutput, AppError>> {
    this.calls.push(input);
    if (this.throws) throw this.throws;
    return this.output;
  }
}

function setup(document: Document | null = makeDocument()) {
  const documents = new MemoryDocuments(document);
  const storage = new MemoryStorage();
  const intelligence = new StubIntelligence();
  const useCase = new AnalyzeDocument({ documents, storage, intelligence, clock });
  return { documents, storage, intelligence, useCase };
}

describe('AnalyzeDocument', () => {
  it('recharge la version courante côté serveur et rend une analyse validée, sans mutation', async () => {
    const { documents, intelligence, useCase } = setup();

    const result = await useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      documentId: 'doc-1',
      documentVersion: 2,
      sourceSha256: CURRENT_SHA,
      type: 'bank_statement',
      suggestedSystemFolder: 'bank',
      analyzerVersion: 'generic-doc-v1',
      analyzedAt: '2026-07-13T15:00:00.000Z',
    });
    expect(intelligence.calls).toHaveLength(1);
    expect(intelligence.calls[0]).toMatchObject({
      documentId: 'doc-1',
      documentVersion: 2,
      sourceSha256: CURRENT_SHA,
      filename: 'releve-juillet.pdf',
      mimeType: 'application/pdf',
    });
    expect(intelligence.calls[0]?.bytes).toEqual(CURRENT_BYTES);
    expect(intelligence.calls[0]?.bytes).not.toBe(CURRENT_BYTES);
    expect(documents.saveCount).toBe(0);
  });

  it('respecte le tenant : un document hors tenant reste introuvable et aucun octet ne part au moteur', async () => {
    const { intelligence, useCase } = setup();

    const result = await useCase.execute({ companyId: 'co-2', documentId: 'doc-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    expect(intelligence.calls).toHaveLength(0);
  });

  it('refuse un document supprimé ou un type MIME non supporté avant de charger les octets', async () => {
    const deleted = setup(makeDocument({ status: 'deleted' }));
    const deletedResult = await deleted.useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });
    expect(deletedResult.ok).toBe(false);
    if (!deletedResult.ok) expect(deletedResult.error.kind).toBe('conflict');
    expect(deleted.intelligence.calls).toHaveLength(0);

    const unsupported = setup(makeDocument({ mimeType: 'text/plain' }));
    const unsupportedResult = await unsupported.useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });
    expect(unsupportedResult.ok).toBe(false);
    if (!unsupportedResult.ok) expect(unsupportedResult.error.kind).toBe('validation');
    expect(unsupported.intelligence.calls).toHaveLength(0);
  });

  it('autorise un XML professionnel archivé et transmet ses octets au moteur générique', async () => {
    const xml = setup(makeDocument({ mimeType: 'application/xml' }));
    xml.storage.object = { bytes: CURRENT_BYTES, contentType: 'application/xml; charset=utf-8' };

    const result = await xml.useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });

    expect(result.ok).toBe(true);
    expect(xml.intelligence.calls).toHaveLength(1);
    expect(xml.intelligence.calls[0]).toMatchObject({ mimeType: 'application/xml' });
  });

  it('refuse les originaux historiques trop volumineux avant de les charger en mémoire', async () => {
    const oversized = setup(makeDocument({ byteSize: DOCUMENT_INTELLIGENCE_MAX_BYTES + 1 }));

    const result = await oversized.useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        kind: 'validation',
        issues: [{ field: 'document' }],
      });
    }
    expect(oversized.storage.getCount).toBe(0);
    expect(oversized.intelligence.calls).toHaveLength(0);
  });

  it('échoue fermé si l’original manque, est tronqué ou porte un autre type MIME', async () => {
    const missing = setup();
    missing.storage.object = null;
    const missingResult = await missing.useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.error).toMatchObject({ kind: 'dependency', port: 'document-storage' });

    const truncated = setup();
    truncated.storage.object = { bytes: new Uint8Array([1]), contentType: 'application/pdf' };
    const truncatedResult = await truncated.useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });
    expect(truncatedResult.ok).toBe(false);
    if (!truncatedResult.ok) expect(truncatedResult.error.kind).toBe('dependency');

    const wrongMime = setup();
    wrongMime.storage.object = { bytes: CURRENT_BYTES, contentType: 'image/jpeg' };
    const wrongMimeResult = await wrongMime.useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });
    expect(wrongMimeResult.ok).toBe(false);
    if (!wrongMimeResult.ok) expect(wrongMimeResult.error.kind).toBe('dependency');
  });

  it('convertit les exceptions des ports en erreurs de dépendance explicites', async () => {
    const storageFailure = setup();
    storageFailure.storage.throws = new Error('coffre indisponible');
    const stored = await storageFailure.useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });
    expect(stored.ok).toBe(false);
    if (!stored.ok) expect(stored.error).toMatchObject({ kind: 'dependency', port: 'document-storage', cause: 'coffre indisponible' });

    const aiFailure = setup();
    aiFailure.intelligence.throws = new Error('vision indisponible');
    const analyzed = await aiFailure.useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });
    expect(analyzed.ok).toBe(false);
    if (!analyzed.ok) expect(analyzed.error).toMatchObject({ kind: 'dependency', port: 'document-intelligence', cause: 'vision indisponible' });
  });

  it('propage une erreur contrôlée du moteur et revalide toujours sa sortie', async () => {
    const controlled = setup();
    controlled.intelligence.output = err({ kind: 'dependency', port: 'vision-provider', cause: 'quota' });
    const controlledResult = await controlled.useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });
    expect(controlledResult.ok).toBe(false);
    if (!controlledResult.ok) expect(controlledResult.error).toMatchObject({ kind: 'dependency', port: 'vision-provider' });

    const malformed = setup();
    malformed.intelligence.output = ok({
      analyzerVersion: 'generic-doc-v1',
      analysis: { ...validDraft(), type: 'hallucinated_type' },
    });
    const malformedResult = await malformed.useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });
    expect(malformedResult.ok).toBe(false);
    if (!malformedResult.ok) expect(malformedResult.error.kind).toBe('domain');
  });

  it('rejette des identifiants vides sans appeler les ports', async () => {
    const { intelligence, useCase } = setup();
    const result = await useCase.execute({ companyId: ' ', documentId: '' });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'validation') expect(result.error.issues).toHaveLength(2);
    expect(intelligence.calls).toHaveLength(0);
  });

  it('transmet le contexte de classement au moteur et valide la destination au retour', async () => {
    const { intelligence, useCase } = setup();
    intelligence.output = ok({
      analyzerVersion: 'generic-doc-v1',
      analysis: {
        ...validDraft(),
        type: 'supplier_invoice',
        suggestedDestination: { kind: 'chantier', chantierId: 'ch-durand', motif: 'matériel chantier Durand' },
      },
    });

    const result = await useCase.execute({
      companyId: 'co-1',
      documentId: 'doc-1',
      context: {
        chantiersOuverts: [{ id: 'ch-durand', nom: 'Rénovation Durand', clientNom: 'Mme Durand' }],
        dossiers: [
          { id: 'f-achats', nom: 'Achats', systemKey: 'purchases' },
          { id: 'f-perso', nom: 'Mes contrats', systemKey: null },
        ],
      },
    });

    expect(intelligence.calls[0]?.classificationContext).toEqual({
      chantiersOuverts: [{ id: 'ch-durand', nom: 'Rénovation Durand', clientNom: 'Mme Durand' }],
      dossiers: [
        { id: 'f-achats', nom: 'Achats', systemKey: 'purchases' },
        { id: 'f-perso', nom: 'Mes contrats', systemKey: null },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedDestination).toEqual({
      kind: 'chantier',
      chantierId: 'ch-durand',
      label: 'Rénovation Durand',
      motif: 'matériel chantier Durand',
    });
  });

  it('rejette un chantier hors contexte au retour et retombe sur le dossier système du type', async () => {
    const { intelligence, useCase } = setup();
    intelligence.output = ok({
      analyzerVersion: 'generic-doc-v1',
      analysis: {
        ...validDraft(),
        type: 'supplier_invoice',
        suggestedDestination: { kind: 'chantier', chantierId: 'ch-hallucine' },
      },
    });

    const result = await useCase.execute({
      companyId: 'co-1',
      documentId: 'doc-1',
      context: {
        chantiersOuverts: [{ id: 'ch-durand', nom: 'Rénovation Durand' }],
        dossiers: [{ id: 'f-achats', nom: 'Achats', systemKey: 'purchases' }],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedDestination).toMatchObject({ kind: 'system_folder', systemKey: 'purchases' });
  });

  it('compat ascendante : sans contexte, aucun contexte ne part au moteur et le fallback par type s’applique', async () => {
    const { intelligence, useCase } = setup();

    const result = await useCase.execute({ companyId: 'co-1', documentId: 'doc-1' });

    expect(intelligence.calls[0]?.classificationContext).toBeUndefined();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedDestination).toMatchObject({ kind: 'system_folder', systemKey: 'bank', label: 'Banque' });
    expect(result.value.suggestedDisplayName).toBe('2026 07 releve bancaire');
  });
});
