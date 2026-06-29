import { type LineInput } from './line-item';

/** Ligne persistée d'un devis/facture : un LineInput validé + un identifiant. */
export interface QuoteLine extends LineInput {
  id: string;
}
