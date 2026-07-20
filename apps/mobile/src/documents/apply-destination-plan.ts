/**
 * Plan PUR d'application d'une destination suggérée (« Classer dans {label} ») — extrait de
 * applyDestination (scan) SANS changement de comportement, pour être rejoué à l'identique
 * par l'écran document. Règles préservées :
 * · dossier système absent du coffre ⇒ on REDEMANDE à l'humain, aucun rangement deviné ;
 * · destination chantier ⇒ rangement dans « Chantiers » UNIQUEMENT si l'original n'a pas
 *   encore de dossier (on n'écrase jamais un rangement humain), puis lien métier chantier ;
 * · destination dossier système ⇒ déplacement seulement si le document n'y est pas déjà.
 */
import type { DocumentDestinationSuggestion, DocumentFolderSystemKey } from '@bob/core';

export interface ApplyDestinationFolder {
  readonly id: string;
  readonly systemKey: DocumentFolderSystemKey | null;
}

export type ApplyDestinationPlan =
  | { readonly kind: 'ask_human' }
  | {
      readonly kind: 'apply';
      /** Dossier cible du déplacement — null : aucun déplacement à jouer. */
      readonly moveToFolderId: string | null;
      /** Chantier du lien métier (ClassifyDocument) — null : aucun lien à poser. */
      readonly classifyChantierId: string | null;
    };

export function planDestinationApplication(
  destination: DocumentDestinationSuggestion,
  document: { readonly folderId: string | null },
  rootFolders: readonly ApplyDestinationFolder[],
): ApplyDestinationPlan {
  const systemKey: DocumentFolderSystemKey =
    destination.kind === 'system_folder' ? destination.systemKey : 'projects';
  const targetFolder = rootFolders.find((folder) => folder.systemKey === systemKey) ?? null;
  if (destination.kind === 'system_folder' && targetFolder === null) {
    // Dossier système absent du coffre : décision humaine, aucun rangement deviné.
    return { kind: 'ask_human' };
  }
  const shouldMove = destination.kind === 'system_folder'
    ? targetFolder !== null && document.folderId !== targetFolder.id
    : document.folderId === null && targetFolder !== null; // ne jamais écraser un rangement humain
  return {
    kind: 'apply',
    moveToFolderId: shouldMove && targetFolder ? targetFolder.id : null,
    classifyChantierId: destination.kind === 'chantier' ? destination.chantierId : null,
  };
}
