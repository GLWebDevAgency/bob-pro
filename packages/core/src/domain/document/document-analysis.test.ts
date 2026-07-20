import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_ANALYSIS_TYPES,
  fallbackDocumentDestinationFor,
  makeDocumentAnalysis,
  suggestedSystemFolderFor,
  type DocumentAnalysisDraft,
  type MakeDocumentAnalysisContext,
} from './document-analysis';
import { type DocumentDestinationContext } from './document-destination';

const context: MakeDocumentAnalysisContext = {
  documentId: 'doc-1',
  documentVersion: 2,
  sourceSha256: 'a'.repeat(64),
  originalFilename: 'scan-2026-07.pdf',
  analyzerVersion: 'generic-doc-v1',
  analyzedAt: '2026-07-13T14:00:00.000Z',
};

function bankDraft(): DocumentAnalysisDraft {
  return {
    type: 'bank_statement',
    typeConfidence: 0.96,
    summary: '  Relevé du compte FR7630006000011234567890189\n pour juillet 2026.  ',
    facts: [
      {
        key: 'bank_name',
        valueType: 'text',
        value: 'Banque Exemple',
        confidence: 0.95,
        provenance: {
          source: 'document_text',
          evidence: [{ page: 1, excerpt: 'BANQUE EXEMPLE', boundingBox: { x: 0.1, y: 0.1, width: 0.4, height: 0.08 } }],
        },
      },
      {
        key: 'period_start',
        valueType: 'date',
        value: '2026-07-01',
        confidence: 0.92,
        provenance: { source: 'document_text', evidence: [{ page: 1, excerpt: 'du 01/07/2026' }] },
      },
      {
        key: 'period_end',
        valueType: 'date',
        value: '2026-07-31',
        confidence: 0.9,
        provenance: { source: 'document_text', evidence: [{ page: 1, excerpt: 'au 31/07/2026' }] },
      },
      {
        key: 'account_balance',
        valueType: 'money',
        value: { amountMinor: -12_345, currency: 'eur' },
        confidence: 0.93,
        provenance: { source: 'document_text', evidence: [{ page: 2, excerpt: 'Solde -123,45 EUR' }] },
      },
      {
        key: 'fiscal_period',
        valueType: 'text',
        value: 'Juillet 2026',
        confidence: 0.99,
        provenance: {
          source: 'derived',
          derivedFrom: ['period_start', 'period_end'],
          rule: 'libellé de période à partir des dates',
        },
      },
    ],
    suggestedTags: ['Relevé bancaire', 'juillet 2026', '../dangereux', 42],
    suggestedFilename: '../../Relevé Juillet 2026.PDF',
  };
}

