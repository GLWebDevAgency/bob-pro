import { createHash } from 'node:crypto';
import type { ReleaseFlagEnvironment } from '@bob/core';
import { resolveBobLiveEnv, type Env } from '../../config/env';
import type { RealtimeGlobalCapacityExpectation } from './realtime-capacity';
import { AGENT_MISSION_PROTOCOL_VERSION } from './realtime-agent-mission-negotiation';
import type { RealtimeContextSnapshot } from './realtime-context';
export {
  prepareRealtimeContext,
  REALTIME_CONTEXT_SCHEMA_VERSION,
  type PreparedRealtimeContext,
  type RealtimeContextSnapshot,
} from './realtime-context';

const SUBJECT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const PROVIDER_CALL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const REALTIME_PROVIDER_IDS = ['openai', 'mistral'] as const;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export const REALTIME_AGENT_MISSION_QUOTE_RELEASE_FLAG_KEY =
  'bob.agent_missions.quote.v1' as const;

export type RealtimeAdmissionDenial =
  | 'global_capacity'
  | 'user_minute'
  | 'user_hour'
  | 'tenant_minute'
  | 'tenant_hour'
  | 'active_lease'
  | 'session_reaping'
  | 'unavailable';

export type RealtimeLeaseState = 'reserved' | 'bound' | 'active' | 'reaping';
export type RealtimeProviderId = (typeof REALTIME_PROVIDER_IDS)[number];

/**
 * Preuve serveur qu'un bail a dépassé son hard cap selon l'horloge PostgreSQL autoritative.
 * Elle est liée à toute l'identité distante et ne peut jamais être remplacée par un booléen issu
 * d'un controller ou par l'horloge d'un pod.
 */
export interface RealtimeDatabaseHardExpiryProof {
  readonly source: 'database_hard_expiry';
  readonly companyId: string;
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly providerId: RealtimeProviderId;
  readonly providerCallId: string;
  readonly hardExpiresAt: string;
  readonly databaseObservedAt: string;
  readonly leaseVersion: number;
}

export interface RealtimeAdmissionPolicy {
  /** Null uniquement lorsque Bob Live est désactivé ; une admission reste alors fail-closed. */
  globalCapacity: RealtimeGlobalCapacityExpectation | null;
  userLimitPerMinute: number;
  userLimitPerHour: number;
  tenantLimitPerMinute: number;
  tenantLimitPerHour: number;
  reservationTtlSeconds: number;
  activeLeaseSeconds: number;
  heartbeatSeconds: number;
  reaperLeaseSeconds: number;
}

export function realtimeAdmissionPolicyFromEnv(env: Env): RealtimeAdmissionPolicy {
  const live = resolveBobLiveEnv(env);
  return {
    globalCapacity: live.globalCapacity,
    userLimitPerMinute: live.maxCallsPerMinute,
    userLimitPerHour: live.maxCallsPerHour,
    tenantLimitPerMinute: live.maxTenantCallsPerMinute,
    tenantLimitPerHour: live.maxTenantCallsPerHour,
    reservationTtlSeconds: live.reservationTtlSeconds,
    activeLeaseSeconds: live.activeLeaseSeconds,
    heartbeatSeconds: live.heartbeatSeconds,
    reaperLeaseSeconds: live.reaperLeaseSeconds,
  };
}

