import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { parseAgentContext, type AgentContext } from '@bob/ai';
import type { Env } from '../../config/env';

const SUBJECT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const PROVIDER_CALL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export const REALTIME_CONTEXT_SCHEMA_VERSION = 1 as const;
const REALTIME_CONTEXT_MAX_BYTES = 16_384;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export type RealtimeAdmissionDenial =
  | 'user_minute'
  | 'user_hour'
  | 'tenant_minute'
  | 'tenant_hour'
  | 'active_lease'
  | 'session_reaping'
  | 'unavailable';

export type RealtimeLeaseState = 'reserved' | 'bound' | 'active' | 'reaping';

export interface RealtimeAdmissionPolicy {
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
  return {
    userLimitPerMinute: env.OPENAI_REALTIME_MAX_CALLS_PER_MINUTE,
    userLimitPerHour: env.OPENAI_REALTIME_MAX_CALLS_PER_HOUR,
    tenantLimitPerMinute: env.OPENAI_REALTIME_MAX_TENANT_CALLS_PER_MINUTE,
    tenantLimitPerHour: env.OPENAI_REALTIME_MAX_TENANT_CALLS_PER_HOUR,
    reservationTtlSeconds: env.OPENAI_REALTIME_RESERVATION_TTL_SECONDS,
    activeLeaseSeconds: env.OPENAI_REALTIME_ACTIVE_LEASE_SECONDS,
    heartbeatSeconds: env.OPENAI_REALTIME_HEARTBEAT_SECONDS,
    reaperLeaseSeconds: env.OPENAI_REALTIME_REAPER_LEASE_SECONDS,
  };
}

export function validateRealtimeAdmissionPolicy(policy: RealtimeAdmissionPolicy): void {
  const positiveIntegers = Object.entries(policy).filter(([, value]) => !Number.isInteger(value) || value <= 0);
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
  providerCallId: string;
  reaperToken: string;
  reaperLeaseExpiresAt: string;
}

export type RealtimeReapingBatchResult =
  | { ok: true; claims: RealtimeReapingClaim[] }
  | { ok: false; reason: 'unavailable' };

export type RealtimeTerminationClaimResult =
  | { ok: true; claim: RealtimeReapingClaim | null; pending: boolean }
  | { ok: false; reason: 'unavailable' };

export type RealtimeAdmissionResult =
  | { allowed: true; denial: null; lease: RealtimeAdmissionLease }
  | {
      allowed: false;
      denial: RealtimeAdmissionDenial;
      retryAt: string | null;
      reapingClaim?: RealtimeReapingClaim;
    };

