import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_ANALYSIS_TYPES,
  type DocumentDestinationSuggestion,
  type DocumentFactProvenance,
  type DocumentMoneyFact,
  type DocumentPercentageFact,
  type DocumentTextFact,
} from '@bob/core';
import { t } from '@bob/i18n';
import {
  FACT_LABEL,
  deriveDocumentInsight,
  extractionFromAnalysisFacts,
  factValue,
  smartDocumentTitle,
  type DocumentInsightAnalysisSource,
} from './document-insight-card.logic';
import { ANALYSIS_TYPE_LABEL_KEY } from './pending-card-copy';

const destination: DocumentDestinationSuggestion = {
  kind: 'system_folder',
  systemKey: 'purchases',
  label: 'Achats',
  motif: 'fournitures du mois',
};

function analysisSource(overrides: Partial<DocumentInsightAnalysisSource> = {}): DocumentInsightAnalysisSource {
  return {
    type: 'supplier_invoice',
    typeConfidence: 0.92,
    suggestedDisplayName: 'Facture Leroy Merlin — 184,90 €',
    requiresHumanReview: false,
    suggestedDestination: destination,
    ...overrides,
  };
}

const provenance: DocumentFactProvenance = {
  source: 'document_text',
  evidence: [{ page: 1, excerpt: 'ligne totale', boundingBox: null }],
  derivedFrom: [],
  rule: null,
};

function moneyFact(
  key: DocumentMoneyFact['key'],
  amountMinor: number,
  currency = 'EUR',
): DocumentMoneyFact {
  return { key, valueType: 'money', value: { amountMinor, currency }, confidence: 0.9, provenance };
}

