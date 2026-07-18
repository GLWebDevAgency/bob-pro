/**
 * Logique PURE de sélection de la QuestionSheet — testée sans React.
 *
 * Trois modes :
 * · choix unique historique (défaut) : le tap valide immédiatement (compat ascendante) ;
 * · choix unique avec CONFIRMATION (`confirmSingle`, opt-in) : la sélection se surligne,
 *   la validation attend le bouton Confirmer — aucune action au tap sec ;
 * · choix multiple : cases à cocher + bouton Confirmer (comportement historique).
 */

export interface QuestionSelectionMode {
  readonly multiSelect: boolean;
  readonly confirmSingle: boolean;
}

export interface QuestionSelectionResult {
  readonly picked: ReadonlySet<string>;
  /** true : le tap valide immédiatement (choix unique historique, sans confirmation). */
  readonly committed: boolean;
}

/** Applique un tap sur une option selon le mode — jamais de validation en mode confirmation. */
export function toggleQuestionOption(
  picked: ReadonlySet<string>,
  value: string,
  mode: QuestionSelectionMode,
): QuestionSelectionResult {
  if (mode.multiSelect) {
    const next = new Set(picked);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return { picked: next, committed: false };
  }
  // Choix unique : la sélection REMPLACE la précédente (radio) et ne se désélectionne pas.
  return { picked: new Set([value]), committed: !mode.confirmSingle };
}

/** Le bouton Confirmer n'existe qu'en multi ou en choix unique confirmé. */
export function questionConfirmVisible(mode: QuestionSelectionMode): boolean {
  return mode.multiSelect || mode.confirmSingle;
}