export interface RealtimeAdmissionReserveInput {
  companyId: string;
  /** HMAC-SHA-256 hex calculé avant le port. Le subject utilisateur brut ne doit jamais être fourni. */
  subjectHash: string;
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

/** Snapshot canonique stocké : schéma figé, révision client monotone et contexte déjà assaini. */
export interface RealtimeContextSnapshot {
  version: typeof REALTIME_CONTEXT_SCHEMA_VERSION;
  revision: number;
  context: AgentContext;
}

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
  bindProvider(input: RealtimeLeaseCredential & { providerCallId: string }): Promise<RealtimeAdmissionMutationResult>;
  activate(input: RealtimeLeaseCredential): Promise<RealtimeAdmissionMutationResult>;
  renew(input: RealtimeLeaseCredential): Promise<RealtimeAdmissionMutationResult>;
  release(input: RealtimeReleaseInput): Promise<RealtimeAdmissionMutationResult>;
  claimExpired(input: { companyId: string; limit?: number }): Promise<RealtimeReapingBatchResult>;
  /** Réclame une terminaison explicite par identité opaque, y compris depuis une autre réplique. */
  claimTermination(input: {
    companyId: string;
    subjectHash: string;
    sessionId: string;
  }): Promise<RealtimeTerminationClaimResult>;
  completeReaping(input: Omit<RealtimeReapingClaim, 'providerCallId' | 'reaperLeaseExpiresAt'>): Promise<RealtimeAdmissionMutationResult>;
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

interface AdmissionEvent {
  companyId: string;
  subjectHash: string;
  admittedAt: number;
  sessionId: string;
}

interface MemoryLease {
  companyId: string;
  subjectHash: string;
  sessionId: string;
  leaseTokenHash: string;
  state: RealtimeLeaseState;
  providerCallId: string | null;
  reaperTokenHash: string | null;
  leaseExpiresAt: number;
  hardExpiresAt: number;
  activatedAt: number | null;
  version: number;
  context: RealtimeContextSnapshot | null;
  contextDigest: string | null;
}

export interface RealtimeAdmissionEntropy {
  sessionId(): string;
  token(): string;
}

const secureEntropy: RealtimeAdmissionEntropy = {
  sessionId: randomUUID,
  // 32 octets = jeton aléatoire 256 bits. Seul son SHA-256 entre en persistance.
  token: () => randomBytes(32).toString('base64url'),
};

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

function validContextIdentity(input: RealtimeContextIdentity): boolean {
  return validIdentity(input) && SESSION_ID_PATTERN.test(input.sessionId);
}

export interface PreparedRealtimeContext {
  snapshot: RealtimeContextSnapshot;
  serialized: string;
  digest: string;
}

/**
 * Produit l'unique représentation persistable. Deux retries de même révision ne sont
 * idempotents que si les octets de cette représentation canonique sont identiques.
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

function cloneRealtimeContextSnapshot(snapshot: RealtimeContextSnapshot): RealtimeContextSnapshot {
  return {
    version: snapshot.version,
    revision: snapshot.revision,
    context: {
      screen: { ...snapshot.context.screen },
      entities: snapshot.context.entities.map((entity) => ({ ...entity })),
      capabilities: [...snapshot.context.capabilities],
    },
  };
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function addSeconds(at: number, seconds: number): number {
  return at + seconds * 1_000;
}

/**
 * Implémentation de parité démo/test. Les opérations sont synchrones jusqu'à leur retour de
 * Promise : dans un processus Node elles forment une section critique sans `await` intermédiaire.
 * La production utilise PostgreSQL et ses advisory locks inter-répliques.
 */
export class InMemoryRealtimeAdmission implements RealtimeAdmissionPort {
  private readonly leases = new Map<string, MemoryLease>();
  private events: AdmissionEvent[] = [];

  constructor(
    private readonly policy: RealtimeAdmissionPolicy,
    private readonly now: () => number = Date.now,
    private readonly entropy: RealtimeAdmissionEntropy = secureEntropy,
  ) {
    validateRealtimeAdmissionPolicy(policy);
  }

  acquire(_input: { userId: string; companyId: string }): RealtimeAdmissionResult {
    return { allowed: false, denial: 'unavailable', retryAt: null };
  }

