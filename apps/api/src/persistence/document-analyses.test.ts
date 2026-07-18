import { makeDocumentAnalysis, type DocumentAnalysis } from '@bob/core';
import { describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_ANALYSIS_SCHEMA_VERSION,
  InvalidDocumentAnalysisCacheRecordError,
  PrismaDocumentAnalysisStore,
  type DocumentAnalysisCacheRecord,
  type DocumentAnalysisCacheWrite,
} from './document-analyses';
import { InMemoryDocumentAnalysisStore } from './document-analyses.testing';
import type { PrismaService } from './prisma/prisma.service';

const SHA = 'a'.repeat(64);
const ANALYZED_AT = '2026-07-13T10:00:00.000Z';

function record(overrides: {
  companyId?: string;
  documentId?: string;
  documentVersion?: number;
  sourceSha256?: string;
  analyzerVersion?: string;
  summary?: string;
} = {}): DocumentAnalysisCacheRecord {
  const companyId = overrides.companyId ?? 'co-1';
  const documentId = overrides.documentId ?? 'doc-1';
  const documentVersion = overrides.documentVersion ?? 1;
  const sourceSha256 = overrides.sourceSha256 ?? SHA;
  const analyzerVersion = overrides.analyzerVersion ?? 'vision-v1';
  const analysis = makeDocumentAnalysis({
    type: 'receipt',
    typeConfidence: 0.96,
    summary: overrides.summary ?? 'Ticket fournisseur correctement identifié.',
    facts: [],
    suggestedTags: ['receipt'],
    suggestedFilename: 'ticket-fournisseur',
    warnings: [],
  }, {
    documentId,
    documentVersion,
    sourceSha256,
    originalFilename: 'ticket.jpg',
    analyzerVersion,
    analyzedAt: ANALYZED_AT,
  });
  if (!analysis.ok) throw new Error(`Invalid test fixture: ${analysis.error.code}`);
  return {
    companyId,
    documentId,
    documentVersion,
    sourceSha256,
    analyzerVersion,
    analysisSchemaVersion: DOCUMENT_ANALYSIS_SCHEMA_VERSION,
    analysis: analysis.value,
    analyzedAt: ANALYZED_AT,
  };
}

function prismaRow(value: DocumentAnalysisCacheRecord) {
  return {
    companyId: value.companyId,
    documentId: value.documentId,
    documentVersion: value.documentVersion,
    sourceSha256: value.sourceSha256,
    analyzerVersion: value.analyzerVersion,
    analysisSchemaVersion: value.analysisSchemaVersion,
    analysis: value.analysis,
    analyzedAt: new Date(value.analyzedAt),
  };
}

