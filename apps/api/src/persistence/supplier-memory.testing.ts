import { normalizeSupplierName, type RememberSupplierInput } from '@bob/ai';
import type { SupplierMemoryProfile, SupplierMemoryRepository } from './supplier-memory';

/** Double déterministe réservé au harness de tests API. */
export class InMemorySupplierMemoryRepository implements SupplierMemoryRepository {
  private readonly profiles = new Map<string, SupplierMemoryProfile>();

  private key(companyId: string, supplierName: string): string {
    return `${companyId}:${normalizeSupplierName(supplierName)}`;
  }

  async supplierProfile(companyId: string, supplierName: string): Promise<SupplierMemoryProfile | null> {
    const key = normalizeSupplierName(supplierName);
    return key ? this.profiles.get(`${companyId}:${key}`) ?? null : null;
  }

  async rememberSupplier(
    companyId: string,
    input: RememberSupplierInput,
    at: string,
  ): Promise<SupplierMemoryProfile> {
    const normalized = normalizeSupplierName(input.name);
    const storageKey = this.key(companyId, input.name);
    const previous = this.profiles.get(storageKey);
    const profile: SupplierMemoryProfile = {
      companyId,
      key: normalized,
      displayName: input.name.trim() || previous?.displayName || input.name,
      siren: input.siren ?? previous?.siren ?? null,
      category: input.category,
      vatRatePct: input.vatRatePct ?? previous?.vatRatePct ?? null,
      seen: (previous?.seen ?? 0) + 1,
      lastSeenAt: at,
    };
    this.profiles.set(storageKey, profile);
    return { ...profile };
  }

  async knownSupplierNames(companyId: string): Promise<string[]> {
    return [...this.profiles.values()]
      .filter((profile) => profile.companyId === companyId)
      .map((profile) => profile.displayName)
      .sort((left, right) => left.localeCompare(right, 'fr'));
  }
}
