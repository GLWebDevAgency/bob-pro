/**
 * Carte « Ce que Bob a compris » — logique PURE partagée entre le scan et l'écran document
 * (mission « écran document = carte du scan »). Zéro RN ici : tout est testable.
 * · type analysé → clé i18n via ANALYSIS_TYPE_LABEL_KEY (pending-card-copy) : UNE seule
 *   map partagée scan ↔ détail ↔ badge « À valider », clés docs.type* déclinées ×3 tons ;
 * · deriveDocumentInsight : (analyse complète OU résumé persisté, extraction) → modèle de
 *   rendu — un résumé sans facts/tags/warnings dégrade proprement (champ absent ⇒ vide),
 *   jamais un crash ni une valeur inventée ;
 * · smartDocumentTitle : titre intelligent (renommage humain > suggestion > displayName) —
 *   mêmes règles que pendingDisplayName (@bob/core) et suggestedRenameFor ;
 * · FACT_LABEL / factValue : les preuves détaillées (section Traçabilité repliée).
 */
import {
  formatEUR,
  type DocumentAnalysisType,
  type DocumentDestinationSuggestion,
  type DocumentFact,
} from '@bob/core';
import type { I18nKey } from '@bob/i18n';
import { ANALYSIS_TYPE_LABEL_KEY } from './pending-card-copy';

/** Libellés des preuves détaillées (accordéon Traçabilité) — inchangés depuis l'écran détail. */
export const FACT_LABEL: Readonly<Record<DocumentFact['key'], string>> = {
  issuer_name: 'Émetteur',
  recipient_name: 'Destinataire',
  supplier_name: 'Fournisseur',
  customer_name: 'Client',
  company_name: 'Société',
  document_number: 'Numéro',
  contract_number: 'Contrat',
  policy_number: 'Police',
  bank_name: 'Banque',
  account_reference: 'Compte',
  iban_masked: 'IBAN',
  siren: 'SIREN',
  siret: 'SIRET',
  fiscal_period: 'Période',
  subject: 'Objet',
  chantier_name: 'Chantier',
  document_date: 'Date',
  due_date: 'Échéance',
  period_start: 'Début',
  period_end: 'Fin',
  coverage_start: 'Début de couverture',
  coverage_end: 'Fin de couverture',
  expiry_date: 'Expiration',
  total_ht: 'Total HT',
  vat_amount: 'TVA',
  total_ttc: 'Total TTC',
  amount_due: 'Montant dû',
  account_balance: 'Solde',
  tax_amount: 'Impôt / cotisation',
  vat_rate: 'Taux de TVA',
};

/** Valeur affichable d'une preuve — argent formaté EUR, pourcentage, texte tel quel. */
export function factValue(fact: DocumentFact): string {
  switch (fact.valueType) {
    case 'money':
      return fact.value.currency === 'EUR'
        ? formatEUR(fact.value.amountMinor)
        : `${(fact.value.amountMinor / 100).toFixed(2)} ${fact.value.currency}`;
    case 'percentage':
      return `${fact.value} %`;
    default:
      return fact.value;
  }
}

/**
 * Source d'analyse acceptée par la carte : l'analyse COMPLÈTE (DocumentAnalysis, issue de
 * POST /analysis) comme le RÉSUMÉ persisté (DocumentAnalysisSummaryView de GET /documents)
 * y sont structurellement assignables — les champs absents du résumé restent optionnels.
 */
export interface DocumentInsightAnalysisSource {
  type: DocumentAnalysisType;
  typeConfidence: number;
  suggestedDisplayName: string;
  requiresHumanReview: boolean;
  suggestedDestination: DocumentDestinationSuggestion | null;
  /** null accepté : le résumé persisté d'un serveur antérieur au champ dégrade proprement. */
  summary?: string | null;
  suggestedTags?: readonly string[];
  warnings?: readonly string[];
}

/** Montants de la carte — extraction OCR du scan OU résumé serveur, jamais inventés. */
export interface DocumentInsightExtractionSource {
  totalTtcCents: number;
  vatCents: number | null;
}