describe('InMemoryDocumentAnalysisStore', () => {
  it('conserve le premier résultat concurrent et renvoie le gagnant aux deux appelants', async () => {
    const store = new InMemoryDocumentAnalysisStore();
    const first = record({ analyzerVersion: 'vision-v1', summary: 'Premier résultat.' });
    const second = record({ analyzerVersion: 'vision-v2', summary: 'Résultat concurrent tardif.' });

    const [firstResult, secondResult] = await Promise.all([
      store.putIfAbsent(first),
      store.putIfAbsent(second),
    ]);

    expect(firstResult.analysis.summary).toBe('Premier résultat.');
    expect(secondResult.analysis.summary).toBe('Premier résultat.');
    expect(secondResult.analyzerVersion).toBe('vision-v1');
  });

  it('isole les clés par tenant et protège ses valeurs contre les mutations de l’appelant', async () => {
    const store = new InMemoryDocumentAnalysisStore();
    await store.putIfAbsent(record({ companyId: 'co-1', summary: 'Tenant A.' }));
    await store.putIfAbsent(record({ companyId: 'co-2', summary: 'Tenant B.' }));

    const tenantA = await store.findExact({
      companyId: 'co-1', documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA,
    });
    expect(tenantA?.analysis.summary).toBe('Tenant A.');
    (tenantA?.analysis.suggestedTags as string[] | undefined)?.push('mutation-externe');

    await expect(store.findExact({
      companyId: 'co-1', documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA,
    })).resolves.toMatchObject({ analysis: { suggestedTags: ['receipt'] } });
    await expect(store.findExact({
      companyId: 'co-2', documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA,
    })).resolves.toMatchObject({ analysis: { summary: 'Tenant B.' } });
  });

  it('rejette une analyse JSON incohérente avec sa clé', async () => {
    const store = new InMemoryDocumentAnalysisStore();
    const valid = record();
    const invalid = {
      ...valid,
      analysis: {
        ...valid.analysis,
        sourceSha256: 'b'.repeat(64),
      } as DocumentAnalysis,
    } satisfies DocumentAnalysisCacheRecord;

    await expect(store.putIfAbsent(invalid)).rejects.toBeInstanceOf(
      InvalidDocumentAnalysisCacheRecordError,
    );
  });

  it('fixe le schéma JSON à V2 et rejette explicitement toute autre version à l’écriture', async () => {
    const store = new InMemoryDocumentAnalysisStore();
    const candidate = record();
    const { analysisSchemaVersion: _, ...versionlessWrite } = candidate;

    await expect(store.putIfAbsent(versionlessWrite)).resolves.toMatchObject({
      analysisSchemaVersion: DOCUMENT_ANALYSIS_SCHEMA_VERSION,
    });
    await expect(store.putIfAbsent({
      ...candidate,
      analysisSchemaVersion: 1,
    } satisfies DocumentAnalysisCacheWrite)).rejects.toMatchObject({
      field: 'analysisSchemaVersion',
    });
  });

  it('revalide une destination chantier persistée contre elle-même (round-trip write/read)', async () => {
    const store = new InMemoryDocumentAnalysisStore();
    const analysis = makeDocumentAnalysis(
      {
        type: 'supplier_invoice',
        typeConfidence: 0.97,
        summary: 'Facture fournisseur Cedeo pour le chantier Durand.',
        facts: [],
        suggestedTags: ['cedeo'],
        suggestedFilename: 'facture-cedeo',
        suggestedDisplayName: 'Facture Cedeo — 120,00 €',
        suggestedDestination: {
          kind: 'chantier',
          chantierId: 'chantier-1',
          motif: 'Matériel pour le chantier Durand',
        },
        warnings: [],
      },
      {
        documentId: 'doc-1',
        documentVersion: 1,
        sourceSha256: SHA,
        originalFilename: 'facture.pdf',
        analyzerVersion: 'vision-v1',
        analyzedAt: ANALYZED_AT,
      },
      { chantiers: [{ id: 'chantier-1', nom: 'Rénovation Villa Durand' }] },
    );
    if (!analysis.ok) throw new Error('Invalid test fixture');

    await store.putIfAbsent({
      companyId: 'co-1',
      documentId: 'doc-1',
      documentVersion: 1,
      sourceSha256: SHA,
      analyzerVersion: 'vision-v1',
      analysis: analysis.value,
      analyzedAt: ANALYZED_AT,
    });
    await expect(store.findExact({
      companyId: 'co-1', documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA,
    })).resolves.toMatchObject({
      analysis: {
        suggestedDestination: {
          kind: 'chantier',
          chantierId: 'chantier-1',
          label: 'Rénovation Villa Durand',
        },
      },
    });
  });

  it('sert la lecture en lot pour l’enrichissement de liste (version + sha exacts)', async () => {
    const store = new InMemoryDocumentAnalysisStore();
    await store.putIfAbsent(record({ documentId: 'doc-1', summary: 'Analyse doc 1.' }));
    await store.putIfAbsent(record({ documentId: 'doc-2', summary: 'Analyse doc 2.' }));

    const records = await store.findManyExact('co-1', [
      { documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA },
      { documentId: 'doc-2', documentVersion: 2, sourceSha256: SHA }, // version obsolète ⇒ absent
      { documentId: 'doc-3', documentVersion: 1, sourceSha256: SHA }, // jamais analysé ⇒ absent
    ]);
    expect(records.map((entry) => entry.documentId)).toEqual(['doc-1']);
  });
});