export function validateRealtimeAdmissionPolicy(policy: RealtimeAdmissionPolicy): void {
  const positiveIntegers = Object.entries(policy).filter(([key, value]) => (
    key !== 'globalCapacity' && (!Number.isInteger(value) || (value as number) <= 0)
  ));
  if (positiveIntegers.length > 0) {
    throw new Error(`Invalid realtime admission policy: ${positiveIntegers.map(([key]) => key).join(', ')}`);
  }
  if (policy.userLimitPerHour < policy.userLimitPerMinute) {
    throw new Error('Realtime user hourly quota must be greater than or equal to the minute quota.');
  }
  if (policy.tenantLimitPerMinute < policy.userLimitPerMinute) {
    throw new Error('Realtime tenant minute quota must be greater than or equal to the user minute quota.');
  }
  if (policy.tenantLimitPerHour < policy.userLimitPerHour) {
    throw new Error('Realtime tenant hourly quota must be greater than or equal to the user hourly quota.');
  }
  if (policy.heartbeatSeconds >= policy.activeLeaseSeconds) {
    throw new Error('Realtime heartbeat must be shorter than the active lease.');
  }
  if (policy.globalCapacity !== null) {
    const capacity = policy.globalCapacity;
    if (
      !isRealtimeProviderId(capacity.providerId)
      || capacity.providerModel.trim().length < 1
      || capacity.providerModel.length > 100
      || !Number.isInteger(capacity.globalMaxSessions)
      || capacity.globalMaxSessions < 1
      || capacity.globalMaxSessions > 1_000
      || !Number.isInteger(capacity.providerMaxSessions)
      || capacity.providerMaxSessions < capacity.globalMaxSessions
      || capacity.providerMaxSessions > 10_000
      || !Number.isInteger(capacity.configVersion)
      || capacity.configVersion < 1
      || capacity.configVersion > POSTGRES_INTEGER_MAX
    ) throw new Error('Invalid realtime global capacity policy.');
  }
}

export interface RealtimeLeaseCredential {
  companyId: string;
  subjectHash: string;
  sessionId: string;
  leaseToken: string;
}

export interface RealtimeAdmissionLease extends RealtimeLeaseCredential {
  state: 'reserved';
  leaseExpiresAt: string;
  hardExpiresAt: string;
}

export interface RealtimeReapingClaim {
  companyId: string;
  subjectHash: string;
  sessionId: string;
  providerId: RealtimeProviderId;
  providerCallId: string;
  reaperToken: string;
  reaperLeaseExpiresAt: string;
  /** Null avant le hard cap, y compris lorsque le lease heartbeat a expiré. */
  hardExpiryProof: RealtimeDatabaseHardExpiryProof | null;
}

export type RealtimeReapingBatchResult =
  | { ok: true; claims: RealtimeReapingClaim[] }
  | { ok: false; reason: 'unavailable' };

export type RealtimeTerminationClaimResult =
  | { ok: true; claim: RealtimeReapingClaim | null; pending: boolean }
  | { ok: false; reason: 'unavailable' };

export interface RealtimeAgentMissionAdmissionProof {
  protocolVersion: typeof AGENT_MISSION_PROTOCOL_VERSION;
  capabilityHash: string;
  releaseFlagVersion: number;
}

export type RealtimeAdmissionResult =
  | {
      allowed: true;
      denial: null;
      lease: RealtimeAdmissionLease;
      /**
       * Attestation de l'INSERT, séparée de la lease pour ne jamais être propagée vers les
       * tickets, le lifecycle ou les mutations par un spread de credential.
       */
      agentMissionProof: RealtimeAgentMissionAdmissionProof | null;
    }
  | {
      allowed: false;
      denial: RealtimeAdmissionDenial;
      retryAt: string | null;
      reapingClaim?: RealtimeReapingClaim;
    };

/**
 * Preuve préparée côté serveur pour l'unique INSERT d'admission. Elle ne contient que le hash de
 * la capability ; son secret one-shot reste dans l'orchestrateur HTTP.
 */
export interface RealtimeAgentMissionAdmissionBinding {
  protocolVersion: typeof AGENT_MISSION_PROTOCOL_VERSION;
  capabilityHash: string;
  releaseFlagKey: typeof REALTIME_AGENT_MISSION_QUOTE_RELEASE_FLAG_KEY;
  releaseEnvironment: ReleaseFlagEnvironment;
  releaseFlagVersion: number;
  principalBindingHash: string;
}

export interface RealtimeAdmissionReserveInput {
  companyId: string;
  /**
   * Binding HMAC courant, seul autorisé pour le nouvel INSERT. Le subject utilisateur brut ne
   * traverse jamais le port.
   */
  subjectHash: string;
  /**
   * Bindings courant + historiques, bornés à 32 et dédupliqués. Recherche de lease, replay et
   * quotas les agrègent afin qu'une rotation HMAC ne crée ni seconde session ni quota neuf.
   */
  subjectHashCandidates: readonly string[];
  /**
   * SHA-256 stable du couple tenant/propriétaire, indépendant des versions HMAC. Requis sur tous
   * les chemins N+1, y compris legacy/null, afin qu'ils partagent le même verrou que V1.
   */
  principalBindingHash: string;
  /** `null` conserve le writer historique ; une preuve V1 doit être complète et exacte. */
  agentMissionBinding: RealtimeAgentMissionAdmissionBinding | null;
  /** Handle opaque UUID choisi par le mobile pour pouvoir annuler pendant le bootstrap. */
  sessionId?: string;
  /** Borne absolue de coût/confidentialité de la session, au plus 900 secondes. */
  maxSessionSeconds: number;
}

