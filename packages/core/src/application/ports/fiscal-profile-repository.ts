import { type FiscalProfile } from '../../domain/fiscal/fiscal-profile';

/**
 * Persistance du profil fiscal (Phase 1A) — une ligne par tenant (companyId unique), pattern
 * agrégat-direct (comme CompanyRepository : findById/save travaillent sur l'agrégat, pas un DTO
 * séparé) puisque FiscalProfile porte des invariants à revalider à chaque relecture/réécriture.
 */
export interface FiscalProfileRepository {
  findByCompanyId(companyId: string): Promise<FiscalProfile | null>;
  save(profile: FiscalProfile): Promise<void>;
}
