import { type Instant } from '../../shared-kernel/time';

export type PublicAccessScope = 'quote_signature';
export type PublicAccessResourceType = 'quote';

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
}