describe('typeLabelKey — map i18n unique scan ↔ détail', () => {
  it('couvre les 10 types du domaine avec une clé résolvable dans les 3 humeurs', () => {
    for (const type of DOCUMENT_ANALYSIS_TYPES) {
      const insight = deriveDocumentInsight({ analysis: analysisSource({ type }), extraction: null });
      expect(insight.typeLabelKey).toBe(ANALYSIS_TYPE_LABEL_KEY[type]);
      for (const personality of ['pote', 'pro', 'direct'] as const) {
        expect(t(insight.typeLabelKey, { personality }).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('deriveDocumentInsight', () => {
  it('analyse complète → modèle intégral (titre intelligent, résumé, tags, warnings)', () => {
    const insight = deriveDocumentInsight({
      analysis: analysisSource({
        summary: 'Facture de fournitures pour le chantier.',
        suggestedTags: ['fournitures', 'juin'],
        warnings: ['TVA non lisible'],
      }),
      extraction: { totalTtcCents: 18_490, vatCents: 3_082 },
    });
    expect(insight.title).toBe('Facture Leroy Merlin — 184,90 €');
    expect(t(insight.typeLabelKey)).toBe('Facture fournisseur');
    expect(insight.confidencePct).toBe(92);
    expect(insight.requiresHumanReview).toBe(false);
    expect(insight.summary).toBe('Facture de fournitures pour le chantier.');
    expect(insight.amountTtcCents).toBe(18_490);
    expect(insight.vatCents).toBe(3_082);
    expect(insight.attachedToLabel).toBe('Achats');
    expect(insight.suggestedDestination).toBe(destination);
    expect(insight.tags).toEqual(['fournitures', 'juin']);
    expect(insight.warnings).toEqual(['TVA non lisible']);
  });

  it('résumé persisté (GET /documents/:id) → dégradation propre : champs absents ⇒ vides, jamais inventés', () => {
    const insight = deriveDocumentInsight({
      analysis: analysisSource({ requiresHumanReview: true, typeConfidence: 0.615 }),
      extraction: null,
    });
    expect(insight.summary).toBeNull();
    expect(insight.tags).toEqual([]);
    expect(insight.warnings).toEqual([]);
    expect(insight.amountTtcCents).toBeNull();
    expect(insight.vatCents).toBeNull();
    expect(insight.confidencePct).toBe(62);
    expect(insight.requiresHumanReview).toBe(true);
  });

  it('destination null explicite (décision humaine) → aucun « Rattaché à »', () => {
    const insight = deriveDocumentInsight({
      analysis: analysisSource({ suggestedDestination: null }),
      extraction: { totalTtcCents: 1_000, vatCents: null },
    });
    expect(insight.attachedToLabel).toBeNull();
    expect(insight.suggestedDestination).toBeNull();
    expect(insight.amountTtcCents).toBe(1_000);
    expect(insight.vatCents).toBeNull();
  });

  it('résumé vide/blanc ⇒ null (pas de paragraphe fantôme)', () => {
    expect(deriveDocumentInsight({ analysis: analysisSource({ summary: '   ' }), extraction: null }).summary).toBeNull();
  });

  it('document fourni : un renommage HUMAIN (displayName ≠ filename) prime sur la suggestion', () => {
    const insight = deriveDocumentInsight({
      analysis: analysisSource(),
      extraction: null,
      document: { filename: 'IMG_1234.jpg', displayName: 'Ticket Total du 12/06' },
    });
    expect(insight.title).toBe('Ticket Total du 12/06');
  });

  it('document fourni sans renommage humain : la suggestion d’analyse reste le titre', () => {
    const insight = deriveDocumentInsight({
      analysis: analysisSource(),
      extraction: null,
      document: { filename: 'IMG_1234.jpg', displayName: 'IMG_1234.jpg' },
    });
    expect(insight.title).toBe('Facture Leroy Merlin — 184,90 €');
  });
});

describe('extractionFromAnalysisFacts', () => {
  it('projette total_ttc + vat_amount EUR (mêmes règles que le serveur)', () => {
    expect(extractionFromAnalysisFacts([moneyFact('total_ttc', 18_490), moneyFact('vat_amount', 3_082)]))
      .toEqual({ totalTtcCents: 18_490, vatCents: 3_082 });
  });

  it('sans total TTC prouvé en EUR ⇒ null (aucun montant fabriqué)', () => {
    expect(extractionFromAnalysisFacts([])).toBeNull();
    expect(extractionFromAnalysisFacts([moneyFact('vat_amount', 3_082)])).toBeNull();
    expect(extractionFromAnalysisFacts([moneyFact('total_ttc', 18_490, 'USD')])).toBeNull();
  });

  it('TVA absente ou hors EUR ⇒ vatCents null, total conservé', () => {
    expect(extractionFromAnalysisFacts([moneyFact('total_ttc', 5_000)]))
      .toEqual({ totalTtcCents: 5_000, vatCents: null });
    expect(extractionFromAnalysisFacts([moneyFact('total_ttc', 5_000), moneyFact('vat_amount', 900, 'CHF')]))
      .toEqual({ totalTtcCents: 5_000, vatCents: null });
  });
});

describe('factValue', () => {
  it('formate argent EUR, devise étrangère, pourcentage et texte', () => {
    expect(factValue(moneyFact('total_ttc', 18_490))).toContain('184,90');
    expect(factValue(moneyFact('total_ttc', 18_490, 'USD'))).toBe('184.90 USD');
    const percentage: DocumentPercentageFact = {
      key: 'vat_rate',
      valueType: 'percentage',
      value: 20,
      confidence: 0.9,
      provenance,
    };
    expect(factValue(percentage)).toBe('20 %');
    const text: DocumentTextFact = {
      key: 'supplier_name',
      valueType: 'text',
      value: 'Leroy Merlin',
      confidence: 0.9,
      provenance,
    };
    expect(factValue(text)).toBe('Leroy Merlin');
  });

  it('chaque clé de preuve a un libellé', () => {
    for (const label of Object.values(FACT_LABEL)) expect(label.length).toBeGreaterThan(0);
  });
});

describe('smartDocumentTitle', () => {
  const doc = { filename: 'IMG_1234.jpg', displayName: 'IMG_1234.jpg' };

  it('un renommage humain (displayName ≠ filename) prime toujours', () => {
    expect(smartDocumentTitle(
      { filename: 'IMG_1234.jpg', displayName: 'Ticket Total du 12/06' },
      'Facture Leroy Merlin — 184,90 €',
    )).toBe('Ticket Total du 12/06');
  });

  it('sinon la suggestion d’analyse remplace le nom de fichier brut', () => {
    expect(smartDocumentTitle(doc, 'Facture Leroy Merlin — 184,90 €')).toBe('Facture Leroy Merlin — 184,90 €');
    expect(smartDocumentTitle(doc, '  Facture   Leroy Merlin  ')).toBe('Facture Leroy Merlin');
  });

  it('sans suggestion exploitable → displayName serveur (défaut filename), jamais vide', () => {
    expect(smartDocumentTitle(doc, null)).toBe('IMG_1234.jpg');
    expect(smartDocumentTitle(doc, '   ')).toBe('IMG_1234.jpg');
    expect(smartDocumentTitle({ filename: 'a.pdf', displayName: '' }, undefined)).toBe('a.pdf');
  });

  it('normalise les espaces avant de comparer (pas de faux renommage humain)', () => {
    expect(smartDocumentTitle(
      { filename: 'IMG 1234.jpg', displayName: ' IMG  1234.jpg ' },
      'Facture EDF — juin',
    )).toBe('Facture EDF — juin');
  });
});
