/**
 * useCombinedQueryState — corrige LA classe de bug P0 dominante de l'audit états (14/07) :
 * des écrans qui calculent `loading = a.isLoading || b.isLoading` puis rendent les DONNÉES
 * (souvent vides) alors qu'une des queries a ÉCHOUÉ — l'échec réseau devient « tout va
 * bien, zéro facture » (clôture qui affiche allClear=true sur un timeout !).
 * Règle : failed se lit TOUJOURS avec loading, et refetchAll relance tout d'un geste.
 * Typage STRUCTUREL (pas de dépendance TanStack) : tout objet {isLoading,isError,refetch}.
 */
export interface QueryLike {
  readonly isLoading: boolean;
  readonly isError: boolean;
  refetch: () => unknown;
}

export interface CombinedQueryState {
  readonly loading: boolean;
  readonly failed: boolean;
  readonly refetchAll: () => void;
}

export function combineQueryStates(...queries: readonly QueryLike[]): CombinedQueryState {
  return {
    loading: queries.some((query) => query.isLoading),
    failed: queries.some((query) => query.isError),
    refetchAll: () => {
      for (const query of queries) void query.refetch();
    },
  };
}