  async reserve(input: RealtimeAdmissionReserveInput): Promise<RealtimeAdmissionResult> {
    if (
      !validIdentity(input)
      || (input.sessionId !== undefined && !SESSION_ID_PATTERN.test(input.sessionId))
      || !Number.isInteger(input.maxSessionSeconds)
      || input.maxSessionSeconds < 1
      || input.maxSessionSeconds > 900
    ) {
      return { allowed: false, denial: 'unavailable', retryAt: null };
    }

    const now = this.now();
    const key = this.key(input.companyId, input.subjectHash);
    const existing = this.leases.get(key);
    if (existing) {
      const stale = existing.leaseExpiresAt <= now || existing.hardExpiresAt <= now;
      if (!stale) {
        return {
          allowed: false,
          denial: existing.state === 'reaping' ? 'session_reaping' : 'active_lease',
          retryAt: iso(existing.leaseExpiresAt),
        };
      }
      if (existing.providerCallId === null) {
        this.leases.delete(key);
      } else {
        const claim = this.claimLeaseForReaping(existing, now);
        return {
          allowed: false,
          denial: 'session_reaping',
          retryAt: claim?.reaperLeaseExpiresAt ?? iso(existing.leaseExpiresAt),
          ...(claim ? { reapingClaim: claim } : {}),
        };
      }
    }

    this.events = this.events.filter((event) => event.admittedAt > now - 7_200_000);
    if (input.sessionId) {
      const replay = this.events.find((event) => event.sessionId === input.sessionId);
      if (replay) {
        return replay.companyId === input.companyId && replay.subjectHash === input.subjectHash
          ? { allowed: false, denial: 'active_lease', retryAt: null }
          : { allowed: false, denial: 'unavailable', retryAt: null };
      }
    }
    const tenantEvents = this.events.filter((event) => event.companyId === input.companyId);
    const userEvents = tenantEvents.filter((event) => event.subjectHash === input.subjectHash);
    const denied = this.quotaDenial(userEvents, tenantEvents, now);
    if (denied) return denied;

    const sessionId = input.sessionId ?? this.entropy.sessionId();
    const leaseToken = this.entropy.token();
    if (!SESSION_ID_PATTERN.test(sessionId) || leaseToken.length < 32) {
      return { allowed: false, denial: 'unavailable', retryAt: null };
    }
    if ([...this.leases.values()].some((candidate) => candidate.sessionId === sessionId)) {
      return { allowed: false, denial: 'unavailable', retryAt: null };
    }
    const hardExpiresAt = addSeconds(now, input.maxSessionSeconds);
    const leaseExpiresAt = Math.min(addSeconds(now, this.policy.reservationTtlSeconds), hardExpiresAt);
    this.leases.set(key, {
      companyId: input.companyId,
      subjectHash: input.subjectHash,
      sessionId,
      leaseTokenHash: hashRealtimeLeaseToken(leaseToken),
      state: 'reserved',
      providerCallId: null,
      reaperTokenHash: null,
      leaseExpiresAt,
      hardExpiresAt,
      activatedAt: null,
      version: 1,
      context: null,
      contextDigest: null,
    });
    this.events.push({
      companyId: input.companyId,
      subjectHash: input.subjectHash,
      admittedAt: now,
      sessionId,
    });
    return {
      allowed: true,
      denial: null,
      lease: {
        companyId: input.companyId,
        subjectHash: input.subjectHash,
        sessionId,
        leaseToken,
        state: 'reserved',
        leaseExpiresAt: iso(leaseExpiresAt),
        hardExpiresAt: iso(hardExpiresAt),
      },
    };
  }

  async bindProvider(
    input: RealtimeLeaseCredential & { providerCallId: string },
  ): Promise<RealtimeAdmissionMutationResult> {
    if (!validCredential(input) || !PROVIDER_CALL_ID_PATTERN.test(input.providerCallId)) return this.rejected();
    const now = this.now();
    const lease = this.authorizedLease(input);
    if (!lease) return this.rejected();
    if (lease.leaseExpiresAt <= now || lease.hardExpiresAt <= now) return this.expired();
    if (
      (lease.state === 'bound' || lease.state === 'active')
      && lease.providerCallId === input.providerCallId
    ) {
      return { ok: true, reason: null, leaseExpiresAt: iso(lease.leaseExpiresAt) };
    }
    if (lease.state !== 'reserved' || lease.providerCallId !== null) return this.rejected();
    if ([...this.leases.values()].some((candidate) => candidate.providerCallId === input.providerCallId)) {
      return this.rejected();
    }
    lease.providerCallId = input.providerCallId;
    lease.state = 'bound';
    lease.version += 1;
    return { ok: true, reason: null, leaseExpiresAt: iso(lease.leaseExpiresAt) };
  }

  async activate(input: RealtimeLeaseCredential): Promise<RealtimeAdmissionMutationResult> {
    if (!validCredential(input)) return this.rejected();
    const now = this.now();
    const lease = this.authorizedLease(input);
    if (!lease) return this.rejected();
    if (lease.leaseExpiresAt <= now || lease.hardExpiresAt <= now) return this.expired();
    if (lease.state === 'active' && lease.providerCallId !== null) {
      return { ok: true, reason: null, leaseExpiresAt: iso(lease.leaseExpiresAt) };
    }
    if (lease.state !== 'bound' || lease.providerCallId === null) return this.rejected();
    lease.state = 'active';
    lease.activatedAt = now;
    lease.leaseExpiresAt = Math.min(addSeconds(now, this.policy.activeLeaseSeconds), lease.hardExpiresAt);
    lease.version += 1;
    return { ok: true, reason: null, leaseExpiresAt: iso(lease.leaseExpiresAt) };
  }

