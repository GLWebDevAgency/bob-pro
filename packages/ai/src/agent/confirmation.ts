import { type AgentAutonomy, type ToolRiskProfile, riskTierOf, requiresConfirmation } from './autonomy';

/**
 * Confirmation TYPÉE, choisie selon le palier de risque — au-delà du simple oui/non. Le canal (voix/tap)
 * la matérialise : un tap suffit pour un envoi, mais poster un encaissement demande de confirmer le MONTANT,
 * et émettre une facture (fiscal, irréversible) demande une double validation explicite.
 * - none   : aucune confirmation (lecture, ou réversible hors confirm_all).
 * - tap    : confirmation simple (un oui/tap).
 * - amount : re-confirmer le montant exact posté dans les livres (garde anti-erreur de saisie/dictée).
 * - fiscal : double validation d'une action irréversible à portée légale/fiscale.
 */
export type ConfirmationChallenge =
  | { readonly kind: 'none' }
  | { readonly kind: 'tap' }
  | { readonly kind: 'amount'; readonly expectedCents: number }
  | { readonly kind: 'fiscal'; readonly reason: string };

/** Sélectionne le défi de confirmation adapté à l'outil, au mode d'autonomie et aux arguments. */
export function challengeFor(
  tool: ToolRiskProfile,
  mode: AgentAutonomy,
  args?: Record<string, unknown>,
): ConfirmationChallenge {
  if (!requiresConfirmation(tool, mode)) return { kind: 'none' };
  const tier = riskTierOf(tool);
  if (tier === 'fiscal') return { kind: 'fiscal', reason: 'Action légale/fiscale irréversible' };
  if (tier === 'accounting') {
    const cents = args && typeof args.amountCents === 'number' ? args.amountCents : NaN;
    return Number.isFinite(cents) ? { kind: 'amount', expectedCents: cents as number } : { kind: 'tap' };
  }
  return { kind: 'tap' }; // outbound, ou confirm_all sur une action réversible
}
