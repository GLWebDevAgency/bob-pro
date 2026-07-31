import { type DomainError } from '../shared-kernel/result';

/**
 * Métadonnées de TRANSPORT d'une erreur (SPEC_SYSTEME_ERREUR §2.2) — posées exclusivement par la
 * frontière HTTP CLIENTE (`req`/`reqText`/`reqRealtimeSpeech` de @bob/api-client) après décodage.
 * Les constructeurs du domaine ci-dessous ne les posent jamais : le décodeur client
 * (`decodeHttpAppError`) valide les clés EXACTES de l'objet `error` du corps serveur, un champ
 * intrus casserait les clients déployés (rétro-compat verrouillée par test).
 */
export interface AppErrorTransport {
  /** Code court référençable « BOB-<CTX>-<statut> » (registre fermé, @bob/api-client). */
  code?: string;
  /** Identifiant de corrélation bout-en-bout — présent dans chaque ligne de log Railway. */
  correlationId?: string;
}

/** Erreur applicative — englobe les erreurs de domaine + les soucis d'orchestration/infra. */
export type AppError = AppErrorTransport &
  (
    | { kind: 'domain'; error: DomainError }
    | { kind: 'not_found'; entity: string; id: string }
    | { kind: 'gone'; entity: string; reason: string }
    | { kind: 'conflict'; entity: string; reason: string }
    | { kind: 'forbidden'; reason: string }
    | { kind: 'rate_limited'; reason: string; retryAfterSeconds: number }
    | { kind: 'unavailable'; service: string; retryAfterSeconds?: number }
    | { kind: 'validation'; issues: { field: string; message: string }[] }
    | { kind: 'dependency'; port: string; cause: string }
  );

export const appDomain = (error: DomainError): AppError => ({ kind: 'domain', error });
export const appNotFound = (entity: string, id: string): AppError => ({ kind: 'not_found', entity, id });
export const appGone = (entity: string, reason: string): AppError => ({ kind: 'gone', entity, reason });
export const appConflict = (entity: string, reason: string): AppError => ({ kind: 'conflict', entity, reason });
export const appForbidden = (reason: string): AppError => ({ kind: 'forbidden', reason });
export const appRateLimited = (reason: string, retryAfterSeconds: number): AppError => ({
  kind: 'rate_limited',
  reason,
  retryAfterSeconds,
});
export const appUnavailable = (service: string, retryAfterSeconds?: number): AppError => ({
  kind: 'unavailable',
  service,
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
});
