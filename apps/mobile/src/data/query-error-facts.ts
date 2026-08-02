/**
 * Faits d'erreur d'un GROUPE de queries — pour l'ErrorNotice 2 faces (Lot 1, plan DA 01/08 :
 * « sur l'écran le plus vu, une erreur sans corrélation est un ticket support aveugle »).
 * Module PUR : extrait du PREMIER échec la projection {code, correlationId, kind} attendue
 * par ErrorNotice — le code vient du registre fermé (`bobErrorCode`), jamais inventé ici.
 */
import { bobErrorCode } from '@bob/api-client';

export interface QueryErrorLike {
  readonly isError: boolean;
  readonly error: unknown;
}

export interface QueryErrorFacts {
  readonly code: string;
  readonly correlationId: string | null;
  readonly kind: string | null;
}

/**
 * Le PREMIER échec du groupe donne les faits (l'ordre d'appel = l'ordre de priorité de
 * l'écran). Aucun échec → null (l'écran n'affiche rien). Un échec sans AppError typé reste
 * honnête : code projeté 500 par le registre, corrélation absente.
 */
export function firstQueryErrorFacts(queries: readonly QueryErrorLike[]): QueryErrorFacts | null {
  const failing = queries.find((query) => query.isError);
  if (failing === undefined) return null;
  const error = failing.error;
  const shaped =
    error !== null && typeof error === 'object'
      ? (error as { code?: unknown; correlationId?: unknown; kind?: unknown })
      : null;
  return {
    code: typeof shaped?.code === 'string' ? shaped.code : bobErrorCode(error),
    correlationId: typeof shaped?.correlationId === 'string' ? shaped.correlationId : null,
    kind: typeof shaped?.kind === 'string' ? shaped.kind : null,
  };
}
