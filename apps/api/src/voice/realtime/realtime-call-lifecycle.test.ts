import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RealtimeAdmissionMutationResult,
  RealtimeAdmissionPort,
  RealtimeLeaseCredential,
} from './realtime-admission';
import { RealtimeCallLifecycle } from './realtime-call-lifecycle';
import type { OpenAiRealtimeCallProvider } from './realtime.types';

const NOW = Date.parse('2026-07-13T12:00:00.000Z');
const LEASE: RealtimeLeaseCredential = {
  companyId: 'company-1',
  subjectHash: 'a'.repeat(64),
  sessionId: '00000000-0000-4000-8000-000000000001',
  leaseToken: 'lease-token-with-more-than-thirty-two-characters',
};
const TERMINATION_LOOKUP = {
  companyId: LEASE.companyId,
  subjectHashCandidates: [LEASE.subjectHash],
  principalBindingHash: 'b'.repeat(64),
  sessionId: LEASE.sessionId,
} as const;
const TERMINATION_CLAIM = {
  companyId: LEASE.companyId,
  subjectHash: LEASE.subjectHash,
  sessionId: LEASE.sessionId,
  providerId: 'openai' as const,
  providerCallId: 'rtc_lifecycle_1',
  reaperToken: 'reaper-token-with-more-than-thirty-two-characters',
  reaperLeaseExpiresAt: new Date(NOW + 30_000).toISOString(),
  hardExpiryProof: null,
};

function okMutation(): RealtimeAdmissionMutationResult {
  return { ok: true, reason: null };
}

function admissionStub(overrides: Partial<RealtimeAdmissionPort> = {}): RealtimeAdmissionPort {
  return {
    reserve: vi.fn<RealtimeAdmissionPort['reserve']>().mockResolvedValue({
      allowed: false,
      denial: 'unavailable',
      retryAt: null,
    }),
    bindProvider: vi.fn<RealtimeAdmissionPort['bindProvider']>().mockResolvedValue(okMutation()),
    activate: vi.fn<RealtimeAdmissionPort['activate']>().mockResolvedValue(okMutation()),
    renew: vi.fn<RealtimeAdmissionPort['renew']>().mockResolvedValue(okMutation()),
    release: vi.fn<RealtimeAdmissionPort['release']>().mockResolvedValue(okMutation()),
    claimExpired: vi.fn<RealtimeAdmissionPort['claimExpired']>().mockResolvedValue({ ok: true, claims: [] }),
    claimTermination: vi.fn<RealtimeAdmissionPort['claimTermination']>().mockResolvedValue({
      ok: true,
      claim: TERMINATION_CLAIM,
      pending: false,
    }),
    resolveSession: vi.fn<RealtimeAdmissionPort['resolveSession']>().mockResolvedValue({
      ok: true,
      identity: null,
    }),
    acknowledgeAgentMissionBootstrap: vi
      .fn<RealtimeAdmissionPort['acknowledgeAgentMissionBootstrap']>()
      .mockResolvedValue({ ok: false, reason: 'unavailable' }),
    completeReaping: vi.fn<RealtimeAdmissionPort['completeReaping']>().mockResolvedValue(okMutation()),
    updateContext: vi.fn<RealtimeAdmissionPort['updateContext']>().mockResolvedValue({
      ok: false,
      reason: 'rejected',
    }),
    readContext: vi.fn<RealtimeAdmissionPort['readContext']>().mockResolvedValue({
      ok: true,
      snapshot: null,
    }),
    acquire: vi.fn<RealtimeAdmissionPort['acquire']>().mockReturnValue({
      allowed: false,
      denial: 'unavailable',
      retryAt: null,
    }),
    ...overrides,
  };
}

function providerStub(hangupCall = vi.fn(async () => undefined)): OpenAiRealtimeCallProvider {
  return { createCall: vi.fn(), hangupCall };
}

