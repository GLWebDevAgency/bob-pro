/**
 * S8 — FRAÎCHEUR APRÈS ACTION DE BOB : préfixes de clés React Query invalidés après chaque
 * run « done » de l'agent. Les onglets Expo Router restent montés (aucun re-fetch au focus),
 * donc cette invalidation est LA seule barrière contre une donnée périmée affichée juste
 * après que Bob a affirmé le contraire (« Document validé ✓ » vs file « À valider » figée).
 *
 * Sémantique React Query : `invalidateQueries({ queryKey })` matche par PRÉFIXE, élément
 * par élément — ['document'] couvre ['document', id] sans toucher ['documents'] (premier
 * élément différent). L'Assistant ne connaît pas l'id muté côté serveur : le préfixe est
 * le bon niveau d'invalidation. Logique pure, testée : l'écran ne fait qu'itérer.
 */
export const AGENT_REFRESH_QUERY_KEY_PREFIXES: readonly (readonly string[])[] = [
  ['invoices'],
  ['quotes'],
  ['customers'],
  ['cashflow'],
  ['notifications'],
  // LOT 5 — outils documents (valider_document / classer_document / renommer_document) :
  ['documents'], // liste + ['documents', 'folder', folderId] (contenu d'un dossier)
  ['document'], // fiche ['document', documentId]
  ['document-folders'], // arborescence ['document-folders', parentId]
  ['document-folder'], // détail du coffre ['document-folder', folderId]
  // scan_depense / enregistrer_reglement_depense : dépenses + écritures comptables.
  ['expenses'],
  ['accounting-entries'],
];
