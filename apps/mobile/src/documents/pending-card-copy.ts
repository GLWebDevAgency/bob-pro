/**
 * Carte « À valider » & résultat de scan — logique de copy PURE (testable sans RN).
 * · type d'analyse réel → clé i18n du badge uppercase (handoff §isDocs) ;
 * · date courte « 27 juin » des chips métriques (sans Intl, comme formatEUR) ;
 * · « Je pense : … » → segments texte/gras : la CIBLE validée (nom de chantier réel ou
 *   libellé produit du dossier système) est mise en gras, jamais un libellé inventé ;
 * · règle de renommage au classement : le nom professionnel proposé par l'analyse ne
 *   remplace JAMAIS un renommage humain explicite (displayName ≠ filename).
 */
import { validateDocumentDisplayName, type DocumentAnalysisType } from '@bob/core';
import type { I18nKey } from '@bob/i18n';
import { FR_MONTH_NAMES } from '../fiscal/fiscal-dates';

/** Badge type de la carte — reflète le VRAI type analysé (jamais un type en dur). */
export const ANALYSIS_TYPE_LABEL_KEY: Readonly<Record<DocumentAnalysisType, I18nKey>> = {
  supplier_invoice: 'docs.badgeSupplierInvoice',
  receipt: 'docs.typeReceipt',
  bank_statement: 'docs.typeBankStatement',
  insurance_certificate: 'docs.typeInsurance',
  tax_or_social_document: 'docs.typeTaxSocial',
  contract: 'docs.typeContract',
  company_record: 'docs.typeCompanyRecord',
  chantier_photo: 'docs.typeChantierPhoto',
  accounting_document: 'docs.typeAccounting',
  other: 'docs.typeOther',
};

/** `null` = pas encore d'analyse persistée pour cette version → badge honnête « À lire ». */
export function analysisTypeLabelKey(type: DocumentAnalysisType | null): I18nKey {
  return type === null ? 'docs.typeUnknown' : ANALYSIS_TYPE_LABEL_KEY[type];
}

/** « 2026-06-27 » → « 27 juin » (chips du handoff) — l'entrée brute si la date est invalide. */
export function formatDayMonth(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const name = FR_MONTH_NAMES[month - 1];
  if (!name || day < 1 || day > 31) return iso;
  return `${day} ${name}`;
}

export interface DestinationCopySegment {
  text: string;
  bold: boolean;
}

/**
 * Compose le corps du « Je pense : … » : si le motif contient déjà la cible
 * (« matériel pour le chantier Durand »), elle est mise en gras sur place ;
 * sinon le motif est suivi de « — {cible} » en gras (« abonnement téléphone — Achats »).
 */
export function destinationSuggestionSegments(motif: string, label: string): DestinationCopySegment[] {
  const cleanMotif = motif.replace(/\s+/g, ' ').trim();
  const cleanLabel = label.replace(/\s+/g, ' ').trim();
  if (!cleanLabel) return cleanMotif ? [{ text: cleanMotif, bold: false }] : [];
  if (!cleanMotif) return [{ text: cleanLabel, bold: true }];
  const at = cleanMotif.toLowerCase().indexOf(cleanLabel.toLowerCase());
  if (at >= 0) {
    const segments: DestinationCopySegment[] = [];
    if (at > 0) segments.push({ text: cleanMotif.slice(0, at), bold: false });
    segments.push({ text: cleanMotif.slice(at, at + cleanLabel.length), bold: true });
    if (at + cleanLabel.length < cleanMotif.length) {
      segments.push({ text: cleanMotif.slice(at + cleanLabel.length), bold: false });
    }
    return segments;
  }
  return [
    { text: `${cleanMotif.replace(/[.…\s]+$/u, '')} — `, bold: false },
    { text: cleanLabel, bold: true },
  ];
}

/**
 * Nom à appliquer via renameDocument au moment du classement — ou null si on ne touche pas :
 * · pas de suggestion exploitable ; · l'humain a déjà renommé (displayName ≠ filename,
 *   même règle que pendingDisplayName @bob/core) ; · suggestion invalide côté domaine.
 */
export function suggestedRenameFor(
  document: { filename: string; displayName: string },
  suggestedDisplayName: string | null | undefined,
): string | null {
  const suggested = (suggestedDisplayName ?? '').replace(/\s+/g, ' ').trim();
  if (!suggested) return null;
  const current = document.displayName.replace(/\s+/g, ' ').trim();
  const original = document.filename.replace(/\s+/g, ' ').trim();
  if (current.length > 0 && current !== original) return null; // renommage humain : intouchable
  if (suggested === current) return null;
  const validated = validateDocumentDisplayName(suggested);
  return validated.ok ? validated.value : null;
}
