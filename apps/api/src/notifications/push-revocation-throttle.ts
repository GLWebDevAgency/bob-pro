import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import { createClientIpTracker, type ClientIpTracker } from '../config/client-ip';
import { BoundedThrottlerStorage } from './bounded-throttler-storage';

export const PUBLIC_PUSH_CAPABILITY_THROTTLER = 'publicPushCapability';
export const PUBLIC_PUSH_CAPABILITY_LIMIT = 12;
export const PUBLIC_PUSH_IP_LIMIT = 120;
export const PUBLIC_PUSH_THROTTLE_TTL_MS = 60_000;

const PUBLIC_PUSH_CAPABILITY_METADATA = 'bob.publicPushCapabilityThrottle';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVOCATION_SECRET = /^[0-9a-f]{64}$/u;

/** Marque seulement l'endpoint public one-way ; le second throttler ignore toutes les autres routes. */
export const PublicPushCapabilityThrottle = () =>
  SetMetadata(PUBLIC_PUSH_CAPABILITY_METADATA, true);

export function shouldSkipPublicPushCapabilityThrottle(
  context: Pick<ExecutionContext, 'getHandler'>,
): boolean {
  return Reflect.getMetadata(PUBLIC_PUSH_CAPABILITY_METADATA, context.getHandler()) !== true;
}

/**
 * Une capacité exacte partage son quota entre toutes les IP (anti-abus sans DoS par UUID public).
 * Le tracker ne contient jamais le secret brut. Les corps incomplets restent groupés par IP ; le
 * throttler `default` borne en parallèle le spray de couples UUID/secret aléatoires valides.
 */
export function createPublicPushCapabilityTracker(
  clientIpTracker: ClientIpTracker,
): ClientIpTracker {
  return (request) => {
    const body = request['body'];
    const installationId =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)['installationId']
        : null;
    const revocationSecret =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)['revocationSecret']
        : null;
    if (
      typeof installationId === 'string' &&
      UUID_V4.test(installationId) &&
      typeof revocationSecret === 'string' &&
      REVOCATION_SECRET.test(revocationSecret)
    ) {
      const digest = createHash('sha256')
        .update(installationId.toLowerCase())
        .update('\0')
        .update(revocationSecret)
        .digest('hex');
      return `capability:${digest}`;
    }
    return `invalid:${clientIpTracker(request)}`;
  };
}

/** Nouvelle instance car ThrottlerGuard trie le tableau reçu lors de son initialisation. */
export function createApiThrottlerOptions(
  clientIpTracker: ClientIpTracker = createClientIpTracker(),
): ThrottlerModuleOptions {
  const capabilityTracker = createPublicPushCapabilityTracker(clientIpTracker);
  return {
    storage: new BoundedThrottlerStorage(),
    throttlers: [
      { name: 'default', ttl: 60_000, limit: 100, getTracker: clientIpTracker },
      {
        name: PUBLIC_PUSH_CAPABILITY_THROTTLER,
        ttl: PUBLIC_PUSH_THROTTLE_TTL_MS,
        limit: PUBLIC_PUSH_CAPABILITY_LIMIT,
        getTracker: capabilityTracker,
        skipIf: shouldSkipPublicPushCapabilityThrottle,
      },
    ],
  };
}
