import { createHash } from 'node:crypto';
import { parseAgentContext, type AgentContext } from '@bob/ai';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const REALTIME_CONTEXT_MAX_BYTES = 16_384;

export const REALTIME_CONTEXT_SCHEMA_VERSION = 1 as const;

/** Snapshot canonique stocké : schéma figé, révision client monotone et contexte déjà assaini. */
export interface RealtimeContextSnapshot {
  version: typeof REALTIME_CONTEXT_SCHEMA_VERSION;
  revision: number;
  context: AgentContext;
}

export interface PreparedRealtimeContext {
  snapshot: RealtimeContextSnapshot;
  serialized: string;
  digest: string;
}

/**
 * Produit l'unique représentation persistable et l'unique digest de contexte public/durable.
 * Deux retries de même révision ne sont idempotents que si ces octets canoniques sont identiques.
 */
export function prepareRealtimeContext(input: {
  version: number;
  revision: number;
  context: unknown;
}): PreparedRealtimeContext | null {
  if (
    input.version !== REALTIME_CONTEXT_SCHEMA_VERSION
    || !Number.isSafeInteger(input.revision)
    || input.revision < 1
    || input.revision > POSTGRES_INTEGER_MAX
  ) return null;
  const parsed = parseAgentContext(input.context);
  if (!parsed.ok) return null;
  const snapshot: RealtimeContextSnapshot = {
    version: REALTIME_CONTEXT_SCHEMA_VERSION,
    revision: input.revision,
    context: parsed.value,
  };
  const serialized = JSON.stringify(snapshot.context);
  if (Buffer.byteLength(serialized, 'utf8') > REALTIME_CONTEXT_MAX_BYTES) return null;
  return {
    snapshot,
    serialized,
    digest: createHash('sha256').update(serialized, 'utf8').digest('hex'),
  };
}
