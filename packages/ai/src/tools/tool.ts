import { type Result, type AppError } from '@bob/core';

/**
 * Contrat d'outil de Bob. Invariant de parité IA/manuel : un outil DÉLÈGUE à un use case via `run`,
 * il n'a aucune logique métier propre. `parse` valide strictement les arguments (anti-hallucination d'arguments).
 */
export interface Tool<In, Out> {
  readonly name: string;
  readonly description: string;
  /** L'outil modifie l'état (vs simple lecture). */
  readonly mutating: boolean;
  /** L'action sort vers un tiers (client) ou est difficilement réversible -> confirmation par défaut. */
  readonly outbound: boolean;
  readonly compliance: 'low' | 'medium' | 'high';
  /**
   * Plancher de sécurité : action TOUJOURS à confirmer (même en autonomie 'auto'), car IRRÉVERSIBLE à
   * portée légale/fiscale (ex. émettre une facture = numéro séquentiel/pièce légale) ou destructrice
   * (purge de document). Distinct de `outbound` (envoi tiers, aussi au plancher). L'encaissement
   * (réversible, entrant) n'en fait PAS partie -> reste direct en confirm_outbound/auto.
   */
  readonly safetyFloor?: boolean;
  parse(raw: unknown): Result<In, AppError>;
  run(input: In): Promise<Result<Out, AppError>>;
}

export type AnyTool = Tool<unknown, unknown>;
