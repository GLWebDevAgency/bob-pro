import { describe, expect, it } from 'vitest';
import {
  InMemoryRealtimeAdmission,
  realtimeAdmissionLegacyTestBinding,
} from './realtime-admission.testing';
import {
  hashRealtimeLeaseToken,
  validateRealtimeAdmissionPolicy,
  type RealtimeAdmissionEntropy,
  type RealtimeAdmissionPolicy,
  type RealtimeAdmissionResult,
} from './realtime-admission';

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const SUBJECT_A = 'a'.repeat(64);
const SUBJECT_B = 'b'.repeat(64);

const policy: RealtimeAdmissionPolicy = {
  globalCapacity: {
    providerId: 'openai', providerModel: 'gpt-realtime-2.1',
    globalMaxSessions: 1_000, providerMaxSessions: 1_000, configVersion: 1,
  },
  userLimitPerMinute: 2,
  userLimitPerHour: 3,
  tenantLimitPerMinute: 4,
  tenantLimitPerHour: 6,
  reservationTtlSeconds: 15,
  activeLeaseSeconds: 30,
  heartbeatSeconds: 10,
  reaperLeaseSeconds: 30,
};

function entropy(): RealtimeAdmissionEntropy {
  let sequence = 0;
  return {
    sessionId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    token: () => `token-${String(++sequence).padStart(64, '0')}`,
  };
}

function allowed(result: RealtimeAdmissionResult) {
  if (!result.allowed) throw new Error(`Expected admission, got ${result.denial}`);
  return result.lease;
}

function screenContext(label = 'Facture FA-2026-042') {
  return {
    screen: { name: 'Détail facture', instanceId: 'invoice:inv-42' },
    entities: [{ type: 'invoice', id: 'inv-42', label }],
    capabilities: ['screen.read', 'invoice.read'],
  };
}

