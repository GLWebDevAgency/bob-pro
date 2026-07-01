import {
  normalizeSupplierName,
  type RememberSupplierInput,
  type SupplierProfile,
} from '@bob/ai';

export interface SupplierMemoryProfile extends SupplierProfile {
  readonly companyId: string;
  readonly lastSeenAt: string;
}

export interface SupplierMemoryRepository {
  supplierProfile(companyId: string, supplierName: string): Promise<SupplierMemoryProfile | null>;
  rememberSupplier(companyId: string, input: RememberSupplierInput, at: string): Promise<SupplierMemoryProfile>;
  knownSupplierNames(companyId: string): Promise<string[]>;
}

export class InMemorySupplierMemoryRepository implements SupplierMemoryRepository {
  private readonly profiles = new Map<string, SupplierMemoryProfile>();

  private key(companyId: string, supplierName: string): string {
    return `${companyId}:${normalizeSupplierName(supplierName)}`;
  }

  async supplierProfile(companyId: string, supplierName: string): Promise<SupplierMemoryProfile | null> {
    const key = normalizeSupplierName(supplierName);
    return key ? this.profiles.get(`${companyId}:${key}`) ?? null : null;
  }

  async rememberSupplier(companyId: string, input: RememberSupplierInput, at: string): Promise<SupplierMemoryProfile> {
    const normalized = normalizeSupplierName(input.name);
    const storageKey = this.key(companyId, input.name);
    const prev = this.profiles.get(storageKey);
    const profile: SupplierMemoryProfile = {
      companyId,
      key: normalized,
      displayName: input.name.trim() || prev?.displayName || input.name,
      siren: input.siren ?? prev?.siren ?? null,
      category: input.category,
      vatRatePct: input.vatRatePct ?? prev?.vatRatePct ?? null,
      seen: (prev?.seen ?? 0) + 1,
      lastSeenAt: at,
    };
    this.profiles.set(storageKey, profile);
    return { ...profile };
  }

  async knownSupplierNames(companyId: string): Promise<string[]> {
    return [...this.profiles.values()]
      .filter((profile) => profile.companyId === companyId)
      .map((profile) => profile.displayName)
      .sort((a, b) => a.localeCompare(b, 'fr'));
  }
}