describe('makeDocumentAnalysis', () => {
  it('normalise une analyse générique, ses preuves et sa suggestion de dossier', () => {
    const result = makeDocumentAnalysis(bankDraft(), context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      documentId: 'doc-1',
      documentVersion: 2,
      type: 'bank_statement',
      typeConfidence: 0.96,
      suggestedSystemFolder: 'bank',
      suggestedFilename: 'releve-juillet-2026',
      requiresHumanReview: false,
      analyzerVersion: 'generic-doc-v1',
    });
    expect(result.value.summary).toBe('Relevé du compte FR76••••0189 pour juillet 2026.');
    expect(result.value.suggestedTags).toEqual(['releve-bancaire', 'juillet-2026', 'dangereux']);
    expect(result.value.facts).toHaveLength(5);
    expect(result.value.facts.find((fact) => fact.key === 'account_balance')).toMatchObject({
      valueType: 'money',
      value: { amountMinor: -12_345, currency: 'EUR' },
    });
    // Un fait dérivé ne peut pas être plus certain que ses deux faits sources.
    expect(result.value.facts.find((fact) => fact.key === 'fiscal_period')?.confidence).toBe(0.9);
  });

  it('couvre la taxonomie et ne laisse jamais le modèle inventer un dossier système', () => {
    const expected = {
      supplier_invoice: 'purchases',
      receipt: 'purchases',
      bank_statement: 'bank',
      insurance_certificate: 'insurance',
      tax_or_social_document: 'tax_social',
      contract: null,
      company_record: null,
      chantier_photo: 'projects',
      accounting_document: 'accounting',
      other: null,
    } as const;

    for (const type of DOCUMENT_ANALYSIS_TYPES) expect(suggestedSystemFolderFor(type)).toBe(expected[type]);
  });

  it('écarte les faits invalides et plafonne à 0,4 un fait non localisable', () => {
    const result = makeDocumentAnalysis(
      {
        type: 'supplier_invoice',
        typeConfidence: 1.7,
        summary: 'Facture fournisseur à confirmer.',
        facts: [
          {
            key: 'supplier_name',
            valueType: 'text',
            value: 'Premier candidat',
            confidence: 0.2,
            provenance: { source: 'document_text', evidence: [{ page: 1, excerpt: 'Premier candidat' }] },
          },
          {
            key: 'supplier_name',
            valueType: 'text',
            value: 'Candidat retenu',
            confidence: 0.98,
            provenance: { source: 'document_text', evidence: [] },
          },
          {
            key: 'document_date',
            valueType: 'date',
            value: '2026-02-30',
            confidence: 1,
            provenance: { source: 'document_text', evidence: [{ page: 1, excerpt: '30/02/2026' }] },
          },
          {
            key: 'total_ttc',
            valueType: 'money',
            value: { amountMinor: 10.5, currency: 'EUR' },
            confidence: 1,
            provenance: { source: 'document_text', evidence: [{ page: 1, excerpt: '10,50 EUR' }] },
          },
          {
            key: 'vat_rate',
            valueType: 'percentage',
            value: 20,
            confidence: 0.9,
            provenance: { source: 'derived', derivedFrom: ['total_ht'], rule: 'TVA / HT' },
          },
          {
            key: 'siren',
            valueType: 'text',
            value: 'pas-un-siren',
            confidence: 1,
            provenance: { source: 'document_text', evidence: [{ page: 1, excerpt: 'pas-un-siren' }] },
          },
        ],
      },
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.typeConfidence).toBe(1);
    expect(result.value.facts).toHaveLength(1);
    expect(result.value.facts[0]).toMatchObject({ key: 'supplier_name', value: 'Candidat retenu', confidence: 0.4 });
    expect(result.value.requiresHumanReview).toBe(true);
  });

  it('masque aussi un IBAN exposé dans un fait et assainit les avertissements', () => {
    const result = makeDocumentAnalysis(
      {
        type: 'bank_statement',
        typeConfidence: 0.8,
        summary: 'Relevé bancaire.',
        facts: [
          {
            key: 'iban_masked',
            valueType: 'text',
            value: 'FR7630006000011234567890189',
            confidence: 0.8,
            provenance: { source: 'document_text', evidence: [{ page: 1, excerpt: 'FR7630006000011234567890189' }] },
          },
        ],
        warnings: ['  Vérifier\nle titulaire  ', '  Vérifier\nle titulaire  ', '<script>reste une donnée</script>'],
      },
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.facts[0]).toMatchObject({ value: 'FR76••••0189' });
    expect(result.value.facts[0]?.provenance.evidence[0]?.excerpt).toBe('FR76••••0189');
    expect(result.value.warnings).toEqual(['Vérifier le titulaire', '<script>reste une donnée</script>']);
    expect(result.value.requiresHumanReview).toBe(true);
  });

  it('rejette un type, un résumé ou un contexte structurel invalide', () => {
    expect(makeDocumentAnalysis({ ...bankDraft(), type: 'invented' }, context).ok).toBe(false);
    expect(makeDocumentAnalysis({ ...bankDraft(), summary: '   ' }, context).ok).toBe(false);
    expect(makeDocumentAnalysis(bankDraft(), { ...context, sourceSha256: 'not-a-sha' }).ok).toBe(false);
    expect(makeDocumentAnalysis(bankDraft(), { ...context, documentVersion: 0 }).ok).toBe(false);
  });

  it('retombe sur un nom et un tag sûrs sans reprendre une traversée de chemin', () => {
    const result = makeDocumentAnalysis(
      {
        type: 'other',
        typeConfidence: Number.NaN,
        summary: 'Document non reconnu.',
        suggestedTags: [],
        suggestedFilename: '..',
      },
      { ...context, originalFilename: '../../Pièce Société.jpeg' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedFilename).toBe('piece-societe');
    expect(result.value.suggestedTags).toEqual(['other']);
    expect(result.value.typeConfidence).toBe(0);
    expect(result.value.suggestedSystemFolder).toBeNull();
    expect(result.value.requiresHumanReview).toBe(true);
  });
});