describe('PrismaDocumentAnalysisStore', () => {
  it('fait un INSERT ON CONFLICT DO NOTHING puis retourne la ligne gagnante en base', async () => {
    const candidate = record({ analyzerVersion: 'vision-v2', summary: 'Candidat.' });
    const winner = record({ analyzerVersion: 'vision-v1', summary: 'Premier résultat.' });
    const documentAnalysisCache = {
      createMany: vi.fn(async () => ({ count: 0 })),
      findUnique: vi.fn(async () => prismaRow(winner)),
    };
    const store = new PrismaDocumentAnalysisStore({
      client: () => ({ documentAnalysisCache }),
    } as unknown as PrismaService);

    await expect(store.putIfAbsent(candidate)).resolves.toMatchObject({
      analyzerVersion: 'vision-v1',
      analysis: { summary: 'Premier résultat.' },
    });
    expect(documentAnalysisCache.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: expect.objectContaining({
        analyzerVersion: 'vision-v2',
        analysisSchemaVersion: DOCUMENT_ANALYSIS_SCHEMA_VERSION,
      }),
    }));
    expect(documentAnalysisCache.findUnique).toHaveBeenCalledWith({
      where: {
        document_analysis_cache_key: {
          companyId: 'co-1', documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA,
          analysisSchemaVersion: DOCUMENT_ANALYSIS_SCHEMA_VERSION,
        },
      },
    });
  });

  it('ne lit que le contrat courant en lot et saute les lignes corrompues sans casser la liste', async () => {
    const valid = record({ documentId: 'doc-1', summary: 'Analyse doc 1.' });
    const corrupted = prismaRow(record({ documentId: 'doc-2', summary: 'Analyse doc 2.' }));
    corrupted.analysis = { ...corrupted.analysis, analyzerVersion: 'tampered' } as DocumentAnalysis;
    const findMany = vi.fn(async () => [prismaRow(valid), corrupted]);
    const store = new PrismaDocumentAnalysisStore({
      client: () => ({ documentAnalysisCache: { findMany } }),
    } as unknown as PrismaService);

    const records = await store.findManyExact('co-1', [
      { documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA },
      { documentId: 'doc-2', documentVersion: 1, sourceSha256: SHA },
    ]);
    expect(records.map((entry) => entry.documentId)).toEqual(['doc-1']);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        companyId: 'co-1',
        analysisSchemaVersion: DOCUMENT_ANALYSIS_SCHEMA_VERSION,
        documentId: { in: ['doc-1', 'doc-2'] },
      },
    });
  });

  it('inclut le tenant dans chaque lookup exact et échoue fermé sur une ligne corrompue', async () => {
    const valid = record();
    const corrupted = prismaRow(valid);
    corrupted.analysis = { ...valid.analysis, analyzerVersion: 'tampered' };
    const findUnique = vi.fn()
      .mockResolvedValueOnce(prismaRow(valid))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(corrupted);
    const store = new PrismaDocumentAnalysisStore({
      client: () => ({ documentAnalysisCache: { findUnique } }),
    } as unknown as PrismaService);

    await expect(store.findExact({
      companyId: 'co-1', documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA,
    })).resolves.toMatchObject({ companyId: 'co-1' });
    await expect(store.findExact({
      companyId: 'co-2', documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA,
    })).resolves.toBeNull();
    await expect(store.findExact({
      companyId: 'co-1', documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA,
    })).rejects.toBeInstanceOf(InvalidDocumentAnalysisCacheRecordError);

    expect(findUnique).toHaveBeenNthCalledWith(2, {
      where: {
        document_analysis_cache_key: {
          companyId: 'co-2', documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA,
          analysisSchemaVersion: DOCUMENT_ANALYSIS_SCHEMA_VERSION,
        },
      },
    });
  });

  it('échoue fermé à la lecture d’une ligne utilisant un schéma JSON inconnu', async () => {
    const unsupported = {
      ...prismaRow(record()),
      analysisSchemaVersion: 3,
    };
    const store = new PrismaDocumentAnalysisStore({
      client: () => ({
        documentAnalysisCache: { findUnique: vi.fn(async () => unsupported) },
      }),
    } as unknown as PrismaService);

    await expect(store.findExact({
      companyId: 'co-1', documentId: 'doc-1', documentVersion: 1, sourceSha256: SHA,
    })).rejects.toMatchObject({ field: 'analysisSchemaVersion' });
  });
});
