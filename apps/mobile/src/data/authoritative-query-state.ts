/** Sous-ensemble commun aux résultats TanStack Query utilisé par les écrans métier. */
export interface AuthoritativeQuerySnapshot<T> {
  readonly data: T | undefined;
  readonly isError: boolean;
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
