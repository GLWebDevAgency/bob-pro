import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  hashRealtimeLeaseToken,
  isRealtimeCompanyId,
  isRealtimeProviderId,
  prepareRealtimeContext,
  validateRealtimeAdmissionPolicy,
  type RealtimeAdmissionDenial,
  type RealtimeAdmissionEntropy,
  type RealtimeAdmissionMutationResult,
  type RealtimeAdmissionPolicy,
  type RealtimeAdmissionPort,
  type RealtimeAdmissionReserveInput,
  type RealtimeAdmissionResult,
  type RealtimeAdmissionSessionLookupInput,
  type RealtimeContextIdentity,
  type RealtimeContextReadResult,
  type RealtimeContextSnapshot,
  type RealtimeContextUpdateInput,
  type RealtimeContextUpdateResult,
  type RealtimeDatabaseHardExpiryProof,
  type RealtimeLeaseCredential,
  type RealtimeLeaseState,
  type RealtimeProviderId,
  type RealtimeReapingBatchResult,
  type RealtimeReapingClaim,
  type RealtimeReleaseInput,
  type RealtimeSessionIdentityResolution,
  type RealtimeTerminationClaimResult,
} from './realtime-admission';

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const SUBJECT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_CALL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** Réduit le bruit des fixtures legacy tout en gardant le nouveau contrat d'identité explicite. */
export function realtimeAdmissionLegacyTestBinding(subjectHash: string) {
  return {
    subjectHashCandidates: [subjectHash],
    principalBindingHash: subjectHash,
    agentMissionBinding: null,
  } as const;
}

interface AdmissionEvent {
  companyId: string;
  subjectHash: string;
  admittedAt: number;
  sessionId: string;
}

interface MemoryCancellationFence {
  companyId: string;
  subjectHash: string;
  sessionId: string;
  cancelledAt: number;
  expiresAt: number;
}

interface MemoryLease {
  companyId: string;
  subjectHash: string;
  sessionId: string;
  leaseTokenHash: string;
  state: RealtimeLeaseState;
  providerId: RealtimeProviderId | null;
  providerCallId: string | null;
  reaperTokenHash: string | null;
  leaseExpiresAt: number;
  hardExpiresAt: number;
  activatedAt: number | null;
  version: number;
  context: RealtimeContextSnapshot | null;
  contextDigest: string | null;
}

const secureEntropy: RealtimeAdmissionEntropy = {
  sessionId: randomUUID,
  token: () => randomBytes(32).toString('base64url'),
};

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

