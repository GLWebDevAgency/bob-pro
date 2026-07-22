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

/** Une persistance sans autorité PostgreSQL réelle ne peut jamais annoncer Bob Live prêt. */
export class DisabledRealtimeGlobalCapacityInspector implements RealtimeGlobalCapacityInspector {
  async inspect(): Promise<RealtimeGlobalCapacityInspection> {
    return { ok: false, reason: 'unavailable' };
  }
}
