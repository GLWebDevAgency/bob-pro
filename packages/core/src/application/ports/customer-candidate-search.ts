export const CUSTOMER_CANDIDATE_SEARCH_LIMIT = 6 as const;

export interface CustomerCandidate {
  readonly customerId: string;
  /** Donnée réelle relue sous tenant ; elle ne doit jamais être persistée dans la mission. */
  readonly canonicalName: string;
  readonly matchKind: 'exact' | 'fuzzy';
  /** Score PostgreSQL borné entre 0 et 1, utilisé uniquement pour l'ordre déterministe. */
  readonly score: number;
}

export interface CustomerCandidateReference {
  readonly customerId: string;
  readonly canonicalName: string;
}

export interface CustomerCandidateSearchPort {
  /**
   * Dans une transaction de décision, l'adapter verrouille les lignes retournées jusqu'au
   * commit. Une relecture par ID ne peut ainsi jamais sélectionner un client renommé après
   * avoir correspondu à la parole de l'utilisateur.
   */
  search(input: {
    readonly companyId: string;
    readonly query: string;
    readonly limit: typeof CUSTOMER_CANDIDATE_SEARCH_LIMIT;
  }): Promise<readonly CustomerCandidate[]>;
}

export interface CustomerCandidateReadPort {
  findById(input: {
    readonly companyId: string;
    readonly customerId: string;
  }): Promise<CustomerCandidateReference | null>;
  findByIds(input: {
    readonly companyId: string;
    readonly customerIds: readonly string[];
  }): Promise<readonly CustomerCandidateReference[]>;
}
