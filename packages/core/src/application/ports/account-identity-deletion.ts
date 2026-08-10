import type { Instant } from '../../shared-kernel/time';

/**
 * Demande durable de suppression de l'identité externe qui authentifie le propriétaire.
 *
 * Le core ne connaît ni Supabase, ni une table, ni un worker. L'adapter est responsable de
 * l'idempotence, de la garde owner/Cabinet et du retry fournisseur après le commit métier.
 */
export interface AccountIdentityDeletionRequest {
  readonly requestId: string;
  readonly status: 'pending' | 'done';
  readonly alreadyRequested: boolean;
}

export type AccountIdentityDeletionRequestResult =
  | { readonly outcome: 'accepted'; readonly request: AccountIdentityDeletionRequest }
  | {
      readonly outcome: 'rejected';
      readonly reason: 'company_owner_binding_mismatch' | 'active_cabinet_memberships';
    };

export interface AccountIdentityDeletionOutboxPort {
  /**
   * Participe obligatoirement à l'unité de travail de clôture. Un rejet intervient avant toute
   * mutation Company ; une exception provoque le rollback de l'ensemble du protocole.
   */
  ensureRequested(input: {
    readonly requestId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly requestedAt: Instant;
  }): Promise<AccountIdentityDeletionRequestResult>;
}
