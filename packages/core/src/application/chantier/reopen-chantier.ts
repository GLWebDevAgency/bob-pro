import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appNotFound } from '../result';
import { type ChantierRepository } from '../ports/repositories';

export interface ReopenChantierInput {
  companyId: string;
  chantierId: string;
}

export interface ReopenChantierDeps {
  chantiers: ChantierRepository;
}

/**
 * PR-11a [revue A12] — réouverture d'un site clôturé : la réponse au refus actionnable
 * « Ce site est clôturé — rouvre-le pour ajouter ». Idempotente : rouvrir un site déjà
 * ouvert ne change rien (`changed: false`), jamais une erreur mystère au double tap.
 */
export class ReopenChantier {
  constructor(private readonly deps: ReopenChantierDeps) {}

  async execute(input: ReopenChantierInput): Promise<Result<{ changed: boolean }, AppError>> {
    const chantier = await this.deps.chantiers.findById(input.chantierId);
    if (!chantier || chantier.companyId !== input.companyId)
      return err(appNotFound('chantier', input.chantierId));
    if (chantier.status === 'open') return ok({ changed: false });
    chantier.reopen();
    await this.deps.chantiers.save(chantier);
    return ok({ changed: true });
  }
}
