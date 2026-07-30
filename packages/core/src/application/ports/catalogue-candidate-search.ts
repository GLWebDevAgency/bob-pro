import {
  MAX_CUSTOM_PRESTATION_LABEL_LENGTH,
  type CustomPrestation,
} from '../catalogue/derive-catalogue';

export const CATALOGUE_CANDIDATE_SEARCH_LIMIT = 6 as const;
export const CATALOGUE_CANDIDATE_PRESENTATION_LIMIT = 5 as const;
/** Borne de l'énoncé brut accepté par le port. */
export const CATALOGUE_CANDIDATE_QUERY_MAX_LENGTH =
  MAX_CUSTOM_PRESTATION_LABEL_LENGTH;
/**
 * Une expansion de normalisation (œ → oe, ß → ss) produit au plus deux caractères ASCII.
 * Cette borne couvre donc sans troncature toute requête brute acceptée.
 */
export const CATALOGUE_CANDIDATE_TOKEN_MAX_LENGTH = 1_000 as const;

export type CatalogueCandidateMatchKind = 'exact' | 'prefix' | 'token';

export interface CatalogueCandidateRecord extends CustomPrestation {
  /** Révision persistée relue sous verrou ; elle scelle le choix présenté. */
  readonly revision: number;
}

export interface CatalogueCandidate extends CatalogueCandidateRecord {
  /**
   * Classement déterministe, jamais un score LLM. `token` est la correspondance non exacte
   * historiquement appelée « fuzzy » dans la copy produit.
   */
  readonly matchKind: CatalogueCandidateMatchKind;
}

export interface CatalogueCandidateSearchResult {
  /** Au plus cinq lignes réelles ; aucune sentinelle synthétique. */
  readonly candidates: readonly CatalogueCandidate[];
  /** Vrai lorsqu'une sixième ligne réelle a été lue et verrouillée. */
  readonly truncated: boolean;
}

export interface CatalogueCandidateSearchPort {
  search(input: {
    readonly companyId: string;
    readonly query: string;
    readonly limit: typeof CATALOGUE_CANDIDATE_SEARCH_LIMIT;
  }): Promise<CatalogueCandidateSearchResult>;

  getById(input: {
    readonly companyId: string;
    readonly id: string;
  }): Promise<CatalogueCandidateRecord | null>;
}
