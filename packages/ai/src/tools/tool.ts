import { type Result, type AppError } from '@bob/core';

/**
 * Contrat d'outil de Bob. Invariant de parité IA/manuel : un outil DÉLÈGUE à un use case via `run`,
 * il n'a aucune logique métier propre. `parse` valide strictement les arguments (anti-hallucination d'arguments).
 */
export interface Tool<In, Out> {
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly compliance: 'low' | 'medium' | 'high';
  parse(raw: unknown): Result<In, AppError>;
  run(input: In): Promise<Result<Out, AppError>>;
}

export type AnyTool = Tool<unknown, unknown>;
