/**
 * Timeline d'équipement — logique PURE (Lot 4, plan DA 01/08 : « dots timeline teintés
 * par type d'entrée (statusBadgeColors) ; entry.status → i18n »). L'historique est LA
 * valeur de la fiche : la couleur du point rend le fil scannable d'un coup d'œil.
 *  · intervention → success (le geste PRO accompli — la récompense du geste commis) ;
 *  · note / photo → b2b (le journal, information bleue — même famille que les rangées
 *    documents de la fiche client) ;
 *  · document → neutral (doctrine Lot 0 : la matière document est NEUTRE, jamais une
 *    typologie client recyclée).
 * Aucun indigo : le canal reste EXCLUSIF à Bob.
 */
import type { EquipmentHistoryEntry } from '@bob/core';
import type { I18nKey } from '@bob/i18n';
import type { StatusBadgeVariant } from '@bob/ui';

/** Type d'entrée → variante de la palette badge (statusBadgeColors côté rendu). */
export function timelineDotVariant(type: EquipmentHistoryEntry['type']): StatusBadgeVariant {
  switch (type) {
    case 'intervention':
      return 'success';
    case 'document':
      return 'neutral';
    case 'note':
    case 'photo':
      return 'b2b';
  }
}

/** Statuts d'intervention du domaine (InterventionStatus) → clés i18n. */
const INTERVENTION_STATUS_KEY: Readonly<Record<string, I18nKey>> = {
  scheduled: 'equipements.interventionScheduled',
  in_progress: 'equipements.interventionInProgress',
  completed: 'equipements.interventionCompleted',
  signed: 'equipements.interventionSigned',
  cancelled: 'equipements.interventionCancelled',
};

/**
 * Clé i18n d'un statut d'intervention — null pour un statut inconnu du domaine :
 * l'écran affiche alors le statut serveur BRUT (honnête, jamais une traduction inventée).
 */
export function interventionStatusKey(status: string): I18nKey | null {
  return INTERVENTION_STATUS_KEY[status] ?? null;
}