  async renew(input: RealtimeLeaseCredential): Promise<RealtimeAdmissionMutationResult> {
    if (!validCredential(input)) return this.rejected();
    const now = this.now();
    const lease = this.authorizedLease(input);
    if (!lease || lease.state !== 'active' || lease.providerCallId === null) return this.rejected();
    if (lease.leaseExpiresAt <= now || lease.hardExpiresAt <= now) return this.expired();
    lease.leaseExpiresAt = Math.min(addSeconds(now, this.policy.activeLeaseSeconds), lease.hardExpiresAt);
    lease.version += 1;
    return { ok: true, reason: null, leaseExpiresAt: iso(lease.leaseExpiresAt) };
  }

  async release(input: RealtimeReleaseInput): Promise<RealtimeAdmissionMutationResult> {
    if (!validCredential(input)) return this.rejected();
    const key = this.key(input.companyId, input.subjectHash);
    const lease = this.authorizedLease(input);
    if (!lease) return this.rejected();
    if (input.providerTermination === 'not_created' && lease.providerCallId !== null) return this.rejected();
    this.leases.delete(key);
    return { ok: true, reason: null };
  }

  async claimExpired(input: { companyId: string; limit?: number }): Promise<RealtimeReapingBatchResult> {
    if (!TENANT_ID_PATTERN.test(input.companyId)) return { ok: false, reason: 'unavailable' };
    const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
    const now = this.now();
    const claims: RealtimeReapingClaim[] = [];
    for (const [key, lease] of this.leases) {
      if (claims.length >= limit) break;
      if (lease.companyId !== input.companyId || lease.leaseExpiresAt > now) continue;
      if (lease.providerCallId === null) {
        this.leases.delete(key);
        continue;
      }
      const claim = this.claimLeaseForReaping(lease, now);
      if (claim) claims.push(claim);
    }
    return { ok: true, claims };
  }

  async claimTermination(input: {
    companyId: string;
    subjectHash: string;
    sessionId: string;
  }): Promise<RealtimeTerminationClaimResult> {
    if (!validIdentity(input) || !SESSION_ID_PATTERN.test(input.sessionId)) {
      return { ok: false, reason: 'unavailable' };
    }
    const key = this.key(input.companyId, input.subjectHash);
    const lease = this.leases.get(key);
    if (!lease || lease.sessionId !== input.sessionId) {
      return { ok: true, claim: null, pending: false };
    }
    if (lease.providerCallId === null) {
      this.leases.delete(key);
      return { ok: true, claim: null, pending: false };
    }
    const claim = this.claimLeaseForReaping(lease, this.now());
    return { ok: true, claim, pending: claim === null };
  }

  async completeReaping(
    input: Omit<RealtimeReapingClaim, 'providerCallId' | 'reaperLeaseExpiresAt'>,
  ): Promise<RealtimeAdmissionMutationResult> {
    if (!validIdentity(input) || !SESSION_ID_PATTERN.test(input.sessionId) || input.reaperToken.length < 32) {
      return this.rejected();
    }
    const key = this.key(input.companyId, input.subjectHash);
    const lease = this.leases.get(key);
    if (
      !lease
      || lease.sessionId !== input.sessionId
      || lease.state !== 'reaping'
      || lease.reaperTokenHash !== hashRealtimeLeaseToken(input.reaperToken)
    ) {
      return this.rejected();
    }
    this.leases.delete(key);
    return { ok: true, reason: null };
  }

