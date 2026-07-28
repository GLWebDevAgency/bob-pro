import type { RealtimeProviderId } from './realtime-admission';

export type RealtimeGlobalCapacityMode = 'tracking' | 'closed' | 'active';

export interface RealtimeGlobalCapacityExpectation {
  readonly providerId: RealtimeProviderId;
  readonly providerModel: string;
  readonly globalMaxSessions: number;
  readonly providerMaxSessions: number;
  readonly configVersion: number;
}

/** Snapshot agrégé : aucune identité de tenant, sujet ou session ne franchit le port ops. */
export interface RealtimeGlobalCapacitySnapshot {
  readonly mode: RealtimeGlobalCapacityMode;
  readonly providerId: RealtimeProviderId | null;
  readonly providerModel: string | null;
  readonly globalMaxSessions: number | null;
  readonly providerMaxSessions: number | null;
  readonly configVersion: number | null;
  readonly retryAfterSeconds: number | null;
  readonly usedSessions: number;
  readonly revision: bigint;
  readonly updatedAt: string;
}

export type RealtimeGlobalCapacityInspection =
  | { readonly ok: true; readonly snapshot: RealtimeGlobalCapacitySnapshot }
  | { readonly ok: false; readonly reason: 'unavailable' };

export interface RealtimeGlobalCapacityInspector {
  inspect(): Promise<RealtimeGlobalCapacityInspection>;
}

/**
 * Autorité ouverte : ce prédicat décrit l'état exigé par une admission, jamais le simple boot
 * d'un binaire pendant un rollout fermé.
 */
export function realtimeGlobalCapacityMatches(
  snapshot: RealtimeGlobalCapacitySnapshot,
  expected: RealtimeGlobalCapacityExpectation,
): boolean {
  return snapshot.mode === 'active'
    && snapshot.providerId === expected.providerId
    && snapshot.providerModel === expected.providerModel
    && snapshot.globalMaxSessions === expected.globalMaxSessions
    && snapshot.providerMaxSessions === expected.providerMaxSessions
    && snapshot.configVersion === expected.configVersion
    && snapshot.usedSessions >= 0
    && snapshot.usedSessions <= expected.globalMaxSessions;
}

export type RealtimeGlobalCapacityAuthorityState =
  | 'active_exact'
  | 'closed_safe'
  | 'invalid';

/**
 * Autorité structurellement prête au boot.
 *
 * `closed` est l'état sûr attendu entre predeploy et postdeploy. Il peut encore porter les
 * bindings N-1 et des leases en drainage : le préflight SQL refuse néanmoins chaque nouvelle
 * réservation jusqu'à `active`. La validité structurelle du snapshot fermé est garantie par le
 * parser de l'inspector et les contraintes PostgreSQL.
 */
export function classifyRealtimeGlobalCapacityAuthority(
  snapshot: RealtimeGlobalCapacitySnapshot,
  expected: RealtimeGlobalCapacityExpectation,
): RealtimeGlobalCapacityAuthorityState {
  if (
    snapshot.mode === 'closed'
    && Number.isInteger(snapshot.usedSessions)
    && snapshot.usedSessions >= 0
  ) return 'closed_safe';
  if (realtimeGlobalCapacityMatches(snapshot, expected)) return 'active_exact';
  return 'invalid';
}

/** Une persistance sans autorité PostgreSQL réelle ne peut jamais annoncer Bob Live prêt. */
export class DisabledRealtimeGlobalCapacityInspector implements RealtimeGlobalCapacityInspector {
  async inspect(): Promise<RealtimeGlobalCapacityInspection> {
    return { ok: false, reason: 'unavailable' };
  }
}
