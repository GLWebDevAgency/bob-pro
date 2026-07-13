import { type DomainError } from '../shared-kernel/result';

/** Erreur applicative — englobe les erreurs de domaine + les soucis d'orchestration/infra. */
export type AppError =
  | { kind: 'domain'; error: DomainError }
  | { kind: 'not_found'; entity: string; id: string }
  | { kind: 'conflict'; entity: string; reason: string }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'validation'; issues: { field: string; message: string }[] }
  | { kind: 'dependency'; port: string; cause: string };

export const appDomain = (error: DomainError): AppError => ({ kind: 'domain', error });
export const appNotFound = (entity: string, id: string): AppError => ({ kind: 'not_found', entity, id });
export const appConflict = (entity: string, reason: string): AppError => ({ kind: 'conflict', entity, reason });
export const appForbidden = (reason: string): AppError => ({ kind: 'forbidden', reason });
