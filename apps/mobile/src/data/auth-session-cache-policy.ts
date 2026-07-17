import { companyIdFromAppMetadata } from './tenant-identity';

export interface AuthSessionLike {
  readonly user: {
    readonly id: string;
    readonly app_metadata?: unknown;
  };
}

export interface AuthSessionCacheIdentity {
  readonly ownerId: string;
  readonly companyId: string | null;
}

/**
 * Identité minimale qui borne toutes les queries privées du mobile.
 *
 * Le token et les autres métadonnées sont volontairement exclus : leur rotation ne change pas
 * le propriétaire du cache. À l'inverse, le provisioning d'un `company_id` jusque-là absent est
 * bien une nouvelle frontière de données et doit purger les queries publiques/pré-provisioning.
 */
export function authSessionCacheIdentity(
  session: AuthSessionLike | null,
): AuthSessionCacheIdentity | null {
  if (session === null) return null;
  return {
    ownerId: session.user.id,
    companyId: companyIdFromAppMetadata(session.user.app_metadata),
  };
}

export function shouldPurgeAuthSessionCache(
  previous: AuthSessionCacheIdentity | null,
  next: AuthSessionCacheIdentity | null,
): boolean {
  if (previous === null || next === null) return previous !== next;
  return previous.ownerId !== next.ownerId || previous.companyId !== next.companyId;
}

interface PublishAuthSessionWithCacheFenceInput<TSession extends AuthSessionLike> {
  readonly previousIdentity: AuthSessionCacheIdentity | null;
  readonly nextSession: TSession | null;
  readonly clearCache: () => void;
  readonly publishSession: (session: TSession | null) => void;
}

/**
 * Applique l'ordre de sécurité obligatoire : purge SYNCHRONE, puis publication de la session.
 * La nouvelle identité retournée doit devenir la référence de la transition suivante.
 */
export function publishAuthSessionWithCacheFence<TSession extends AuthSessionLike>({
  previousIdentity,
  nextSession,
  clearCache,
  publishSession,
}: PublishAuthSessionWithCacheFenceInput<TSession>): AuthSessionCacheIdentity | null {
  const nextIdentity = authSessionCacheIdentity(nextSession);
  if (shouldPurgeAuthSessionCache(previousIdentity, nextIdentity)) clearCache();
  publishSession(nextSession);
  return nextIdentity;
}
