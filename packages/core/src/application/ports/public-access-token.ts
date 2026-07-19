import { type Instant } from '../../shared-kernel/time';

/**
 * `document_view` (liens publics de visualisation devis/facture, sans signature) réutilise
 * EXACTEMENT la même infra durcie que `quote_signature` — révocable, hashé, audité, résolu en
 * transaction. Ne JAMAIS élargir `revokeAllForCompany` par scope : la clôture de compte doit
 * couper tous les scopes indifféremment (voir CloseAccount).
 * `quote_retractation` (A3) : fonctionnalité de rétractation en ligne du consommateur
 * (art. L221-21 dernier al. et D221-5 c. conso) — créé À LA SIGNATURE d'un devis B2C, valable
 * pendant TOUTE la durée du délai de rétractation (jamais révoqué par la signature, c'est son
 * objet même), révoqué à l'exercice de la rétractation ou à la clôture du compte.
 */
export type PublicAccessScope = 'quote_signature' | 'document_view' | 'quote_retractation';
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