function validSessionLookup(input: RealtimeAdmissionSessionLookupInput): boolean {
  const candidates = input.subjectHashCandidates;
  return TENANT_ID_PATTERN.test(input.companyId)
    && Array.isArray(candidates)
    && candidates.length >= 1
    && candidates.length <= 32
    && candidates.every((candidate) => SUBJECT_HASH_PATTERN.test(candidate))
    && new Set(candidates).size === candidates.length
    && SUBJECT_HASH_PATTERN.test(input.principalBindingHash)
    && SESSION_ID_PATTERN.test(input.sessionId);
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
  private readonly cancellationFences = new Map<string, MemoryCancellationFence>();
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
    const candidates = input.subjectHashCandidates;
    if (
      this.policy.globalCapacity === null
      ||
      !validIdentity(input)
      || !Array.isArray(candidates)
      || candidates.length < 1
      || candidates.length > 32
      || candidates.some((subjectHash) => !SUBJECT_HASH_PATTERN.test(subjectHash))
      || new Set(candidates).size !== candidates.length
      || !candidates.includes(input.subjectHash)
      || !SUBJECT_HASH_PATTERN.test(input.principalBindingHash)
      // Le double mémoire ne peut pas revalider le flag durable dans la transaction : V1 ferme.
      || input.agentMissionBinding !== null
      || (input.sessionId !== undefined && !SESSION_ID_PATTERN.test(input.sessionId))
      || !Number.isInteger(input.maxSessionSeconds)
      || input.maxSessionSeconds < 1
      || input.maxSessionSeconds > 900
    ) {
      return { allowed: false, denial: 'unavailable', retryAt: null };
    }

    const now = this.now();
    for (const [fenceKey, fence] of this.cancellationFences) {
      if (fence.expiresAt <= now) this.cancellationFences.delete(fenceKey);
    }
    if (
      input.sessionId
      && candidates.some((subjectHash) => this.cancellationFences.has(
        this.cancellationKey(input.companyId, input.sessionId!, subjectHash),
      ))
    ) {
      return { allowed: false, denial: 'active_lease', retryAt: null };
    }
    const key = this.key(input.companyId, input.subjectHash);
    const candidateSet = new Set(candidates);
    const existingRows = [...this.leases.values()]
      .filter((lease) => (
        lease.companyId === input.companyId
        && candidateSet.has(lease.subjectHash)
      ))
      .sort((left, right) => (
        left.subjectHash.localeCompare(right.subjectHash)
        || left.sessionId.localeCompare(right.sessionId)
      ));
    const blockingRows = existingRows.filter((existing) => (
      (existing.state === 'reaping' && existing.leaseExpiresAt > now)
      || (
        existing.state !== 'reaping'
        && existing.leaseExpiresAt > now
        && existing.hardExpiresAt > now
      )
    ));
    if (blockingRows.length > 1) {
      return { allowed: false, denial: 'unavailable', retryAt: null };
    }
    const blocking = blockingRows[0];
    if (blocking) {
      return {
        allowed: false,
        denial: blocking.state === 'reaping' ? 'session_reaping' : 'active_lease',
        retryAt: iso(blocking.leaseExpiresAt),
      };
    }
    for (const existing of existingRows) {
      const existingKey = this.key(existing.companyId, existing.subjectHash);
      if (existing.providerId === null && existing.providerCallId === null) {
        this.leases.delete(existingKey);
      } else {
        if (existing.providerId === null || existing.providerCallId === null) {
          return { allowed: false, denial: 'unavailable', retryAt: null };
        }
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
        return replay.companyId === input.companyId && candidateSet.has(replay.subjectHash)
          ? { allowed: false, denial: 'active_lease', retryAt: null }
          : { allowed: false, denial: 'unavailable', retryAt: null };
      }
    }
    const tenantEvents = this.events.filter((event) => event.companyId === input.companyId);
    const userEvents = tenantEvents.filter((event) => candidateSet.has(event.subjectHash));
    const denied = this.quotaDenial(userEvents, tenantEvents, now);
    if (denied) return denied;

    if (this.leases.size >= this.policy.globalCapacity.globalMaxSessions) {
      const nearestExpiry = Math.min(
        ...[...this.leases.values()].map((lease) => Math.min(lease.leaseExpiresAt, lease.hardExpiresAt)),
      );
      return {
        allowed: false,
        denial: 'global_capacity',
        retryAt: iso(Math.max(now + 1_000, Math.min(now + 60_000, nearestExpiry))),
      };
    }

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
      providerId: null,
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
      agentMissionProof: null,
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
    input: RealtimeLeaseCredential & { providerId: RealtimeProviderId; providerCallId: string },
  ): Promise<RealtimeAdmissionMutationResult> {
    if (
      !validCredential(input)
      || !isRealtimeProviderId(input.providerId)
      || !PROVIDER_CALL_ID_PATTERN.test(input.providerCallId)
    ) return this.rejected();
    const now = this.now();
    const lease = this.authorizedLease(input);
    if (!lease) return this.rejected();
    if (lease.leaseExpiresAt <= now || lease.hardExpiresAt <= now) return this.expired();
    if (
      (lease.state === 'bound' || lease.state === 'active')
      && lease.providerId === input.providerId
      && lease.providerCallId === input.providerCallId
    ) {
      return { ok: true, reason: null, leaseExpiresAt: iso(lease.leaseExpiresAt) };
    }
    if (lease.state !== 'reserved' || lease.providerId !== null || lease.providerCallId !== null) {
      return this.rejected();
    }
    if ([...this.leases.values()].some((candidate) => (
      candidate.providerId === input.providerId
      && candidate.providerCallId === input.providerCallId
    ))) {
      return this.rejected();
    }
    lease.providerId = input.providerId;
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
    if (lease.state === 'active' && lease.providerId !== null && lease.providerCallId !== null) {
      return { ok: true, reason: null, leaseExpiresAt: iso(lease.leaseExpiresAt) };
    }
    if (lease.state !== 'bound' || lease.providerId === null || lease.providerCallId === null) {
      return this.rejected();
    }
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
    if (
      !lease
      || lease.state !== 'active'
      || lease.providerId === null
      || lease.providerCallId === null
    ) return this.rejected();
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
    if (
      input.providerTermination === 'not_created'
      && (lease.providerId !== null || lease.providerCallId !== null)
    ) return this.rejected();
    this.leases.delete(key);
    return { ok: true, reason: null };
  }

  async claimExpired(input: { companyId: string; limit?: number }): Promise<RealtimeReapingBatchResult> {
    if (!TENANT_ID_PATTERN.test(input.companyId)) return { ok: false, reason: 'unavailable' };
    const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
    const now = this.now();
    for (const [fenceKey, fence] of this.cancellationFences) {
      if (fence.companyId === input.companyId && fence.expiresAt <= now) {
        this.cancellationFences.delete(fenceKey);
      }
    }
    const claims: RealtimeReapingClaim[] = [];
    for (const [key, lease] of this.leases) {
      if (claims.length >= limit) break;
      if (lease.companyId !== input.companyId || lease.leaseExpiresAt > now) continue;
      if (lease.providerId === null && lease.providerCallId === null) {
        this.leases.delete(key);
        continue;
      }
      if (lease.providerId === null || lease.providerCallId === null) continue;
      const claim = this.claimLeaseForReaping(lease, now);
      if (claim) claims.push(claim);
    }
    return { ok: true, claims };
  }

  async resolveSession(
    input: RealtimeAdmissionSessionLookupInput,
  ): Promise<RealtimeSessionIdentityResolution> {
    if (!validSessionLookup(input)) return { ok: false, reason: 'unavailable' };
    const now = this.now();
    const hasLiveCancellationFence = input.subjectHashCandidates.some((subjectHash) => {
      const fence = this.cancellationFences.get(
        this.cancellationKey(input.companyId, input.sessionId, subjectHash),
      );
      if (!fence) return false;
      if (fence.expiresAt <= now) {
        this.cancellationFences.delete(
          this.cancellationKey(input.companyId, input.sessionId, subjectHash),
        );
        return false;
      }
      return true;
    });
    if (hasLiveCancellationFence) return { ok: true, identity: null };
    const matches = input.subjectHashCandidates
      .map((subjectHash) => this.leases.get(this.key(input.companyId, subjectHash)))
      .filter((lease): lease is MemoryLease => (
        lease?.sessionId === input.sessionId
        && lease.state === 'active'
        && lease.providerId !== null
        && lease.providerCallId !== null
        && lease.leaseExpiresAt > now
        && lease.hardExpiresAt > now
      ));
    if (matches.length > 1) return { ok: false, reason: 'unavailable' };
    const lease = matches[0];
    return {
      ok: true,
      identity: lease
        ? {
            companyId: lease.companyId,
            subjectHash: lease.subjectHash,
            sessionId: lease.sessionId,
          }
        : null,
    };
  }

  async claimTermination(
    input: RealtimeAdmissionSessionLookupInput,
  ): Promise<RealtimeTerminationClaimResult> {
    if (!validSessionLookup(input)) {
      return { ok: false, reason: 'unavailable' };
    }
    const matches = input.subjectHashCandidates
      .map((subjectHash) => ({
        key: this.key(input.companyId, subjectHash),
        lease: this.leases.get(this.key(input.companyId, subjectHash)),
      }))
      .filter((candidate): candidate is { key: string; lease: MemoryLease } => (
        candidate.lease?.sessionId === input.sessionId
      ));
    const now = this.now();
    const canonicalCancelledAt = input.subjectHashCandidates.reduce(
      (earliest, subjectHash) => {
        const existing = this.cancellationFences.get(
          this.cancellationKey(input.companyId, input.sessionId, subjectHash),
        );
        return existing && existing.cancelledAt < earliest
          ? existing.cancelledAt
          : earliest;
      },
      now,
    );
    for (const subjectHash of input.subjectHashCandidates) {
      const fenceKey = this.cancellationKey(input.companyId, input.sessionId, subjectHash);
      if (!this.cancellationFences.has(fenceKey)) {
        this.cancellationFences.set(fenceKey, {
          companyId: input.companyId,
          subjectHash,
          sessionId: input.sessionId,
          cancelledAt: canonicalCancelledAt,
          expiresAt: canonicalCancelledAt + 7_200_000,
        });
      }
    }
    if (matches.length > 1) return { ok: false, reason: 'unavailable' };
    const matched = matches[0];
    if (!matched) {
      return { ok: true, claim: null, pending: false };
    }
    const { key, lease } = matched;
    if (lease.providerId === null && lease.providerCallId === null) {
      this.leases.delete(key);
      return { ok: true, claim: null, pending: false };
    }
    if (lease.providerId === null || lease.providerCallId === null) {
      return { ok: false, reason: 'unavailable' };
    }
    const claim = this.claimLeaseForReaping(lease, now);
    return { ok: true, claim, pending: claim === null };
  }

  async completeReaping(
    input: Omit<
    RealtimeReapingClaim,
      'providerId' | 'providerCallId' | 'reaperLeaseExpiresAt' | 'hardExpiryProof'
    >,
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
    if (lease.providerId === null || lease.providerCallId === null) return null;
    if (lease.state === 'reaping' && lease.leaseExpiresAt > now) {
      return null;
    }
    const reaperToken = this.entropy.token();
    lease.state = 'reaping';
    lease.reaperTokenHash = hashRealtimeLeaseToken(reaperToken);
    lease.leaseExpiresAt = addSeconds(now, this.policy.reaperLeaseSeconds);
    lease.version += 1;
    const hardExpiryProof: RealtimeDatabaseHardExpiryProof | null = now >= lease.hardExpiresAt
      ? {
          source: 'database_hard_expiry',
          companyId: lease.companyId,
          subjectHash: lease.subjectHash,
          sessionId: lease.sessionId,
          providerId: lease.providerId,
          providerCallId: lease.providerCallId,
          hardExpiresAt: iso(lease.hardExpiresAt),
          databaseObservedAt: iso(now),
          leaseVersion: lease.version,
        }
      : null;
    return {
      companyId: lease.companyId,
      subjectHash: lease.subjectHash,
      sessionId: lease.sessionId,
      providerId: lease.providerId,
      providerCallId: lease.providerCallId,
      reaperToken,
      reaperLeaseExpiresAt: iso(lease.leaseExpiresAt),
      hardExpiryProof,
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

  private cancellationKey(companyId: string, sessionId: string, subjectHash: string): string {
    return `${companyId}\u0000${sessionId}\u0000${subjectHash}`;
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
      globalCapacity: {
        providerId: 'openai',
        providerModel: 'gpt-realtime-2.1',
        globalMaxSessions: 1_000,
        providerMaxSessions: 1_000,
        configVersion: 1,
      },
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
      agentMissionProof: null,
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
