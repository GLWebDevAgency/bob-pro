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
      claim: null,
      pending: false,
    }),
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

describe('RealtimeCallLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('active le CAS avant le premier heartbeat puis respecte l’ordre hangup -> release', async () => {
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
      release: vi.fn(async () => {
        order.push('release');
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
    expect(order).toEqual(['activate', 'renew', 'hangup', 'release']);
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
    expect(provider.hangupCall).toHaveBeenCalledOnce();
    expect(admission.release).toHaveBeenCalledWith({
      ...LEASE,
      providerTermination: 'confirmed',
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

    expect(admission.release).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'bob.live.lifecycle.termination_pending reason=kill_switch class=hangup_failed',
      'BobLive',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret network failure');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesce les fermetures concurrentes et ne raccroche/libère qu’une fois', async () => {
    const hangup = deferred<void>();
    const hangupCall = vi.fn(() => hangup.promise);
    const admission = admissionStub();
    const subject = lifecycle({ admission, provider: providerStub(hangupCall) });
    await subject.activate();

    const first = subject.terminate('user');
    const second = subject.terminate('shutdown');
    await Promise.resolve();
    expect(hangupCall).toHaveBeenCalledOnce();

    hangup.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['confirmed', 'confirmed']);
    expect(admission.release).toHaveBeenCalledOnce();
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
    expect(admission.release).toHaveBeenCalledOnce();
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
      expect(admission.release).toHaveBeenCalledOnce();
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
    expect(admission.release).toHaveBeenCalledOnce();
    expect(admission.renew).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