export interface RealtimeAdmissionMutationResult {
  ok: boolean;
  reason: 'rejected' | 'expired' | 'unavailable' | null;
  leaseExpiresAt?: string;
}

export interface RealtimeReleaseInput extends RealtimeLeaseCredential {
  /** `confirmed` seulement après succès/idempotence du hangup provider. */
  providerTermination: 'confirmed' | 'not_created';
}

/** Identité opaque d'un contexte Bob Live. Aucun subject utilisateur brut ne traverse ce port. */
export interface RealtimeContextIdentity {
  companyId: string;
  subjectHash: string;
  sessionId: string;
}

/**
 * Identité de recherche dérivée du keyring HMAC complet. Le hash principal stable ne sert qu'au
 * verrou transactionnel ; il n'est ni renvoyé, ni persisté dans la lease.
 */
export interface RealtimeAdmissionSessionLookupInput {
  companyId: string;
  subjectHashCandidates: readonly string[];
  principalBindingHash: string;
  sessionId: string;
}

export interface RealtimeAgentMissionBootstrapAcknowledgementInput
extends RealtimeAdmissionSessionLookupInput {
  /** SHA-256 canonique de la capability présentée ; le secret brut ne traverse jamais le port. */
  capabilityHash: string;
}

export type RealtimeAgentMissionBootstrapAcknowledgementResult =
  | {
      ok: true;
      status: 'acknowledged' | 'replayed';
      acknowledgedAt: string;
      leaseExpiresAt: string;
    }
  | {
      ok: false;
      reason:
        | 'malformed'
        | 'not_found'
        | 'ambiguous'
        | 'expired'
        | 'state'
        | 'hash_mismatch'
        | 'unavailable';
    };

export type RealtimeSessionIdentityResolution =
  | { ok: true; identity: RealtimeContextIdentity | null }
  | { ok: false; reason: 'unavailable' };

export interface RealtimeContextUpdateInput extends RealtimeContextIdentity {
  version: number;
  revision: number;
  /** Donnée non fiable : l'implémentation repasse toujours par `parseAgentContext`. */
  context: unknown;
}

export type RealtimeContextUpdateResult =
  | { ok: true; status: 'updated' | 'idempotent'; revision: number }
  | { ok: false; reason: 'rejected' | 'expired' | 'stale' | 'conflict' | 'unavailable' };

export type RealtimeContextReadResult =
  | { ok: true; snapshot: RealtimeContextSnapshot | null }
  | { ok: false; reason: 'rejected' | 'expired' | 'unavailable' };

