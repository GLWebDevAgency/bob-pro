import {
  normalizeSupplierName,
  type CompanyMemoryPort,
  type RememberSupplierInput,
  type SupplierProfile,
} from './company-memory';

/** Double déterministe réservé à l'entrée test-only `@bob/ai/testing`. */
export class InMemoryCompanyMemory implements CompanyMemoryPort {
  private readonly suppliers = new Map<string, SupplierProfile>();

  constructor(seed: readonly RememberSupplierInput[] = []) {
    for (const supplier of seed) this.rememberSupplier(supplier);
  }

  supplierProfile(name: string): SupplierProfile | null {
    const key = normalizeSupplierName(name);
    return key ? this.suppliers.get(key) ?? null : null;
  }

  rememberSupplier(input: RememberSupplierInput): SupplierProfile {
    const key = normalizeSupplierName(input.name);
    const previous = this.suppliers.get(key);
    const profile: SupplierProfile = {
      key,
      displayName: input.name.trim() || previous?.displayName || input.name,
      siren: input.siren ?? previous?.siren ?? null,
      category: input.category,
      vatRatePct: input.vatRatePct ?? previous?.vatRatePct ?? null,
      seen: (previous?.seen ?? 0) + 1,
    };
    this.suppliers.set(key, profile);
    return profile;
  }

  knownSupplierNames(): string[] {
    return [...this.suppliers.values()].map((supplier) => supplier.displayName);
  }
}
