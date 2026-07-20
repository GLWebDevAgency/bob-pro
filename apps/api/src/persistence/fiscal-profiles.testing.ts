import type { FiscalProfile, FiscalProfileRepository } from '@bob/core';

/** Double déterministe réservé au harness de tests API. */
export class InMemoryFiscalProfileRepository implements FiscalProfileRepository {
  private readonly byCompany = new Map<string, FiscalProfile>();

  async findByCompanyId(companyId: string): Promise<FiscalProfile | null> {
    return this.byCompany.get(companyId) ?? null;
  }

  async save(profile: FiscalProfile): Promise<void> {
    this.byCompany.set(profile.companyId, profile);
  }
}