export interface RealtimeAdmissionPort {
  reserve(input: RealtimeAdmissionReserveInput): Promise<RealtimeAdmissionResult>;
  bindProvider(input: RealtimeLeaseCredential & {
    providerId: RealtimeProviderId;
    providerCallId: string;
  }): Promise<RealtimeAdmissionMutationResult>;
  activate(input: RealtimeLeaseCredential): Promise<RealtimeAdmissionMutationResult>;
  renew(input: RealtimeLeaseCredential): Promise<RealtimeAdmissionMutationResult>;
  release(input: RealtimeReleaseInput): Promise<RealtimeAdmissionMutationResult>;
  claimExpired(input: { companyId: string; limit?: number }): Promise<RealtimeReapingBatchResult>;
  /**
   * Résout le hash réellement porté par une session active et vivante pendant une rotation HMAC.
   * Un fence d'annulation vivant rend la session introuvable ; plusieurs lignes actives candidates
   * pour le même handle constituent une corruption et échouent fermées.
   */
  resolveSession(
    input: RealtimeAdmissionSessionLookupInput,
  ): Promise<RealtimeSessionIdentityResolution>;
  /**
   * Acquitte une seule fois la possession applicative du bootstrap V1. Avant ce reçu durable,
   * activate/renew conservent la courte deadline de réservation et l'autorité Mission reste fermée.
   */
  acknowledgeAgentMissionBootstrap(
    input: RealtimeAgentMissionBootstrapAcknowledgementInput,
  ): Promise<RealtimeAgentMissionBootstrapAcknowledgementResult>;
  /** Réclame une terminaison explicite, atomique avec le fence d'annulation du bootstrap. */
  claimTermination(
    input: RealtimeAdmissionSessionLookupInput,
  ): Promise<RealtimeTerminationClaimResult>;
  completeReaping(input: Omit<
  RealtimeReapingClaim,
    'providerId' | 'providerCallId' | 'reaperLeaseExpiresAt' | 'hardExpiryProof'
  >): Promise<RealtimeAdmissionMutationResult>;
  /** Publie le dernier écran sur un bail vivant déjà lié au provider. */
  updateContext(input: RealtimeContextUpdateInput): Promise<RealtimeContextUpdateResult>;
  /** Le cerveau ne lit le contexte qu'après activation complète de la session. */
  readContext(input: RealtimeContextIdentity): Promise<RealtimeContextReadResult>;
  /**
   * Compatibilité fail-closed pendant l'atterrissage du service appelant. Aucune implémentation
   * durable ne doit accepter l'ancien contrat qui transportait le userId brut.
   */
  acquire(input: { userId: string; companyId: string }): RealtimeAdmissionResult;
}

export interface RealtimeAdmissionEntropy {
  sessionId(): string;
  token(): string;
}

export function hashRealtimeLeaseToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isRealtimeSubjectHash(value: string): boolean {
  return SUBJECT_HASH_PATTERN.test(value);
}

export function isRealtimeCompanyId(value: string): boolean {
  return TENANT_ID_PATTERN.test(value);
}

export function isRealtimeSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function isRealtimeProviderCallId(value: string): boolean {
  return PROVIDER_CALL_ID_PATTERN.test(value);
}

export function isRealtimeProviderId(value: string): value is RealtimeProviderId {
  return (REALTIME_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isRealtimeDatabaseHardExpiryProof(
  value: unknown,
): value is RealtimeDatabaseHardExpiryProof {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  if (
    Object.keys(proof).length !== 9
    || proof.source !== 'database_hard_expiry'
    || typeof proof.companyId !== 'string'
    || !isRealtimeCompanyId(proof.companyId)
    || typeof proof.subjectHash !== 'string'
    || !isRealtimeSubjectHash(proof.subjectHash)
    || typeof proof.sessionId !== 'string'
    || !isRealtimeSessionId(proof.sessionId)
    || typeof proof.providerId !== 'string'
    || !isRealtimeProviderId(proof.providerId)
    || typeof proof.providerCallId !== 'string'
    || !isRealtimeProviderCallId(proof.providerCallId)
    || typeof proof.hardExpiresAt !== 'string'
    || typeof proof.databaseObservedAt !== 'string'
    || !Number.isSafeInteger(proof.leaseVersion)
    || (proof.leaseVersion as number) < 1
    || (proof.leaseVersion as number) > POSTGRES_INTEGER_MAX
  ) return false;
  const hardExpiresAt = Date.parse(proof.hardExpiresAt);
  const databaseObservedAt = Date.parse(proof.databaseObservedAt);
  return Number.isFinite(hardExpiresAt)
    && Number.isFinite(databaseObservedAt)
    && new Date(hardExpiresAt).toISOString() === proof.hardExpiresAt
    && new Date(databaseObservedAt).toISOString() === proof.databaseObservedAt
    && databaseObservedAt >= hardExpiresAt;
}

export function isRealtimeLeaseCredential(input: RealtimeLeaseCredential): boolean {
  return validCredential(input);
}

function validIdentity(input: { companyId: string; subjectHash: string }): boolean {
  return TENANT_ID_PATTERN.test(input.companyId) && SUBJECT_HASH_PATTERN.test(input.subjectHash);
}

function validCredential(input: RealtimeLeaseCredential): boolean {
  return validIdentity(input)
    && SESSION_ID_PATTERN.test(input.sessionId)
    && input.leaseToken.length >= 32
    && input.leaseToken.length <= 128;
}