function lifecycle(input: {
  admission?: RealtimeAdmissionPort;
  provider?: OpenAiRealtimeCallProvider;
  hardExpiresAt?: string;
  heartbeatSeconds?: number;
  logger?: { warn: ReturnType<typeof vi.fn>; audit: ReturnType<typeof vi.fn> };
} = {}) {
  return new RealtimeCallLifecycle({
    admission: input.admission ?? admissionStub(),
    provider: input.provider ?? providerStub(),
    lease: LEASE,
    terminationLookup: TERMINATION_LOOKUP,
    providerId: 'openai',
    providerCallId: 'rtc_lifecycle_1',
    hardExpiresAt: input.hardExpiresAt ?? new Date(NOW + 60_000).toISOString(),
    heartbeatSeconds: input.heartbeatSeconds ?? 10,
    ...(input.logger ? { logger: input.logger } : {}),
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition_not_reached');
}

describe('RealtimeCallLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('active le CAS puis respecte strictement claim DB -> hangup -> complete', async () => {
    const order: string[] = [];
    const admission = admissionStub({
      activate: vi.fn(async () => {
        order.push('activate');
        return okMutation();
      }),
      renew: vi.fn(async () => {
        order.push('renew');
        return okMutation();
      }),
      claimTermination: vi.fn(async () => {
        order.push('claim');
        return { ok: true as const, claim: TERMINATION_CLAIM, pending: false };
      }),
      completeReaping: vi.fn(async () => {
        order.push('complete');
        return okMutation();
      }),
    });
    const provider = providerStub(vi.fn(async () => {
      order.push('hangup');
    }));
    const subject = lifecycle({ admission, provider });

    await subject.activate();
    expect(order).toEqual(['activate']);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(order).toEqual(['activate', 'renew']);

    await expect(subject.terminate('user')).resolves.toBe('confirmed');
    expect(order).toEqual(['activate', 'renew', 'claim', 'hangup', 'complete']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ne chevauche jamais deux heartbeats même si le stockage est lent', async () => {
    const firstRenew = deferred<RealtimeAdmissionMutationResult>();
    const renew = vi
      .fn<RealtimeAdmissionPort['renew']>()
      .mockImplementationOnce(() => firstRenew.promise)
      .mockResolvedValue(okMutation());
    const admission = admissionStub({ renew });
    const subject = lifecycle({ admission });
    await subject.activate();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(renew).toHaveBeenCalledOnce();

    firstRenew.resolve(okMutation());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(2);

    await subject.terminate('shutdown');
  });

  it('termine correctement un appel lié avant son activation', async () => {
    const admission = admissionStub();
    const provider = providerStub();
    const subject = lifecycle({ admission, provider });

    await expect(subject.terminate('bootstrap_failed')).resolves.toBe('confirmed');

    expect(admission.activate).not.toHaveBeenCalled();
    expect(admission.claimTermination).toHaveBeenCalledWith(TERMINATION_LOOKUP);
    expect(provider.hangupCall).toHaveBeenCalledOnce();
    expect(admission.completeReaping).toHaveBeenCalledWith({
      companyId: LEASE.companyId,
      subjectHash: LEASE.subjectHash,
      sessionId: LEASE.sessionId,
      reaperToken: TERMINATION_CLAIM.reaperToken,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('conserve le bail pour le reaper lorsque le hangup provider est incertain', async () => {
    const admission = admissionStub();
    const provider = providerStub(vi.fn(async () => {
      throw new Error('secret network failure');
    }));
    const logger = { warn: vi.fn(), audit: vi.fn() };
    const subject = lifecycle({ admission, provider, logger });
    await subject.activate();

    await expect(subject.terminate('kill_switch')).resolves.toBe('pending_reaper');

    expect(admission.completeReaping).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'bob.live.lifecycle.termination_pending reason=kill_switch class=hangup_failed',
      'BobLive',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret network failure');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('n appelle jamais le provider sans claim durable possédé', async () => {
    const admission = admissionStub({
      claimTermination: vi.fn<RealtimeAdmissionPort['claimTermination']>().mockResolvedValue({
        ok: false,
        reason: 'unavailable',
      }),
    });
    const provider = providerStub();
    const logger = { warn: vi.fn(), audit: vi.fn() };
    const subject = lifecycle({ admission, provider, logger });

    await expect(subject.terminate('shutdown')).resolves.toBe('pending_reaper');

    expect(provider.hangupCall).not.toHaveBeenCalled();
    expect(admission.completeReaping).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'bob.live.lifecycle.termination_pending reason=shutdown class=claim_unavailable',
      'BobLive',
    );
  });

  it('refuse un claim discordant sans raccrocher une identité provider étrangère', async () => {
    const admission = admissionStub({
      claimTermination: vi.fn(async () => ({
        ok: true as const,
        claim: { ...TERMINATION_CLAIM, providerCallId: 'rtc_foreign' },
        pending: false,
      })),
    });
    const provider = providerStub();
    const subject = lifecycle({ admission, provider });

    await expect(subject.terminate('user')).resolves.toBe('pending_reaper');

    expect(provider.hangupCall).not.toHaveBeenCalled();
    expect(admission.completeReaping).not.toHaveBeenCalled();
  });

  it('laisse le claim reaping récupérable si sa complétion CAS échoue', async () => {
    const admission = admissionStub({
      completeReaping: vi.fn<RealtimeAdmissionPort['completeReaping']>().mockResolvedValue({
        ok: false,
        reason: 'unavailable',
      }),
    });
    const provider = providerStub();
    const subject = lifecycle({ admission, provider });

    await expect(subject.terminate('max_duration')).resolves.toBe('pending_reaper');

    expect(provider.hangupCall).toHaveBeenCalledWith(TERMINATION_CLAIM.providerCallId);
    expect(admission.completeReaping).toHaveBeenCalledOnce();
  });

  it('coalesce les fermetures concurrentes et ne raccroche/libère qu’une fois', async () => {
    const hangup = deferred<void>();
    const hangupCall = vi.fn(() => hangup.promise);
    const admission = admissionStub();
    const subject = lifecycle({ admission, provider: providerStub(hangupCall) });
    await subject.activate();

    const first = subject.terminate('user');
    const second = subject.terminate('shutdown');
    await eventually(() => hangupCall.mock.calls.length === 1);
    expect(hangupCall).toHaveBeenCalledOnce();

    hangup.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['confirmed', 'confirmed']);
    expect(admission.claimTermination).toHaveBeenCalledOnce();
    expect(admission.completeReaping).toHaveBeenCalledOnce();
  });

  it('cède la terminaison à un claim durable externe sans effet provider ni complétion locale', async () => {
    const admission = admissionStub();
    const provider = providerStub();
    const subject = lifecycle({ admission, provider });
    await subject.activate();

    subject.fenceAfterDurableTerminationClaim();

    await expect(subject.terminate('user')).resolves.toBe('pending_reaper');
    expect(provider.hangupCall).not.toHaveBeenCalled();
    expect(admission.claimTermination).not.toHaveBeenCalled();
    expect(admission.completeReaping).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('raccroche au hard cap absolu et annule les heartbeats suivants', async () => {
    const admission = admissionStub();
    const provider = providerStub();
    const logger = { warn: vi.fn(), audit: vi.fn() };
    const subject = lifecycle({
      admission,
      provider,
      logger,
      hardExpiresAt: new Date(NOW + 25_000).toISOString(),
    });
    await subject.activate();

    await vi.advanceTimersByTimeAsync(25_000);

    expect(admission.renew).toHaveBeenCalledTimes(2);
    expect(provider.hangupCall).toHaveBeenCalledOnce();
    expect(admission.completeReaping).toHaveBeenCalledOnce();
    expect(logger.audit).toHaveBeenCalledWith('bob.live.lifecycle.terminated', {
      reason: 'hard_expiry',
      outcome: 'confirmed',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['rejected', 'expired', 'unavailable'] as const)(
    'termine en lease_lost lorsque renew retourne %s',
    async (reason) => {
      const admission = admissionStub({
        renew: vi.fn<RealtimeAdmissionPort['renew']>().mockResolvedValue({ ok: false, reason }),
      });
      const provider = providerStub();
      const logger = { warn: vi.fn(), audit: vi.fn() };
      const subject = lifecycle({ admission, provider, logger });
      await subject.activate();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(provider.hangupCall).toHaveBeenCalledOnce();
      expect(admission.completeReaping).toHaveBeenCalledOnce();
      expect(logger.audit).toHaveBeenCalledWith('bob.live.lifecycle.terminated', {
        reason: 'lease_lost',
        outcome: 'confirmed',
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('échoue fermé et termine le provider si le CAS d’activation est refusé', async () => {
    const admission = admissionStub({
      activate: vi.fn<RealtimeAdmissionPort['activate']>().mockResolvedValue({ ok: false, reason: 'expired' }),
    });
    const provider = providerStub();
    const subject = lifecycle({ admission, provider });

    await expect(subject.activate()).rejects.toThrow('realtime_lifecycle_activate_expired');
    expect(provider.hangupCall).toHaveBeenCalledOnce();
    expect(admission.completeReaping).toHaveBeenCalledOnce();
    expect(admission.renew).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
