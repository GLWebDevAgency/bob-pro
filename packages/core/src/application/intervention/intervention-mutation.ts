import { type Intervention } from '../../domain/intervention/intervention';
import { type AppError } from '../result';
import { type InterventionRepository } from './intervention-repository';

/** Sentinelle d'erreur applicative dans `runInTransaction` (rollback + restitution fidèle). */
export class TxAppError extends Error {
  constructor(readonly appError: AppError) {
    super('tx-app');
  }
}

/**
 * Chargement VERROUILLÉ + CAS de révision — socle commun des mutations de fiche (§3.6.4 :
 * l'outbox offline chaîne les `expectedRevision`, un conflit frappe le BON maillon et
 * s'affiche, jamais un écrasement silencieux). À appeler DANS `runInTransaction`.
 */
export async function lockInterventionForMutation(
  interventions: InterventionRepository,
  input: { companyId: string; interventionId: string; expectedRevision: number },
): Promise<Intervention> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new TxAppError({
      kind: 'domain',
      error: { code: 'VALIDATION', field: 'expectedRevision', message: 'Révision invalide.' },
    });
  }
  const load = interventions.lockById?.bind(interventions) ?? interventions.findById.bind(interventions);
  const intervention = await load(input.companyId, input.interventionId);
  if (!intervention || intervention.companyId !== input.companyId) {
    throw new TxAppError({ kind: 'not_found', entity: 'intervention', id: input.interventionId });
  }
  if (intervention.revision !== input.expectedRevision) {
    // Conflit EXPLICITE (jamais silencieux) : l'écran/l'outbox montre serveur vs local.
    throw new TxAppError({ kind: 'conflict', entity: 'intervention', reason: 'stale_revision' });
  }
  return intervention;
}