/** Modèle de rendu de la carte partagée — exactement la carte de référence du scan. */
export interface DocumentInsightModel {
  /** Titre intelligent (renommage humain > suggestion) — jamais un nom de fichier brut. */
  title: string;
  /** Clé i18n du type analysé (map unique ANALYSIS_TYPE_LABEL_KEY) — t() au rendu. */
  typeLabelKey: I18nKey;
  /** Confiance 0..100 arrondie (badge). */
  confidencePct: number;
  /** true ⇒ badge en ton warning (lecture à confirmer par l'humain). */
  requiresHumanReview: boolean;
  summary: string | null;
  amountTtcCents: number | null;
  vatCents: number | null;
  /** Cible « Rattaché à » (destination validée côté domaine) — null : rien à afficher. */
  attachedToLabel: string | null;
  suggestedDestination: DocumentDestinationSuggestion | null;
  tags: readonly string[];
  warnings: readonly string[];
}

export function deriveDocumentInsight(source: {
  analysis: DocumentInsightAnalysisSource;
  extraction: DocumentInsightExtractionSource | null;
  /**
   * Document affiché (filename + displayName persistés) — quand il est fourni, le titre
   * respecte la préséance smartDocumentTitle : un renommage HUMAIN prime TOUJOURS sur la
   * suggestion d'analyse. Absent (null) : la suggestion reste le seul libellé connu.
   */
  document?: { filename: string; displayName: string } | null;
}): DocumentInsightModel {
  const { analysis, extraction } = source;
  const summary = analysis.summary?.trim() ?? '';
  return {
    title: source.document
      ? smartDocumentTitle(source.document, analysis.suggestedDisplayName)
      : analysis.suggestedDisplayName,
    typeLabelKey: ANALYSIS_TYPE_LABEL_KEY[analysis.type],
    confidencePct: Math.round(analysis.typeConfidence * 100),
    requiresHumanReview: analysis.requiresHumanReview,
    summary: summary.length > 0 ? summary : null,
    amountTtcCents: extraction?.totalTtcCents ?? null,
    vatCents: extraction ? extraction.vatCents : null,
    attachedToLabel: analysis.suggestedDestination?.label ?? null,
    suggestedDestination: analysis.suggestedDestination,
    tags: analysis.suggestedTags ?? [],
    warnings: analysis.warnings ?? [],
  };
}

/**
 * Chips de montants depuis les faits PROUVÉS d'une analyse complète (mêmes règles que la
 * projection serveur documentExtractionSummaryView) : sans total TTC en EUR, aucun montant.
 * Sert de repli à l'écran détail quand le résumé `extraction` de GET /documents/:id est
 * absent mais que l'analyse vient d'être (re)jouée à la demande.
 */
export function extractionFromAnalysisFacts(
  facts: readonly DocumentFact[],
): DocumentInsightExtractionSource | null {
  const money = (key: 'total_ttc' | 'vat_amount'): number | null => {
    const fact = facts.find((candidate) => candidate.key === key && candidate.valueType === 'money');
    return fact?.valueType === 'money' && fact.value.currency === 'EUR' ? fact.value.amountMinor : null;
  };
  const totalTtcCents = money('total_ttc');
  if (totalTtcCents === null) return null;
  return { totalTtcCents, vatCents: money('vat_amount') };
}

/**
 * Titre intelligent d'un document — mêmes règles que pendingDisplayName (@bob/core) :
 * un renommage humain explicite (displayName ≠ filename) prime toujours, puis la
 * suggestion d'analyse, puis le displayName serveur (défaut = filename). Jamais vide.
 */
export function smartDocumentTitle(
  document: { filename: string; displayName: string },
  suggestedDisplayName: string | null | undefined,
): string {
  const display = document.displayName.replace(/\s+/g, ' ').trim();
  const original = document.filename.replace(/\s+/g, ' ').trim();
  if (display.length > 0 && display !== original) return display; // renommage humain : intouchable
  const suggested = (suggestedDisplayName ?? '').replace(/\s+/g, ' ').trim();
  if (suggested.length > 0) return suggested;
  return display.length > 0 ? display : document.filename;
}
