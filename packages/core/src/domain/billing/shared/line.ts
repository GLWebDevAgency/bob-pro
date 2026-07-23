import { type LineInput } from './line-item';

/** Ligne persistée d'un devis/facture : un LineInput validé + un identifiant. */
export interface QuoteLine extends LineInput {
  id: string;
  /** Lien immuable vers la ligne du devis d'origine pour les pièces dérivées. Absent pour une
   * ligne de devis ou une facture directe ; interdit à inventer lors d'une relecture legacy. */
  sourceQuoteLineId?: string;
}
