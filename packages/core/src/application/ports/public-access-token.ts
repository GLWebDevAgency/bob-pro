import { type Instant } from '../../shared-kernel/time';

/**
 * `document_view` (liens publics de visualisation devis/facture, sans signature) réutilise
 * EXACTEMENT la même infra durcie que `quote_signature` — révocable, hashé, audité, résolu en
 * transaction. Ne JAMAIS élargir `revokeAllForCompany` par scope : la clôture de compte doit
 * couper tous les scopes indifféremment (voir CloseAccount).
 */
export type PublicAccessScope = 'quote_signature' | 'document_view';
export type PublicAccessResourceType = 'quote' | 'invoice';

export interface PublicAccessGrant {
  id: string;
  companyId: string;
  resourceType: PublicAccessResourceType;
  resourceId: string;
  scope: PublicAccessScope;
  expiresAt: Instant;
  revokedAt: Instant | null;
}

export interface PublicAccessTokenRepository {
  create(input: {
    companyId: string;
    resourceType: PublicAccessResourceType;
    resourceId: string;
    scope: PublicAccessScope;
    expiresAt: Instant;
  }): Promise<{ id: string; token: string }>;
  findActive(token: string, at: Instant): Promise<PublicAccessGrant | null>;
  markUsed(id: string, at: Instant): Promise<void>;
  revoke(id: string, at: Instant): Promise<void>;
  revokeActiveFor(input: {
    companyId: string;
    resourceType: PublicAccessResourceType;
    resourceId: string;
    scope: PublicAccessScope;
    at: Instant;
  }): Promise<void>;
  /** Clôture de compte (CloseAccount) : coupe TOUS les liens publics actifs du tenant (tous
   *  types/scopes confondus), idempotent — appeler deux fois ne fait rien de plus la 2e fois. */
  revokeAllForCompany(input: { companyId: string; at: Instant }): Promise<void>;
}
