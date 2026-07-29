/**
 * État honnête de la section Contrats.
 *
 * En rendu ordinaire, une donnée en cache reste affichable pendant une revalidation silencieuse.
 * Quand une navigation cible explicitement cette section, le refetch fait partie de la preuve :
 * `isFetching` reste donc un chargement jusqu'à son issue autoritative.
 */
export type CustomerContractsCardState = 'loading' | 'ready' | 'error';

export function deriveCustomerContractsCardState(input: {
  readonly ensureVisible: boolean;
  readonly isError: boolean;
  readonly isPending: boolean;
  readonly isFetching: boolean;
}): CustomerContractsCardState {
  if (input.isError) return 'error';
  if (input.isPending || (input.ensureVisible && input.isFetching)) return 'loading';
  return 'ready';
}
