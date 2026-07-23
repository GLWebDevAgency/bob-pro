/**
 * Découverte globale minimale des tenants dont un lease Bob Live est arrivé à échéance.
 *
 * Le port est volontairement séparé de RealtimeAdmissionPort : il peut seulement louer une page
 * d'identifiants tenant. Toutes les mutations de leases restent tenantées dans l'adapter
 * d'admission existant sous FORCE RLS.
 */

export const REALTIME_REAPER_DIRECTORY_MAX_TENANTS = 1_000;

export interface RealtimeReaperDirectoryListInput {
  readonly limit: number;
}

export interface RealtimeReaperDirectoryClaimInput {
  readonly claimId: string;
}

export type RealtimeReaperDirectoryListResult =
  | {
      readonly status: 'succeeded';
      readonly companyIds: readonly string[];
      readonly hasMore: boolean;
      readonly claimId: string | null;
    }
  | { readonly status: 'unavailable' };

export type RealtimeReaperDirectoryRenewResult =
  | { readonly status: 'succeeded'; readonly renewed: boolean }
  | { readonly status: 'unavailable' };

export type RealtimeReaperDirectoryAckResult =
  | { readonly status: 'succeeded'; readonly acknowledged: boolean }
  | { readonly status: 'unavailable' };

export interface RealtimeReaperDirectoryPort {
  listDueCompanyIds(
    input: RealtimeReaperDirectoryListInput,
  ): Promise<RealtimeReaperDirectoryListResult>;
  renewClaim(
    input: RealtimeReaperDirectoryClaimInput,
  ): Promise<RealtimeReaperDirectoryRenewResult>;
  acknowledgeClaim(
    input: RealtimeReaperDirectoryClaimInput,
  ): Promise<RealtimeReaperDirectoryAckResult>;
}

/** Aucun double local ne fabrique une autorité globale multi-tenant. */
export class DisabledRealtimeReaperDirectory implements RealtimeReaperDirectoryPort {
  async listDueCompanyIds(
    _input: RealtimeReaperDirectoryListInput,
  ): Promise<RealtimeReaperDirectoryListResult> {
    return { status: 'unavailable' };
  }

  async renewClaim(
    _input: RealtimeReaperDirectoryClaimInput,
  ): Promise<RealtimeReaperDirectoryRenewResult> {
    return { status: 'unavailable' };
  }

  async acknowledgeClaim(
    _input: RealtimeReaperDirectoryClaimInput,
  ): Promise<RealtimeReaperDirectoryAckResult> {
    return { status: 'unavailable' };
  }
}
