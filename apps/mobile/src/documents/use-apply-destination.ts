/**
 * « Classer dans {destination} » — hook RÉUTILISABLE extrait du scan (applyDestination)
 * SANS changement de comportement : déplacement (MoveDocumentToFolder) + lien métier
 * chantier (ClassifyDocument) + nom intelligent (RenameDocument, jamais sur un renommage
 * humain) + invalidations des caches. Mêmes use cases que Bob (parité humain↔voix).
 * · dossier système absent ⇒ onFilingRequested (décision humaine, aucun rangement deviné) ;
 * · échec ⇒ error à true, l'original reste où il est — message honnête côté écran ;
 * · le renommage est COSMÉTIQUE : son échec ne défait jamais le classement déjà commis.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DocumentDestinationSuggestion, DocumentFolderView, DocumentView } from '@bob/core';
import { useBobClient } from '../data/client';
import { suggestedRenameFor } from './pending-card-copy';
import { planDestinationApplication } from './apply-destination-plan';

export interface UseApplyDestinationOptions {
  /** Les dossiers racine sont-ils chargés ? Sans eux, aucune application n'est tentée. */
  foldersReady: boolean;
  rootFolders: readonly DocumentFolderView[] | undefined;
  /** Dossier système absent du coffre : on redemande à l'humain (ex. re-ouvrir la sheet). */
  onFilingRequested?: () => void;
  /** Déplacement commis — resynchronise l'état local (folderId + révision fraîche). */
  onMoved?: (moved: { documentId: string; folderId: string | null; revision: number }) => void;
  /** Vue fraîche après classify/rename — remplace l'état local du document. */
  onDocumentReplaced?: (document: DocumentView) => void;
  /** Destination appliquée (invite consommée) — juste avant les invalidations de caches. */
  onApplied?: (documentId: string) => void;
}

export interface ApplyDestinationController {
  /** Applique la destination validée — no-op si document absent, dossiers non prêts ou déjà en cours. */
  apply: (
    document: DocumentView | null,
    destination: DocumentDestinationSuggestion,
    suggestedDisplayName: string | null,
  ) => Promise<void>;
  pending: boolean;
  error: boolean;
  /** Remise à zéro (changement de document) — équivalent des setters du scan historique. */
  reset: () => void;
}

export function useApplyDestination(options: UseApplyDestinationOptions): ApplyDestinationController {
  const client = useBobClient();
  const queryClient = useQueryClient();
  const mountedRef = useRef(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function apply(
    document: DocumentView | null,
    destination: DocumentDestinationSuggestion,
    suggestedDisplayName: string | null,
  ): Promise<void> {
    if (!document || !options.foldersReady || pending) return;
    setError(false);
    setPending(true);
    try {
      let revision = document.revision;
      const plan = planDestinationApplication(destination, document, options.rootFolders ?? []);
      if (plan.kind === 'ask_human') {
        options.onFilingRequested?.();
        return;
      }
      if (plan.moveToFolderId !== null) {
        const moved = await client.moveDocumentToFolder({
          documentId: document.id,
          folderId: plan.moveToFolderId,
          expectedRevision: revision,
        });
        if (!moved.ok) throw moved.error;
        revision = moved.value.revision;
        if (mountedRef.current) options.onMoved?.(moved.value);
      }
      if (plan.classifyChantierId !== null) {
        const classified = await client.classifyDocument({
          documentId: document.id,
          linkedEntityType: 'chantier',
          linkedEntityId: plan.classifyChantierId,
          expectedRevision: revision,
        });
        if (!classified.ok) throw classified.error;
        revision = classified.value.revision;
        if (mountedRef.current) options.onDocumentReplaced?.(classified.value);
      }
      // Nom professionnel appliqué au classement — best-effort sur la révision fraîche,
      // jamais sur un renommage humain (suggestedRenameFor, règle partagée).
      const rename = suggestedRenameFor(document, suggestedDisplayName);
      if (rename !== null) {
        const renamed = await client.renameDocument({
          documentId: document.id,
          displayName: rename,
          expectedRevision: revision,
        });
        if (renamed.ok && mountedRef.current) options.onDocumentReplaced?.(renamed.value);
      }
      // Destination appliquée : l'invite de rangement est consommée pour ce document.
      options.onApplied?.(document.id);
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['document', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['document-folders'] });
    } catch {
      if (mountedRef.current) setError(true);
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }

  return {
    apply,
    pending,
    error,
    reset: () => {
      setPending(false);
      setError(false);
    },
  };
}
