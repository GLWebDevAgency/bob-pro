import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { Siret } from '../../shared-kernel/identifiers';
import { type CompanyLookupPort, type CompanyLookupResult } from '../ports/company-lookup';

export interface AutofillCompanyInput {
  siret: string;
}

/**
 * Pré-remplit le profil entreprise depuis un SIRET.
 * Valide le SIRET (Luhn, VO domaine) AVANT tout appel réseau — économise le quota de l'API publique.
 */
export class AutofillCompanyFromSiret {
  constructor(private readonly deps: { lookup: CompanyLookupPort }) {}

  async execute(input: AutofillCompanyInput): Promise<Result<CompanyLookupResult, AppError>> {
    const v = Siret.of(input.siret);
    if (!v.ok) return err(appDomain(v.error));
    const res = await this.deps.lookup.lookupBySiret(v.value.value);
    if (!res) return err(appNotFound('company', v.value.value));
    return ok(res);
  }
}
