/**
 * Logique PURE de « Lier à un chantier » (détail document) — l'affordance MANUELLE du geste
 * vocal classer_document (ClassifyDocument linkedEntityType 'chantier', parité humain↔Bob) :
 * · seuls les CHANTIERS OUVERTS réels sont proposés (jamais un chantier clos) ;
 * · la suggestion d'analyse (suggestedDestination chantier) passe EN TÊTE si — et seulement
 *   si — elle désigne un chantier ouvert présent dans la liste (anti-hallucination, même
 *   règle que makeDocumentDestinationSuggestion côté core) ;
 * · dérive le nom du chantier déjà lié pour l'état lecture « Chantier · {nom} » — un
 *   chantier CLOS reste nommable (le lien historique ne disparaît pas avec la clôture).
 */
import type { ChantierStatus } from '@bob/core';

export interface LinkChantierCandidate {
  readonly id: string;
  readonly name: string;
  readonly status: ChantierStatus;
}

export interface LinkChantierOption {
  readonly chantierId: string;
  readonly name: string;
  /** Proposée par l'analyse du document — affichée en tête avec sa mention dédiée. */
  readonly suggested: boolean;
}

/** Options de la feuille de sélection : suggestion validée en tête, puis les autres ouverts. */
export function linkChantierOptions(
  chantiers: readonly LinkChantierCandidate[],
  suggestedChantierId: string | null,
): LinkChantierOption[] {
  const open = chantiers.filter((chantier) => chantier.status === 'open');
  // Une suggestion qui ne désigne pas un chantier OUVERT connu est ignorée (jamais inventée).
  const suggested = suggestedChantierId === null
    ? undefined
    : open.find((chantier) => chantier.id === suggestedChantierId);
  return [
    ...(suggested ? [{ chantierId: suggested.id, name: suggested.name, suggested: true }] : []),
    ...open
      .filter((chantier) => chantier.id !== suggested?.id)
      .map((chantier) => ({ chantierId: chantier.id, name: chantier.name, suggested: false })),
  ];
}

/**
 * Nom du chantier lié (linkedEntityId) — null si l'id ne correspond à aucun chantier connu :
 * l'écran affiche alors un libellé dégradé honnête, jamais un nom deviné.
 */
export function linkedChantierName(
  chantiers: readonly LinkChantierCandidate[],
  linkedEntityId: string | null,
): string | null {
  if (linkedEntityId === null) return null;
  return chantiers.find((chantier) => chantier.id === linkedEntityId)?.name ?? null;
}
