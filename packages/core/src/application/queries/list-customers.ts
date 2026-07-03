import { type Result, ok } from '../../shared-kernel/result';
import { type AppError } from '../result';
import { type CustomerRepository } from '../ports/repositories';

export interface CustomerListItem {
  id: string;
  name: string;
  type: 'b2c' | 'b2b' | 'b2g';
  score: number;
  scoreBand: 'green' | 'orange' | 'red';
  outstanding: number;
  /** SIREN si personne morale (b2b/b2g) — null pour un particulier (fiche C13 : partyLine adaptatif). */
  siren: string | null;
  /** Délai moyen de paiement constaté (jours) — 0 = aucun historique (fiche C13 : KPI « Délai moyen »). */
  avgDelayDays: number;
  /** Coordonnées pour les actions device tel:/mailto: (fiche C13) — null si non renseignées. */
  email: string | null;
  phone: string | null;
}

export class ListCustomers {
  constructor(private readonly deps: { customers: CustomerRepository }) {}

  async execute(input: { companyId: string }): Promise<Result<CustomerListItem[], AppError>> {
    const list = await this.deps.customers.listByCompany(input.companyId);
    return ok(
      list.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        score: c.score,
        scoreBand: c.scoreBand(),
        outstanding: c.outstanding,
        siren: c.siren ?? null,
        avgDelayDays: c.avgDelayDays,
        email: c.email ?? null,
        phone: c.phone ?? null,
      })),
    );
  }
}
