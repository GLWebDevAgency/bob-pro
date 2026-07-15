import { type Result, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { type AppError } from '../result';
import {
  buildInitialFiscalProfile,
  type FiscalProfileDerivationInput,
  type FiscalProfileView,
} from '../../domain/fiscal/fiscal-profile';
import { type FiscalProfileRepository } from '../ports/fiscal-profile-repository';

/**
 * GetFiscalProfile (Phase 1A) — lecture d'autorité du profil fiscal d'un tenant. Absent en base
 * (premier accès) : dérive un profil INITIAL par hypothèses (buildInitialFiscalProfile, jamais
 * 'confirme_utilisateur'), le PERSISTE (pour que la prochaine lecture/écriture porte sur une
 * ligne réelle) puis le renvoie — jamais un profil ephémère qui disparaîtrait au prochain appel.
 */
export class GetFiscalProfile {
  constructor(private readonly deps: { fiscalProfiles: FiscalProfileRepository }) {}

  async execute(input: { company: FiscalProfileDerivationInput; now: Instant }): Promise<Result<FiscalProfileView, AppError>> {
    const existing = await this.deps.fiscalProfiles.findByCompanyId(input.company.id);
    if (existing !== null) return ok(existing.toProps());

    const initial = buildInitialFiscalProfile(input.company, input.now);
    await this.deps.fiscalProfiles.save(initial);
    return ok(initial.toProps());
  }
}
