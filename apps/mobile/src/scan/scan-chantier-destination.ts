/**
 * Décision PURE du geste « destination chantier » au scan — deux sens métier distincts :
 * · document SANS lecture comptable (pas d'extraction) → lien MÉTIER document↔chantier
 *   (ClassifyDocument, comportement historique inchangé) ;
 * · document de DÉPENSE (extraction présente) → l'original doit rester LIBRE de devenir le
 *   justificatif (lié 'expense' à la création par le serveur) : le coût remonte au chantier
 *   PAR LA DÉPENSE (chantierId transmis à recordDocumentExpense, chantier PROUVÉ côté
 *   serveur). Rangement : « Chantiers » si l'original n'est pas encore rangé — on n'écrase
 *   jamais un rangement humain (même règle que planDestinationApplication).
 */

export type ScanChantierChoicePlan =
  | { readonly kind: 'link_document' }
  | {
      readonly kind: 'impute_expense';
      /** Dossier « Chantiers » à appliquer — null : aucun déplacement à jouer. */
      readonly moveToFolderId: string | null;
    };

export function planScanChantierChoice(input: {
  readonly hasExtraction: boolean;
  readonly documentFolderId: string | null;
  readonly projectsFolderId: string | null;
}): ScanChantierChoicePlan {
  if (!input.hasExtraction) return { kind: 'link_document' };
  return {
    kind: 'impute_expense',
    // Original déjà rangé (ou dossier « Chantiers » absent du coffre) : aucun déplacement.
    moveToFolderId: input.documentFolderId === null ? input.projectsFolderId : null,
  };
}
