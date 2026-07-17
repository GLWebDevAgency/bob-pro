interface VoiceSalesQueryState {
  readonly data: unknown;
  readonly isError: boolean;
}

/**
 * Une photographie déjà reçue reste une vraie donnée, mais Bob ne peut pas la présenter comme
 * actuelle après un échec de rafraîchissement. Sans affordance vocale dédiée « données anciennes »,
 * le comportement honnête est de fermer la commande jusqu'à une lecture serveur fraîche.
 */
export function isFreshSalesVoiceSnapshot(
  ...queries: readonly VoiceSalesQueryState[]
): boolean {
  return queries.every((query) => query.data !== undefined && !query.isError);
}