describe('Bob Live — admission durable de parité mémoire', () => {
  it('agrège lease, replay et quota entre les bindings sujet courant et historiques', async () => {
    const principalBindingHash = 'd'.repeat(64);
    const current = '1'.repeat(64);
    const historical = '2'.repeat(64);
    const sessionId = '00000000-0000-4000-8000-000000000099';
    const oncePerMinute = new InMemoryRealtimeAdmission({
      ...policy,
      userLimitPerMinute: 1,
    }, Date.now, entropy());
    const first = await oncePerMinute.reserve({
      companyId: COMPANY_A,
      subjectHash: current,
      subjectHashCandidates: [current, historical],
      principalBindingHash,
      agentMissionBinding: null,
      sessionId,
      maxSessionSeconds: 60,
    });
    const lease = allowed(first);

    await expect(oncePerMinute.reserve({
      companyId: COMPANY_A,
      subjectHash: historical,
      subjectHashCandidates: [historical, current],
      principalBindingHash,
      agentMissionBinding: null,
      maxSessionSeconds: 60,
    })).resolves.toMatchObject({
      allowed: false,
      denial: 'active_lease',
    });

    await oncePerMinute.release({
      ...lease,
      providerTermination: 'not_created',
    });
    await expect(oncePerMinute.reserve({
      companyId: COMPANY_A,
      subjectHash: historical,
      subjectHashCandidates: [historical, current],
      principalBindingHash,
      agentMissionBinding: null,
      maxSessionSeconds: 60,
    })).resolves.toMatchObject({
      allowed: false,
      denial: 'user_minute',
    });
    await expect(oncePerMinute.reserve({
      companyId: COMPANY_A,
      subjectHash: historical,
      subjectHashCandidates: [historical, current],
      principalBindingHash,
      agentMissionBinding: null,
      sessionId,
      maxSessionSeconds: 60,
    })).resolves.toMatchObject({
      allowed: false,
      denial: 'active_lease',
    });
  });

  it('refuse V1 dans le double mémoire qui ne peut pas revalider le flag SQL', async () => {
    const admission = new InMemoryRealtimeAdmission(policy, Date.now, entropy());
    const result = await admission.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      subjectHashCandidates: [SUBJECT_A],
      principalBindingHash: 'd'.repeat(64),
      agentMissionBinding: {
        protocolVersion: 1,
        capabilityHash: 'c'.repeat(64),
        releaseFlagKey: 'bob.agent_missions.quote.v1',
        releaseEnvironment: 'staging',
        releaseFlagVersion: 7,
        principalBindingHash: 'd'.repeat(64),
      },
      maxSessionSeconds: 60,
    });

    expect(result).toEqual({
      allowed: false,
      denial: 'unavailable',
      retryAt: null,
    });
    expect(admission.snapshot()).toEqual({ events: [], leases: [] });
  });

  it('valide les invariants de politique avant tout trafic', () => {
    expect(() => validateRealtimeAdmissionPolicy(policy)).not.toThrow();
    expect(() => validateRealtimeAdmissionPolicy({ ...policy, userLimitPerHour: 1 })).toThrow(/hourly quota/i);
    expect(() => validateRealtimeAdmissionPolicy({ ...policy, tenantLimitPerMinute: 1 })).toThrow(/tenant minute/i);
    expect(() => validateRealtimeAdmissionPolicy({ ...policy, heartbeatSeconds: 30 })).toThrow(/heartbeat/i);
  });

  it('refuse sans autorité globale et borne N+1 entre tenants', async () => {
    const disabled = new InMemoryRealtimeAdmission({ ...policy, globalCapacity: null });
    await expect(disabled.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      maxSessionSeconds: 900,
      ...realtimeAdmissionLegacyTestBinding(SUBJECT_A),
    })).resolves.toMatchObject({ allowed: false, denial: 'unavailable' });

    const boundedPolicy: RealtimeAdmissionPolicy = {
      ...policy,
      globalCapacity: {
        providerId: 'openai',
        providerModel: 'gpt-realtime-2.1',
        globalMaxSessions: 2,
        providerMaxSessions: 3,
        configVersion: 7,
      },
    };
    const bounded = new InMemoryRealtimeAdmission(boundedPolicy, Date.now, entropy());
    const first = allowed(await bounded.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      maxSessionSeconds: 900,
      ...realtimeAdmissionLegacyTestBinding(SUBJECT_A),
    }));
    allowed(await bounded.reserve({
      companyId: COMPANY_B,
      subjectHash: SUBJECT_B,
      maxSessionSeconds: 900,
      ...realtimeAdmissionLegacyTestBinding(SUBJECT_B),
    }));
    await expect(bounded.reserve({
      companyId: 'company-c',
      subjectHash: 'c'.repeat(64),
      maxSessionSeconds: 900,
      ...realtimeAdmissionLegacyTestBinding('c'.repeat(64)),
    })).resolves.toMatchObject({ allowed: false, denial: 'global_capacity' });

    await bounded.release({ ...first, providerTermination: 'not_created' });
    await expect(bounded.reserve({
      companyId: 'company-c',
      subjectHash: 'c'.repeat(64),
      maxSessionSeconds: 900,
      ...realtimeAdmissionLegacyTestBinding('c'.repeat(64)),
    })).resolves.toMatchObject({ allowed: true, denial: null });
  });

  it('réserve un bail unique sans conserver userId ni token brut', async () => {
    let now = Date.parse('2026-07-13T12:00:00.000Z');
    const admission = new InMemoryRealtimeAdmission(policy, () => now, entropy());
    const first = await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 900, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) });
    const lease = allowed(first);
    expect(lease.leaseToken).toHaveLength(70);
    expect(hashRealtimeLeaseToken(lease.leaseToken)).toMatch(/^[a-f0-9]{64}$/);

    const duplicate = await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 900, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) });
    expect(duplicate).toMatchObject({ allowed: false, denial: 'active_lease' });
    const serialized = JSON.stringify(admission.snapshot());
    expect(serialized).not.toContain(lease.leaseToken);
    expect(serialized).not.toContain('userId');
    expect(serialized).not.toContain('user_id');

    now += 1;
    const otherTenant = await admission.reserve({ companyId: COMPANY_B, subjectHash: SUBJECT_A, maxSessionSeconds: 900, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) });
    expect(otherTenant.allowed).toBe(true);
  });

  it('applique les quotas glissants minute puis heure sans rembourser les réservations libérées', async () => {
    let now = Date.parse('2026-07-13T12:00:00.000Z');
    const admission = new InMemoryRealtimeAdmission(policy, () => now, entropy());
    const reserveAndAbort = async () => {
      const lease = allowed(await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 900, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) }));
      expect(await admission.release({ ...lease, providerTermination: 'not_created' })).toEqual({ ok: true, reason: null });
    };

    await reserveAndAbort();
    now += 1_000;
    await reserveAndAbort();
    const minuteDenied = await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 900, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) });
    expect(minuteDenied).toMatchObject({ allowed: false, denial: 'user_minute' });

    now += 61_000;
    await reserveAndAbort();
    const hourDenied = await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 900, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) });
    expect(hourDenied).toMatchObject({ allowed: false, denial: 'user_hour' });

    now += 3_600_000;
    expect((await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 900, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) })).allowed).toBe(true);
  });

  it('agrège les quotas tenant entre sujets distincts', async () => {
    let now = Date.parse('2026-07-13T12:00:00.000Z');
    const tenantPolicy = { ...policy, userLimitPerMinute: 4, userLimitPerHour: 10, tenantLimitPerMinute: 4, tenantLimitPerHour: 10 };
    const admission = new InMemoryRealtimeAdmission(tenantPolicy, () => now, entropy());
    const subjects = [SUBJECT_A, SUBJECT_B, 'c'.repeat(64), 'd'.repeat(64)];
    for (const subjectHash of subjects) {
      const lease = allowed(await admission.reserve({ companyId: COMPANY_A, subjectHash, maxSessionSeconds: 900, subjectHashCandidates: [subjectHash], principalBindingHash: subjectHash, agentMissionBinding: null }));
      await admission.release({ ...lease, providerTermination: 'not_created' });
      now += 1;
    }
    const denied = await admission.reserve({ companyId: COMPANY_A, subjectHash: 'e'.repeat(64), maxSessionSeconds: 900, ...realtimeAdmissionLegacyTestBinding('e'.repeat(64)) });
    expect(denied).toMatchObject({ allowed: false, denial: 'tenant_minute' });
  });

  it('fence bind/activate/renew/release par session et token hashé', async () => {
    let now = Date.parse('2026-07-13T12:00:00.000Z');
    const admission = new InMemoryRealtimeAdmission(policy, () => now, entropy());
    const lease = allowed(await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 60, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) }));
    const bad = { ...lease, leaseToken: `${lease.leaseToken}-forged` };
    expect(await admission.bindProvider({ ...bad, providerId: 'openai', providerCallId: 'call_123' })).toEqual({ ok: false, reason: 'rejected' });
    const bound = await admission.bindProvider({ ...lease, providerId: 'openai', providerCallId: 'call_123' });
    expect(bound.ok).toBe(true);
    expect(await admission.bindProvider({ ...lease, providerId: 'openai', providerCallId: 'call_123' })).toEqual(bound);
    expect(await admission.bindProvider({ ...lease, providerId: 'mistral', providerCallId: 'call_123' })).toEqual({ ok: false, reason: 'rejected' });
    expect(await admission.bindProvider({ ...lease, providerId: 'openai', providerCallId: 'call_other' })).toEqual({ ok: false, reason: 'rejected' });
    expect(await admission.release({ ...lease, providerTermination: 'not_created' })).toEqual({ ok: false, reason: 'rejected' });
    const activated = await admission.activate(lease);
    expect(activated.ok).toBe(true);
    expect(await admission.activate(lease)).toEqual(activated);
    const firstExpiry = Date.parse(activated.leaseExpiresAt!);
    now += 10_000;
    const renewed = await admission.renew(lease);
    expect(renewed.ok).toBe(true);
    expect(Date.parse(renewed.leaseExpiresAt!)).toBeGreaterThan(firstExpiry);
    expect(Date.parse(renewed.leaseExpiresAt!)).toBeLessThanOrEqual(Date.parse(lease.hardExpiresAt));
    expect(await admission.release({ ...lease, providerTermination: 'confirmed' })).toEqual({ ok: true, reason: null });
  });

  it('isole les identités de session par provider sans collision inter-provider', async () => {
    const admission = new InMemoryRealtimeAdmission(policy, Date.now, entropy());
    const openaiLease = allowed(await admission.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      maxSessionSeconds: 60,
      ...realtimeAdmissionLegacyTestBinding(SUBJECT_A),
    }));
    const mistralLease = allowed(await admission.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_B,
      maxSessionSeconds: 60,
      ...realtimeAdmissionLegacyTestBinding(SUBJECT_B),
    }));
    expect(await admission.bindProvider({
      ...openaiLease,
      providerId: 'openai',
      providerCallId: 'shared_remote_session',
    })).toMatchObject({ ok: true });
    expect(await admission.bindProvider({
      ...mistralLease,
      providerId: 'mistral',
      providerCallId: 'shared_remote_session',
    })).toMatchObject({ ok: true });

    const thirdLease = allowed(await admission.reserve({
      companyId: COMPANY_A,
      subjectHash: 'c'.repeat(64),
      maxSessionSeconds: 60,
      ...realtimeAdmissionLegacyTestBinding('c'.repeat(64)),
    }));
    expect(await admission.bindProvider({
      ...thirdLease,
      providerId: 'openai',
      providerCallId: 'shared_remote_session',
    })).toEqual({ ok: false, reason: 'rejected' });
    expect(await admission.bindProvider({
      ...thirdLease,
      providerId: 'invalid' as 'openai',
      providerCallId: 'another_remote_session',
    })).toEqual({ ok: false, reason: 'rejected' });
  });

  it('lie le contexte assaini au tenant, au sujet et à la session active', async () => {
    const admission = new InMemoryRealtimeAdmission(policy, Date.now, entropy());
    const lease = allowed(await admission.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      maxSessionSeconds: 60,
      ...realtimeAdmissionLegacyTestBinding(SUBJECT_A),
    }));
    const context = screenContext('Facture <ignore> `FA-2026-042`');

    expect(await admission.updateContext({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      sessionId: lease.sessionId,
      version: 1,
      revision: 1,
      context,
    })).toEqual({ ok: false, reason: 'rejected' });
    await admission.bindProvider({ ...lease, providerId: 'openai', providerCallId: 'call_context' });
    expect(await admission.updateContext({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      sessionId: lease.sessionId,
      version: 1,
      revision: 1,
      context,
    })).toEqual({ ok: true, status: 'updated', revision: 1 });
    expect(await admission.readContext({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      sessionId: lease.sessionId,
    })).toEqual({ ok: false, reason: 'rejected' });

    await admission.activate(lease);
    const read = await admission.readContext({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      sessionId: lease.sessionId,
    });
    expect(read).toEqual({
      ok: true,
      snapshot: {
        version: 1,
        revision: 1,
        context: {
          ...context,
          entities: [{ type: 'invoice', id: 'inv-42', label: 'Facture ignore FA-2026-042' }],
        },
      },
    });
    expect(await admission.readContext({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_B,
      sessionId: lease.sessionId,
    })).toEqual({ ok: false, reason: 'rejected' });
    expect(await admission.readContext({
      companyId: COMPANY_B,
      subjectHash: SUBJECT_A,
      sessionId: lease.sessionId,
    })).toEqual({ ok: false, reason: 'rejected' });
  });

  it('fence les révisions de contexte et rend les retries identiques idempotents', async () => {
    const admission = new InMemoryRealtimeAdmission(policy, Date.now, entropy());
    const lease = allowed(await admission.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      maxSessionSeconds: 60,
      ...realtimeAdmissionLegacyTestBinding(SUBJECT_A),
    }));
    await admission.bindProvider({ ...lease, providerId: 'openai', providerCallId: 'call_context_revision' });
    await admission.activate(lease);
    const identity = {
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      sessionId: lease.sessionId,
    };

    expect(await admission.updateContext({
      ...identity,
      version: 1,
      revision: 3,
      context: screenContext(),
    })).toEqual({ ok: true, status: 'updated', revision: 3 });
    expect(await admission.updateContext({
      ...identity,
      version: 1,
      revision: 3,
      context: screenContext(),
    })).toEqual({ ok: true, status: 'idempotent', revision: 3 });
    expect(await admission.updateContext({
      ...identity,
      version: 1,
      revision: 2,
      context: screenContext(),
    })).toEqual({ ok: false, reason: 'stale' });
    expect(await admission.updateContext({
      ...identity,
      version: 1,
      revision: 3,
      context: screenContext('Une autre facture'),
    })).toEqual({ ok: false, reason: 'conflict' });
    expect(await admission.updateContext({
      ...identity,
      version: 1,
      revision: 5,
      context: screenContext('Une autre facture'),
    })).toEqual({ ok: true, status: 'updated', revision: 5 });
    expect(await admission.updateContext({
      ...identity,
      version: 2,
      revision: 6,
      context: screenContext(),
    })).toEqual({ ok: false, reason: 'rejected' });
    expect(await admission.updateContext({
      ...identity,
      version: 1,
      revision: 2_147_483_648,
      context: screenContext(),
    })).toEqual({ ok: false, reason: 'rejected' });
    expect(await admission.updateContext({
      ...identity,
      version: 1,
      revision: 6,
      context: { ...screenContext(), capabilities: ['admin.everything'] },
    })).toEqual({ ok: false, reason: 'rejected' });
  });

  it('refuse de lire ou muter un contexte après expiration du bail', async () => {
    let now = Date.parse('2026-07-13T12:00:00.000Z');
    const admission = new InMemoryRealtimeAdmission(policy, () => now, entropy());
    const lease = allowed(await admission.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      maxSessionSeconds: 60,
      ...realtimeAdmissionLegacyTestBinding(SUBJECT_A),
    }));
    await admission.bindProvider({ ...lease, providerId: 'openai', providerCallId: 'call_context_expired' });
    await admission.activate(lease);
    const identity = {
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      sessionId: lease.sessionId,
    };
    await admission.updateContext({ ...identity, version: 1, revision: 1, context: screenContext() });
    now += 31_000;
    expect(await admission.readContext(identity)).toEqual({ ok: false, reason: 'expired' });
    expect(await admission.updateContext({
      ...identity,
      version: 1,
      revision: 2,
      context: screenContext(),
    })).toEqual({ ok: false, reason: 'expired' });
  });

  it('utilise le session handle mobile comme fence opaque et refuse ses replays', async () => {
    const admission = new InMemoryRealtimeAdmission(policy, Date.now, entropy());
    const sessionId = '00000000-0000-4000-8000-123456789012';
    const [first, concurrent] = await Promise.all([
      admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, sessionId, maxSessionSeconds: 60, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) }),
      admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, sessionId, maxSessionSeconds: 60, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) }),
    ]);
    expect(first.allowed).toBe(true);
    expect(concurrent).toMatchObject({ allowed: false, denial: 'active_lease' });
    if (!first.allowed) throw new Error('Expected mobile handle reservation.');
    expect(first.lease.sessionId).toBe(sessionId);
    await admission.release({ ...first.lease, providerTermination: 'not_created' });
    expect(await admission.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      sessionId,
      maxSessionSeconds: 60,
      ...realtimeAdmissionLegacyTestBinding(SUBJECT_A),
    })).toEqual({ allowed: false, denial: 'active_lease', retryAt: null });
    expect(await admission.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_B,
      sessionId,
      maxSessionSeconds: 60,
      ...realtimeAdmissionLegacyTestBinding(SUBJECT_B),
    })).toEqual({ allowed: false, denial: 'unavailable', retryAt: null });
    expect(await admission.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      sessionId: 'not-a-uuid',
      maxSessionSeconds: 60,
      ...realtimeAdmissionLegacyTestBinding(SUBJECT_A),
    })).toEqual({ allowed: false, denial: 'unavailable', retryAt: null });
    expect(admission.snapshot().events).toHaveLength(1);
  });

  it('conserve un appel provider expiré sous reaping jusqu’au hangup confirmé', async () => {
    let now = Date.parse('2026-07-13T12:00:00.000Z');
    const admission = new InMemoryRealtimeAdmission(policy, () => now, entropy());
    const lease = allowed(await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 60, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) }));
    await admission.bindProvider({ ...lease, providerId: 'mistral', providerCallId: 'call_stale' });
    now += 16_000;

    const blocked = await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 60, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) });
    expect(blocked).toMatchObject({ allowed: false, denial: 'session_reaping' });
    if (blocked.allowed || !blocked.reapingClaim) throw new Error('Expected fenced reaping claim.');
    expect(blocked.reapingClaim.providerId).toBe('mistral');
    expect(blocked.reapingClaim.providerCallId).toBe('call_stale');
    expect(blocked.reapingClaim.hardExpiryProof).toBeNull();

    const stillBlocked = await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 60, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) });
    expect(stillBlocked).toMatchObject({ allowed: false, denial: 'session_reaping' });
    expect(stillBlocked.allowed || stillBlocked.reapingClaim).toBeUndefined();
    expect(await admission.completeReaping({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      sessionId: lease.sessionId,
      reaperToken: `${blocked.reapingClaim.reaperToken}-forged`,
    })).toEqual({ ok: false, reason: 'rejected' });
    expect(await admission.completeReaping({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      sessionId: lease.sessionId,
      reaperToken: blocked.reapingClaim.reaperToken,
    })).toEqual({ ok: true, reason: null });
  });

  it('récolte un bail sans provider directement et ne prolonge jamais au-delà du hard cap', async () => {
    let now = Date.parse('2026-07-13T12:00:00.000Z');
    const admission = new InMemoryRealtimeAdmission(policy, () => now, entropy());
    const orphan = allowed(await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 60, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) }));
    now += 16_000;
    expect(await admission.claimExpired({ companyId: COMPANY_A })).toEqual({ ok: true, claims: [] });
    expect(admission.snapshot().leases).toHaveLength(0);

    const active = allowed(await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_B, maxSessionSeconds: 60, ...realtimeAdmissionLegacyTestBinding(SUBJECT_B) }));
    await admission.bindProvider({ ...active, providerId: 'openai', providerCallId: 'call_hard_cap' });
    await admission.activate(active);
    now = Date.parse(active.hardExpiresAt);
    expect(await admission.renew(active)).toEqual({ ok: false, reason: 'expired' });
    const reaping = await admission.claimExpired({ companyId: COMPANY_A });
    expect(reaping.ok).toBe(true);
    if (!reaping.ok) throw new Error('Expected reaping batch.');
    expect(reaping.claims).toHaveLength(1);
    expect(reaping.claims[0]?.providerId).toBe('openai');
    expect(reaping.claims[0]?.providerCallId).toBe('call_hard_cap');
    expect(reaping.claims[0]?.hardExpiryProof).toEqual(expect.objectContaining({
      source: 'database_hard_expiry',
      companyId: COMPANY_A,
      subjectHash: SUBJECT_B,
      sessionId: active.sessionId,
      providerId: 'openai',
      providerCallId: 'call_hard_cap',
      hardExpiresAt: active.hardExpiresAt,
    }));
    expect(Date.parse(reaping.claims[0]!.hardExpiryProof!.databaseObservedAt))
      .toBeGreaterThanOrEqual(Date.parse(active.hardExpiresAt));
    expect(orphan.leaseToken).not.toBe(active.leaseToken);
  });

  it('réclame une terminaison explicite inter-répliques avec un fence sessionId', async () => {
    const admission = new InMemoryRealtimeAdmission(policy, Date.now, entropy());
    const lease = allowed(await admission.reserve({ companyId: COMPANY_A, subjectHash: SUBJECT_A, maxSessionSeconds: 60, ...realtimeAdmissionLegacyTestBinding(SUBJECT_A) }));
    await admission.bindProvider({ ...lease, providerId: 'mistral', providerCallId: 'call_cross_replica' });
    await admission.activate(lease);
    const rotatedSubjectHash = 'd'.repeat(64);

    expect(await admission.claimTermination({
      companyId: COMPANY_A,
      subjectHashCandidates: [rotatedSubjectHash, SUBJECT_A],
      principalBindingHash: 'e'.repeat(64),
      sessionId: '00000000-0000-4000-8000-999999999999',
    })).toEqual({ ok: true, claim: null, pending: false });
    expect(await admission.resolveSession({
      companyId: COMPANY_A,
      subjectHashCandidates: [rotatedSubjectHash, SUBJECT_A],
      principalBindingHash: 'e'.repeat(64),
      sessionId: lease.sessionId,
    })).toEqual({
      ok: true,
      identity: {
        companyId: COMPANY_A,
        subjectHash: SUBJECT_A,
        sessionId: lease.sessionId,
      },
    });
    const claimed = await admission.claimTermination({
      companyId: COMPANY_A,
      subjectHashCandidates: [rotatedSubjectHash, SUBJECT_A],
      principalBindingHash: 'e'.repeat(64),
      sessionId: lease.sessionId,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || !claimed.claim) throw new Error('Expected explicit termination claim.');
    expect(claimed.claim.providerId).toBe('mistral');
    expect(claimed.claim.providerCallId).toBe('call_cross_replica');
    expect(claimed.claim.hardExpiryProof).toBeNull();
    expect(await admission.resolveSession({
      companyId: COMPANY_A,
      subjectHashCandidates: [rotatedSubjectHash, SUBJECT_A],
      principalBindingHash: 'e'.repeat(64),
      sessionId: lease.sessionId,
    })).toEqual({ ok: true, identity: null });
    expect(await admission.claimTermination({
      companyId: COMPANY_A,
      subjectHashCandidates: [rotatedSubjectHash, SUBJECT_A],
      principalBindingHash: 'e'.repeat(64),
      sessionId: lease.sessionId,
    })).toEqual({ ok: true, claim: null, pending: true });
    expect(await admission.completeReaping({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      sessionId: lease.sessionId,
      reaperToken: claimed.claim.reaperToken,
    })).toEqual({ ok: true, reason: null });
  });

  it('bloque un reserve postérieur au hangup sans prolonger le fence lors du replay', async () => {
    let now = Date.parse('2026-07-26T12:00:00.000Z');
    const admission = new InMemoryRealtimeAdmission(policy, () => now, entropy());
    const sessionId = '00000000-0000-4000-8000-777777777777';
    const lookup = {
      companyId: COMPANY_A,
      subjectHashCandidates: [SUBJECT_A, 'd'.repeat(64)],
      principalBindingHash: 'e'.repeat(64),
      sessionId,
    } as const;

    await expect(admission.claimTermination(lookup)).resolves.toEqual({
      ok: true,
      claim: null,
      pending: false,
    });
    await expect(admission.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      subjectHashCandidates: lookup.subjectHashCandidates,
      principalBindingHash: lookup.principalBindingHash,
      agentMissionBinding: null,
      sessionId,
      maxSessionSeconds: 60,
    })).resolves.toEqual({
      allowed: false,
      denial: 'active_lease',
      retryAt: null,
    });

    now += 3_600_000;
    const rotatedLookup = {
      ...lookup,
      subjectHashCandidates: [...lookup.subjectHashCandidates, 'f'.repeat(64)],
    } as const;
    await admission.claimTermination(rotatedLookup);
    now += 3_600_001;
    const afterOriginalExpiry = await admission.reserve({
      companyId: COMPANY_A,
      subjectHash: SUBJECT_A,
      subjectHashCandidates: rotatedLookup.subjectHashCandidates,
      principalBindingHash: lookup.principalBindingHash,
      agentMissionBinding: null,
      sessionId,
      maxSessionSeconds: 60,
    });
    expect(afterOriginalExpiry.allowed).toBe(true);
  });

  it('refuse explicitement l’ancien contrat contenant le userId brut', () => {
    const admission = new InMemoryRealtimeAdmission(policy);
    expect(admission.acquire({ userId: 'raw-user-id', companyId: COMPANY_A })).toEqual({
      allowed: false,
      denial: 'unavailable',
      retryAt: null,
    });
  });
});
