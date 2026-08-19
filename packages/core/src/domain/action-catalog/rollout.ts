/**
 * Bornes d'ouverture du lot U1 (SPEC_U1D §4, greffe G2) — source UNIQUE consommée par le
 * planner, l'orchestrateur realtime, le controller HTTP et le worker de dispatch. Jamais
 * des bornes éparpillées : élargir cette liste est une décision de lot, tracée ici.
 */

export const U1_OPEN_ACTIONS = Object.freeze(['client-creer@1', 'client-modifier@1'] as const);
export type U1OpenAction = (typeof U1_OPEN_ACTIONS)[number];

/** Fail-closed : tout ce qui n'est pas explicitement ouvert est fermé. */
export function isU1OpenAction(actionId: string, actionVersion: number): boolean {
  return (U1_OPEN_ACTIONS as readonly string[]).includes(`${actionId}@${actionVersion}`);
}
