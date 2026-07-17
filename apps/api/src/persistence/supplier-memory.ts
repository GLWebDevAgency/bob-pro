import {
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