  async updateContext(input: RealtimeContextUpdateInput): Promise<RealtimeContextUpdateResult> {
    if (!validContextIdentity(input)) return { ok: false, reason: 'rejected' };
    const prepared = prepareRealtimeContext(input);
    if (!prepared) return { ok: false, reason: 'rejected' };
    const lease = this.leases.get(this.key(input.companyId, input.subjectHash));
    if (!lease || lease.sessionId !== input.sessionId) return { ok: false, reason: 'rejected' };
    const now = this.now();
    if (lease.leaseExpiresAt <= now || lease.hardExpiresAt <= now) {
      return { ok: false, reason: 'expired' };
    }
    if (lease.state !== 'bound' && lease.state !== 'active') {
      return { ok: false, reason: 'rejected' };
    }
    const current = lease.context;
    if (current) {
      if (prepared.snapshot.revision < current.revision) return { ok: false, reason: 'stale' };
      if (prepared.snapshot.revision === current.revision) {
        return lease.contextDigest === prepared.digest
          ? { ok: true, status: 'idempotent', revision: current.revision }
          : { ok: false, reason: 'conflict' };
      }
    }
    lease.context = prepared.snapshot;
    lease.contextDigest = prepared.digest;
    return { ok: true, status: 'updated', revision: prepared.snapshot.revision };
  }

  async readContext(input: RealtimeContextIdentity): Promise<RealtimeContextReadResult> {
    if (!validContextIdentity(input)) return { ok: false, reason: 'rejected' };
    const lease = this.leases.get(this.key(input.companyId, input.subjectHash));
    if (!lease || lease.sessionId !== input.sessionId) return { ok: false, reason: 'rejected' };
    const now = this.now();
    if (lease.leaseExpiresAt <= now || lease.hardExpiresAt <= now) {
      return { ok: false, reason: 'expired' };
    }
    if (lease.state !== 'active') return { ok: false, reason: 'rejected' };
    return {
      ok: true,
      snapshot: lease.context ? cloneRealtimeContextSnapshot(lease.context) : null,
    };
  }

  /** État sanitaire sans secret, réservé aux tests déterministes. */
  snapshot(): {
    events: AdmissionEvent[];
    leases: Array<Omit<MemoryLease, 'leaseTokenHash' | 'reaperTokenHash' | 'contextDigest'>>;
  } {
    return {
      events: this.events.map((event) => ({ ...event })),
      leases: [...this.leases.values()].map(({
        leaseTokenHash: _lease,
        reaperTokenHash: _reaper,
        contextDigest: _contextDigest,
        ...lease
      }) => ({
        ...lease,
        context: lease.context ? cloneRealtimeContextSnapshot(lease.context) : null,
      })),
    };
  }

  private quotaDenial(
    userEvents: AdmissionEvent[],
    tenantEvents: AdmissionEvent[],
    now: number,
  ): Exclude<RealtimeAdmissionResult, { allowed: true }> | null {
    const rules: Array<{
      denial: RealtimeAdmissionDenial;
      events: AdmissionEvent[];
      windowMs: number;
      limit: number;
    }> = [
      { denial: 'user_minute', events: userEvents, windowMs: 60_000, limit: this.policy.userLimitPerMinute },
      { denial: 'user_hour', events: userEvents, windowMs: 3_600_000, limit: this.policy.userLimitPerHour },
      { denial: 'tenant_minute', events: tenantEvents, windowMs: 60_000, limit: this.policy.tenantLimitPerMinute },
      { denial: 'tenant_hour', events: tenantEvents, windowMs: 3_600_000, limit: this.policy.tenantLimitPerHour },
    ];
    for (const rule of rules) {
      const active = rule.events.filter((event) => event.admittedAt > now - rule.windowMs);
      if (active.length >= rule.limit) {
        const oldest = Math.min(...active.map((event) => event.admittedAt));
        return { allowed: false, denial: rule.denial, retryAt: iso(oldest + rule.windowMs) };
      }
    }
    return null;
  }

