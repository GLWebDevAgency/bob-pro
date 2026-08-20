/**
 * Inventaire technique candidat du lot U1 (SPEC_U1D §4, greffe G2). Il aide les adaptateurs à
 * pincer les actions connues mais ne pilote ni policy, ni UI, ni offre modèle, ni dispatch :
 * l'unique autorité de publication profonde tranche ces frontières.
 */

export const U1_CANDIDATE_ACTIONS = Object.freeze(['client-creer@1', 'client-modifier@1'] as const);
export type U1CandidateAction = (typeof U1_CANDIDATE_ACTIONS)[number];

/** Éligibilité technique seulement : elle ne vaut ni publication, ni disponibilité produit. */
export function isU1CandidateAction(actionId: string, actionVersion: number): boolean {
  return (U1_CANDIDATE_ACTIONS as readonly string[]).includes(`${actionId}@${actionVersion}`);
}
