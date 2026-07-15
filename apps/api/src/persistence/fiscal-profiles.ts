import type { FiscalProfile, FiscalProfileRepository } from '@bob/core';

/**
 * Profils fiscaux en mémoire (BOB EXPERT FISCAL, Phase 1A) — parité de contrat avec
 * PrismaFiscalProfileRepository : une ligne par company (companyId unique). L'agrégat porte déjà
 * ses invariants (FiscalProfile.of/withField) : ce repository stocke/retourne des instances
 * telles quelles, aucune revalidation ici (pattern InMemorySubscriptionRepository).
 */
export class InMemoryFiscalProfileRepository implements FiscalProfileRepository {
  private readonly byCompany = new Map<string, FiscalProfile>();

  async findByCompanyId(companyId: string): Promise<FiscalProfile | null> {
    return this.byCompany.get(companyId) ?? null;
  }

  async save(profile: FiscalProfile): Promise<void> {
    this.byCompany.set(profile.companyId, profile);
  }
}
