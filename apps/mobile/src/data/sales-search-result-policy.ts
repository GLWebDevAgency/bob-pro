export function salesDocumentMatchesActiveSearch(input: {
  readonly id: string;
  readonly localMatch: boolean;
  readonly hasServerFilters: boolean;
  readonly serverMatchedIds: ReadonlySet<string> | null;
}): boolean {
  if (!input.hasServerFilters) return input.localMatch;
  // Dates, statut et client sont appliqués exclusivement côté serveur. Sans réponse serveur,
  // aucun résultat ne peut être présenté comme correspondant à ces filtres.
  return input.serverMatchedIds !== null && input.serverMatchedIds.has(input.id);
}
