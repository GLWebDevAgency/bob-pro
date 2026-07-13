import { type Result, type AppError } from '@bob/core';

/**
 * Palier de risque d'une action, du moins au plus sensible. Classe l'action pour choisir la policy,
 * la confirmation typée et l'aperçu (ActionDiff). Ordonné : read < draft < reversible < accounting < outbound < fiscal.
 * - read       : lecture pure, aucun effet.
 * - draft      : crée/modifie un brouillon (réversible, sans portée externe).
 * - reversible : mutation interne réversible non sensible.
 * - accounting : impacte les livres (CA/TVA/relances) — ex. encaissement. PLANCHER de sécurité.
 * - outbound   : sort vers un tiers (client) — ex. envoi devis. PLANCHER de sécurité.
 * - fiscal     : irréversible à portée légale/fiscale — ex. émission de facture, purge. PLANCHER de sécurité.
 */
export type RiskTier = 'read' | 'draft' | 'reversible' | 'accounting' | 'outbound' | 'fiscal';

/** Projection explicitement publiable d'un résultat d'outil (jamais le payload métier brut). */
export type ToolPublicResult = Readonly<Record<string, string | number | boolean | null>>;

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
   * Plancher de sécurité : action TOUJOURS à confirmer (même en autonomie 'auto'), car irréversible à
   * portée légale/fiscale (ex. émettre une facture = numéro séquentiel/pièce légale), destructrice
   * (purge de document), ou comptable sensible (ex. poster un encaissement dans les livres).
   * Distinct de `outbound` (envoi tiers, aussi au plancher).
   */
  readonly safetyFloor?: boolean;
  /**
   * Palier de risque explicite. Optionnel : s'il est absent, il est dérivé des booléens (voir riskTierOf).
   * Il RAFFINE la classification (distingue accounting vs fiscal, draft vs reversible) et pilote la
   * confirmation typée + l'aperçu ActionDiff.
   */
  readonly riskTier?: RiskTier;
  /**
   * Allowlist de sortie vers l'orchestrateur/UI. Absente = aucun résultat propagé.
   * Elle empêche notamment les tokens et liens secrets d'entrer dans le journal ou la réponse agent.
   */
  readonly projectPublicResult?: (output: Out) => ToolPublicResult;
  parse(raw: unknown): Result<In, AppError>;
  run(input: In): Promise<Result<Out, AppError>>;
}

export type AnyTool = Tool<unknown, unknown>;