describe('makeDocumentAnalysis — libellé d’affichage suggéré', () => {
  it('assainit la proposition du modèle (espaces, bornage)', () => {
    const result = makeDocumentAnalysis(
      { ...bankDraft(), suggestedDisplayName: '  Relevé   bancaire — juillet 2026 ' },
      context,
    );
    expect(result.ok && result.value.suggestedDisplayName).toBe('Relevé bancaire — juillet 2026');
  });

  it('retombe sur une humanisation du nom canonique quand la proposition est inutilisable', () => {
    const result = makeDocumentAnalysis({ ...bankDraft(), suggestedDisplayName: ' x ' }, context);
    expect(result.ok && result.value.suggestedDisplayName).toBe('Releve juillet 2026');
  });
});

describe('makeDocumentAnalysis — destination validée (tenant-aware, anti-hallucination)', () => {
  const destinationContext: DocumentDestinationContext = {
    chantiers: [{ id: 'ch-durand', nom: 'Rénovation Durand' }],
  };

  function invoiceDraft(over: Partial<DocumentAnalysisDraft> = {}): DocumentAnalysisDraft {
    return {
      type: 'supplier_invoice',
      typeConfidence: 0.9,
      summary: 'Facture fournisseur Leroy Merlin.',
      facts: bankDraft().facts ?? [],
      ...over,
    };
  }

  it('accepte un chantier du contexte : suggestion prête à afficher, hors chantier possible aussi', () => {
    const result = makeDocumentAnalysis(
      invoiceDraft({
        suggestedDestination: { kind: 'chantier', chantierId: 'ch-durand', motif: 'matériel pour le chantier Durand' },
      }),
      context,
      destinationContext,
    );
    expect(result.ok && result.value.suggestedDestination).toEqual({
      kind: 'chantier',
      chantierId: 'ch-durand',
      label: 'Rénovation Durand',
      motif: 'matériel pour le chantier Durand',
    });

    const horsChantier = makeDocumentAnalysis(
      invoiceDraft({ suggestedDestination: { kind: 'system_folder', systemKey: 'purchases', motif: 'frais généraux' } }),
      context,
      destinationContext,
    );
    expect(horsChantier.ok && horsChantier.value.suggestedDestination).toMatchObject({
      kind: 'system_folder',
      systemKey: 'purchases',
      label: 'Achats',
    });
  });

  it('rejette un chantier halluciné et retombe sur le dossier système déterministe du type', () => {
    const result = makeDocumentAnalysis(
      invoiceDraft({ suggestedDestination: { kind: 'chantier', chantierId: 'ch-invente' } }),
      context,
      destinationContext,
    );
    expect(result.ok && result.value.suggestedDestination).toMatchObject({
      kind: 'system_folder',
      systemKey: 'purchases',
    });
  });

  it('compat ascendante : sans contexte, toute suggestion de chantier est rejetée (fallback par type)', () => {
    const result = makeDocumentAnalysis(
      invoiceDraft({ suggestedDestination: { kind: 'chantier', chantierId: 'ch-durand' } }),
      context,
    );
    expect(result.ok && result.value.suggestedDestination).toMatchObject({
      kind: 'system_folder',
      systemKey: 'purchases',
    });
  });

  it('un type sans dossier système reste sans destination : décision humaine, jamais une devinette', () => {
    const result = makeDocumentAnalysis(
      { type: 'company_record', typeConfidence: 0.9, summary: 'Extrait Kbis de la société.' },
      context,
      destinationContext,
    );
    expect(result.ok && result.value.suggestedDestination).toBeNull();
  });
});

describe('fallbackDocumentDestinationFor', () => {
  it('suit suggestedSystemFolderFor et respecte la liste de clés autorisées', () => {
    expect(fallbackDocumentDestinationFor('receipt')).toMatchObject({ kind: 'system_folder', systemKey: 'purchases' });
    expect(fallbackDocumentDestinationFor('other')).toBeNull();
    expect(
      fallbackDocumentDestinationFor('bank_statement', { chantiers: [], systemKeys: ['purchases'] }),
    ).toBeNull();
  });
});
