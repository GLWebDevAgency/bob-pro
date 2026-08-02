/** Sous-ensemble commun aux résultats TanStack Query utilisé par les écrans métier. */
export interface AuthoritativeQuerySnapshot<T> {
  readonly data: T | undefined;
  readonly isError: boolean;
}

/**
 * Rend une donnée autoritative uniquement tant que sa dernière qualification n'est pas en erreur.
 *
 * TanStack Query conserve volontairement une photographie antérieure pendant un refetch en échec.
 * Cette photographie peut servir à une UI explicitement marquée « périmée », mais jamais à un
 * montant financier présenté comme actuel. Les écrans financiers passent donc par ce garde avant
 * tout calcul, rendu ou publication de contexte à Bob.
 */
export function authoritativeDataWhenHealthy<T>(
  query: AuthoritativeQuerySnapshot<T>,
): T | undefined {
  return query.isError ? undefined : query.data;
}

/**
 * Vrai lorsqu'au moins une source n'a jamais livré de donnée serveur exploitable.
 *
 * Une erreur de rafraîchissement avec une photographie en cache ne rend pas cette photographie
 * synthétique : l'écran peut la conserver avec un avertissement explicite. En revanche, une
 * erreur sans donnée doit bloquer les agrégats ; `undefined` ne peut devenir ni `[]`, ni zéro.
 */
export function hasBlockingAuthoritativeDataError(
  queries: readonly AuthoritativeQuerySnapshot<unknown>[],
): boolean {
  return queries.some((query) => query.isError && query.data === undefined);
}
