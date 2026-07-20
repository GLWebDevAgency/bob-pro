export type CatalogueDataMode = 'loading' | 'error' | 'ready';

/**
 * Une liste vide n'est légitime qu'après au moins une réponse serveur. Une photographie serveur
 * en cache reste exploitable pendant un échec de rafraîchissement, avec avertissement UI.
 */
export function catalogueDataMode(input: {
  readonly hasData: boolean;
  readonly isLoading: boolean;
  readonly isError: boolean;
}): CatalogueDataMode {
  if (input.hasData) return 'ready';
  if (input.isError) return 'error';
  return 'loading';
}