  private claimLeaseForReaping(lease: MemoryLease, now: number): RealtimeReapingClaim | null {
    if (lease.state === 'reaping' && lease.leaseExpiresAt > now) {
      return null;
    }
    const reaperToken = this.entropy.token();
    lease.state = 'reaping';
    lease.reaperTokenHash = hashRealtimeLeaseToken(reaperToken);
    lease.leaseExpiresAt = addSeconds(now, this.policy.reaperLeaseSeconds);
    lease.version += 1;
    return {
      companyId: lease.companyId,
      subjectHash: lease.subjectHash,
      sessionId: lease.sessionId,
      providerCallId: lease.providerCallId!,
      reaperToken,
      reaperLeaseExpiresAt: iso(lease.leaseExpiresAt),
    };
  }

  private authorizedLease(input: RealtimeLeaseCredential): MemoryLease | null {
    const lease = this.leases.get(this.key(input.companyId, input.subjectHash));
    if (
      !lease
      || lease.sessionId !== input.sessionId
      || lease.leaseTokenHash !== hashRealtimeLeaseToken(input.leaseToken)
    ) return null;
    return lease;
  }

  private key(companyId: string, subjectHash: string): string {
    return `${companyId}\u0000${subjectHash}`;
  }

  private rejected(): RealtimeAdmissionMutationResult {
    return { ok: false, reason: 'rejected' };
  }

  private expired(): RealtimeAdmissionMutationResult {
    return { ok: false, reason: 'expired' };
  }
}

/** Nom historique conservé pour les tests/imports le temps de la migration du service appelant. */
export class InProcessRealtimeAdmission extends InMemoryRealtimeAdmission {
  private readonly legacySecret = randomBytes(32);
  private readonly legacyUserWindows = new Map<string, number[]>();
  private readonly legacyTenantWindows = new Map<string, number[]>();

  constructor(userLimitPerMinute: number, now: () => number = Date.now) {
    super({
      userLimitPerMinute,
      userLimitPerHour: Math.max(30, userLimitPerMinute),
      tenantLimitPerMinute: Math.max(50, userLimitPerMinute),
      tenantLimitPerHour: Math.max(1_000, userLimitPerMinute),
      reservationTtlSeconds: 15,
      activeLeaseSeconds: 30,
      heartbeatSeconds: 10,
      reaperLeaseSeconds: 30,
    }, now);
    this.legacyLimit = userLimitPerMinute;
    this.legacyNow = now;
  }

  private readonly legacyLimit: number;
  private readonly legacyNow: () => number;

  override acquire(input: { userId: string; companyId: string }): RealtimeAdmissionResult {
    if (!input.userId || !isRealtimeCompanyId(input.companyId)) return deniedLegacy('unavailable', null);
    const now = this.legacyNow();
    const start = now - 60_000;
    const subjectHash = createHmac('sha256', this.legacySecret).update(input.userId, 'utf8').digest('hex');
    const user = (this.legacyUserWindows.get(subjectHash) ?? []).filter((at) => at > start);
    if (user.length >= this.legacyLimit) return deniedLegacy('user_minute', iso(Math.min(...user) + 60_000));
    const tenant = (this.legacyTenantWindows.get(input.companyId) ?? []).filter((at) => at > start);
    const tenantLimit = Math.max(20, this.legacyLimit * 50);
    if (tenant.length >= tenantLimit) return deniedLegacy('tenant_minute', iso(Math.min(...tenant) + 60_000));
    user.push(now);
    tenant.push(now);
    this.legacyUserWindows.set(subjectHash, user);
    this.legacyTenantWindows.set(input.companyId, tenant);
    const sessionId = randomUUID();
    const leaseToken = randomBytes(32).toString('base64url');
    return {
      allowed: true,
      denial: null,
      lease: {
        companyId: input.companyId,
        subjectHash,
        sessionId,
        leaseToken,
        state: 'reserved',
        leaseExpiresAt: iso(addSeconds(now, 15)),
        hardExpiresAt: iso(addSeconds(now, 900)),
      },
    };
  }
}

function deniedLegacy(
  denial: RealtimeAdmissionDenial,
  retryAt: string | null,
): Exclude<RealtimeAdmissionResult, { allowed: true }> {
  return { allowed: false, denial, retryAt };
}
